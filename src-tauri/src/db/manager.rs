use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::clickhouse::ClickHouseConnection;
use super::dialect::DialectConfig;
use super::gauss_rs::GaussAsyncConnection;
use super::mysql::MySqlConnection;
use super::odbc_bridge::OdbcConnection;
use super::pg_compatible::PgCompatibleConnection;
use super::postgres::PostgresConnection;
use super::sqlserver::SqlServerConnection;
use super::sqlite::SQLiteConnection;
use super::trait_def::DatabaseConnection;
use super::sql_limiter;
use super::types::{
    ColumnInfo, ConnectResult, ConnectionConfig, ConnectionStatus, DatabaseType, DbError,
    ExecuteResult, PagedQueryResult, QueryResult, TableInfo,
};
use crate::plugins::driver::PluginDriver;
use crate::plugins::manager::PluginManager;

// ============================================================================
// Connection Manager
// ============================================================================

const MAX_RECONNECT_ATTEMPTS: u32 = 3;

/// Per-connection state tracking
struct ConnectionEntry {
    connection: Box<dyn DatabaseConnection>,
    config: ConnectionConfig,
    last_heartbeat: std::sync::Mutex<Instant>,
    is_healthy: bool,
    reconnect_count: u32,
    /// SSH tunnel (kept alive for the lifetime of the connection)
    ssh_tunnel: Option<crate::ssh::tunnel::SshTunnel>,
}

/// Manages multiple database connections
pub struct ConnectionManager {
    connections: RwLock<HashMap<String, ConnectionEntry>>,
    plugin_manager: tokio::sync::Mutex<Option<Arc<PluginManager>>>,
    /// Per-connection cancel senders. Dropping the sender cancels the active query.
    cancel_tokens: RwLock<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

impl ConnectionManager {
    /// Create a new connection manager
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            plugin_manager: tokio::sync::Mutex::new(None),
            cancel_tokens: RwLock::new(HashMap::new()),
        }
    }

    /// Cancel the currently-running query on the given connection.
    /// Works by removing and dropping the oneshot sender, which immediately
    /// resolves the receiver in the `tokio::select!` branch.
    pub async fn cancel_query(&self, id: &str) -> bool {
        self.cancel_tokens.write().await.remove(id).is_some()
    }

    /// Create a fresh cancel channel for a connection and return the receiver.
    /// The sender is stored; dropping it (via cancel_query) cancels the query.
    async fn cancel_token(&self, id: &str) -> tokio::sync::oneshot::Receiver<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.cancel_tokens.write().await.insert(id.to_string(), tx);
        rx
    }

    /// Inject the plugin manager (called during app setup)
    pub fn set_plugin_manager(&self, pm: Arc<PluginManager>) {
        *self.plugin_manager.try_lock().expect("plugin_manager lock uncontended during setup") = Some(pm);
    }

    async fn get_plugin_manager(&self) -> Option<Arc<PluginManager>> {
        self.plugin_manager.lock().await.clone()
    }

    /// Background loop that checks connection health without running SQL queries.
    /// Health is determined by whether recent user queries succeeded (last_heartbeat
    /// is touched on every successful query). This avoids any TCP-level contention
    /// with user queries on the same connection.
    pub async fn start_heartbeat(manager: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            // Collect (id, is_stale, db_type, idle_secs, host) so the warning
            // log line carries enough structured context for support to correlate
            // heartbeat misses with network / firewall events.
            let to_check: Vec<(String, bool, DatabaseType, u64, Option<String>)> = {
                let connections = manager.connections.read().await;
                connections
                    .iter()
                    .filter(|(_, e)| e.config.keepalive_interval != 0)
                    .map(|(id, e)| {
                        let idle_secs = e.last_heartbeat.lock().unwrap().elapsed().as_secs();
                        (
                            id.clone(),
                            idle_secs > 120,
                            e.config.db_type.clone(),
                            idle_secs,
                            e.config.host.clone(),
                        )
                    })
                    .collect()
            };

            for (id, is_stale, db_type, idle_secs, host) in &to_check {
                if *is_stale {
                    log::warn!(
                        "[heartbeat] id={} db_type={:?} host={} idle_secs={} threshold=120 marking_unhealthy=true",
                        id,
                        db_type,
                        host.as_deref().unwrap_or("?"),
                        idle_secs
                    );
                    let mut conns = manager.connections.write().await;
                    if let Some(e) = conns.get_mut(id) {
                        e.is_healthy = false;
                    }
                }
            }
        }
    }

    /// Create a new database connection asynchronously
    async fn create_connection_async(
        config: &ConnectionConfig,
        plugin_manager: Option<&PluginManager>,
    ) -> Result<Box<dyn DatabaseConnection>, DbError> {
        match &config.db_type {
            DatabaseType::Plugin(plugin_id) => {
                let pm = plugin_manager
                    .ok_or_else(|| DbError::ConfigError("Plugin manager not initialized".into()))?;
                let client = pm.get_plugin_client(plugin_id).await
                    .map_err(|e| DbError::ConfigError(format!("Failed to start plugin '{}': {}", plugin_id, e)))?;
                let config_json = serde_json::to_value(config)
                    .map_err(|e| DbError::ConfigError(e.to_string()))?;
                Ok(Box::new(PluginDriver::new(client, plugin_id.clone(), config_json).await))
            }
            DatabaseType::PostgreSQL => {
                Ok(Box::new(PostgresConnection::new(config).await?))
            }
            DatabaseType::GaussDB => {
                // Tier 1: tokio-gaussdb (Huawei official, binary protocol)
                match GaussAsyncConnection::new(config).await {
                    Ok(conn) => {
                        log::info!("GaussDB connected via tokio-gaussdb (binary protocol)");
                        return Ok(Box::new(conn));
                    }
                    Err(e) => log::warn!("tokio-gaussdb failed: {}, trying sqlx fallback...", e),
                }
                // Tier 2: sqlx PG driver
                if let Ok(conn) = PgCompatibleConnection::new(config, DialectConfig::gaussdb()).await {
                    log::info!("GaussDB connected via sqlx PG driver (fallback)");
                    return Ok(Box::new(conn));
                }
                Err(DbError::ConnectionError("All GaussDB drivers failed".into()))
            }
            // PG-compatible: use dialect-specific PgCompatibleConnection
            DatabaseType::Kingbase => {
                Ok(Box::new(PgCompatibleConnection::new(config, DialectConfig::kingbase()).await?))
            }
            DatabaseType::Vastbase => {
                Ok(Box::new(PgCompatibleConnection::new(config, DialectConfig::vastbase()).await?))
            }
            DatabaseType::YashanDB => {
                Ok(Box::new(PgCompatibleConnection::new(config, DialectConfig::yashandb()).await?))
            }
            DatabaseType::MySQL => Ok(Box::new(MySqlConnection::new(config).await?)),
            // MySQL-compatible: use MySqlConnection as provisional driver
            DatabaseType::OceanBase
            | DatabaseType::TiDB
            | DatabaseType::TDSQL => Ok(Box::new(MySqlConnection::new(config).await?)),
            DatabaseType::SQLite => Ok(Box::new(SQLiteConnection::new(config).await?)),
            DatabaseType::ClickHouse => {
                Ok(Box::new(ClickHouseConnection::new(config).await?))
            }
            // ODBC bridge group: not yet implemented
            DatabaseType::SQLServer => {
                match SqlServerConnection::new(config).await {
                    Ok(conn) => {
                        log::info!("SQLServer connected via tiberius");
                        return Ok(Box::new(conn));
                    }
                    Err(e) => log::warn!("tiberius failed: {}, driver not available", e),
                }
                Err(DbError::ConfigError(format!("SQLServer driver not available: ensure tiberius is configured")))
            }
            DatabaseType::Oracle
            | DatabaseType::DaMeng
            | DatabaseType::GBase => {
                Ok(Box::new(OdbcConnection::new(config, config.db_type.clone()).await?))
            }
        }
    }

    /// Connect to a database and store the connection
    pub async fn connect(&self, config: ConnectionConfig) -> Result<ConnectResult, DbError> {
        let mut effective_config = config.clone();

        // Set up SSH tunnel if configured
        let ssh_tunnel = if let Some(ref ssh) = config.ssh_tunnel {
            let target_host = config.host.as_deref().unwrap_or("localhost");
            let target_port = config.port.unwrap_or(0);
            let ssh_cfg = crate::ssh::tunnel::SshConfig {
                host: ssh.host.clone(),
                port: ssh.port,
                username: ssh.username.clone(),
                password: Some(ssh.password.clone()),
                private_key: ssh.private_key.clone(),
            };
            log::info!("Setting up SSH tunnel to {}:{}", target_host, target_port);
            let tunnel = crate::ssh::tunnel::SshTunnel::connect(&ssh_cfg, target_host, target_port).await?;
            let local_port = tunnel.local_addr.port();
            effective_config.host = Some("127.0.0.1".to_string());
            effective_config.port = Some(local_port);
            Some(tunnel)
        } else {
            None
        };

        let pm = self.get_plugin_manager().await;
        let connection = Self::create_connection_async(&effective_config, pm.as_deref()).await?;
        let detected_type = connection.db_type();

        let connection_id = config.id.clone();
        log::info!(
            "Connected to database '{}' with id '{}' (detected type: {:?})",
            config.name,
            connection_id,
            detected_type
        );

        let entry = ConnectionEntry {
            connection,
            config: config.clone(),
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            is_healthy: true,
            reconnect_count: 0,
            ssh_tunnel,
        };

        let mut connections = self.connections.write().await;
        if let Some(old) = connections.insert(connection_id.clone(), entry) {
            old.connection.close().await;
            log::info!("Closed old connection for id '{}'", connection_id);
        }

        Ok(ConnectResult {
            connection_id,
            detected_type,
        })
    }

    /// Disconnect from a database and all its sub-connections
    pub async fn disconnect(&self, id: &str) -> Result<(), DbError> {
        let mut connections = self.connections.write().await;

        // Collect and close sub-connections
        let sub_prefix = format!("{}:sub:", id);
        let sub_ids: Vec<String> = connections
            .keys()
            .filter(|k| k.starts_with(&sub_prefix))
            .cloned()
            .collect();

        for sub_id in &sub_ids {
            if let Some(sub_entry) = connections.remove(sub_id) {
                sub_entry.connection.close().await;
                log::info!("Closed sub-connection '{}'", sub_id);
            }
        }

        if let Some(entry) = connections.remove(id) {
            entry.connection.close().await;
            if let Some(tunnel) = entry.ssh_tunnel {
                tunnel.close().await;
            }
            log::info!("Disconnected from database with id '{}'", id);
            Ok(())
        } else {
            Err(DbError::NotFound(format!(
                "Connection '{}' not found",
                id
            )))
        }
    }

    /// Execute a SQL statement with auto-reconnect
    pub async fn execute(&self, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
        let result = self.execute_inner(id, sql).await;
        if let Err(DbError::ConnectionError(_)) = &result {
            if self.should_reconnect(id).await {
                if self.reconnect(id).await.is_ok() {
                    return self.execute_inner(id, sql).await;
                }
            }
        }
        result
    }

    /// Execute a user-initiated query with cancellation support (for the query editor).
    pub async fn query(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let result = self.query_inner_cancellable(id, sql).await;
        if let Err(DbError::ConnectionError(_)) = &result {
            if self.should_reconnect(id).await {
                if self.reconnect(id).await.is_ok() {
                    return self.query_inner_cancellable(id, sql).await;
                }
            }
        }
        result
    }

    /// Execute a metadata/internal query WITHOUT cancellation support.
    /// Used by schema loading, database listing, etc. — not user-facing.
    pub async fn query_metadata(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let result = self.query_inner(id, sql).await;
        if let Err(DbError::ConnectionError(_)) = &result {
            if self.should_reconnect(id).await {
                if self.reconnect(id).await.is_ok() {
                    return self.query_inner(id, sql).await;
                }
            }
        }
        result
    }

    /// Execute a paged SQL query with auto-LIMIT injection and auto-reconnect.
    ///
    /// If the SQL already contains a LIMIT/TOP/FETCH clause, it is executed as-is
    /// with `has_more = false`. Otherwise, the SQL is modified to include
    /// `LIMIT (limit+1) OFFSET offset` (or equivalent for MSSQL) to detect
    /// whether more rows are available.
    pub async fn query_paged(
        &self,
        id: &str,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<PagedQueryResult, DbError> {
        let result = self.query_paged_inner(id, sql, limit, offset).await;
        if let Err(DbError::ConnectionError(_)) = &result {
            if self.should_reconnect(id).await {
                if self.reconnect(id).await.is_ok() {
                    return self.query_paged_inner(id, sql, limit, offset).await;
                }
            }
        }
        result
    }

    /// Run a query with cancellation support (for user-initiated queries).
    /// Uses both oneshot cancel AND tokio timeout to ensure queries can always be interrupted.
    async fn query_inner_cancellable(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let mut cancel = self.cancel_token(id).await;
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        // 5-minute hard timeout prevents queries from hanging indefinitely
        let timeout = tokio::time::sleep(std::time::Duration::from_secs(300));
        tokio::pin!(timeout);
        let result = tokio::select! {
            r = entry.connection.query_sql(sql) => r,
            _ = &mut cancel => {
                log::info!("Query cancelled by user for connection '{}'", id);
                Err(DbError::QueryError("Query cancelled".to_string()))
            }
            _ = &mut timeout => {
                log::warn!("Query timed out (5min) for connection '{}'", id);
                Err(DbError::Timeout("Query exceeded 5 minute limit".to_string()))
            }
        };
        // Clean up the cancel sender regardless of outcome
        self.cancel_tokens.write().await.remove(id);
        if let Ok(ref _r) = result {
            *entry.last_heartbeat.lock().unwrap() = Instant::now();
        }
        result
    }

    /// Run a non-cancellable query (for metadata/internal use).
    /// Does NOT create a cancel token, so it doesn't interfere with user queries.
    /// Has a 60-second timeout — metadata queries should be fast; anything longer
    /// indicates a stuck connection.
    async fn query_inner(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            entry.connection.query_sql(sql),
        )
        .await
        .map_err(|_| DbError::Timeout("Metadata query exceeded 60s limit".to_string()))?;
        if let Ok(ref _r) = result {
            *entry.last_heartbeat.lock().unwrap() = Instant::now();
        }
        result
    }

    /// Non-cancellable execute (for metadata/internal use). 60s timeout.
    async fn execute_inner(&self, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            entry.connection.execute_sql(sql),
        )
        .await
        .map_err(|_| DbError::Timeout("Execute exceeded 60s limit".to_string()))?;
        if let Ok(ref _r) = result {
            *entry.last_heartbeat.lock().unwrap() = Instant::now();
        }
        result
    }

    async fn query_paged_inner(
        &self,
        id: &str,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<PagedQueryResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;

        // 5-minute hard timeout matches the cancellable path; prevents runaway
        // queries from holding a pool connection indefinitely.
        let timeout = std::time::Duration::from_secs(300);

        // If the user already specified a LIMIT / TOP / FETCH, execute as-is
        if sql_limiter::has_user_limit(sql) {
            let result = tokio::time::timeout(timeout, entry.connection.query_sql(sql))
                .await
                .map_err(|_| DbError::Timeout("Query exceeded 5 minute limit".to_string()))??;
            return Ok(PagedQueryResult {
                columns: result.columns,
                rows: result.rows,
                row_count: result.row_count,
                execution_time_ms: result.execution_time_ms,
                has_more: false,
            });
        }

        // Use streaming paged query that fetches at most limit+1 rows
        let db_type = entry.connection.db_type();
        let modified_sql =
            sql_limiter::inject_limit_offset(sql, &db_type, limit + 1, offset);
        let (result, has_more) = tokio::time::timeout(
            timeout,
            entry.connection.query_sql_paged(&modified_sql, limit, offset),
        )
        .await
        .map_err(|_| DbError::Timeout("Query exceeded 5 minute limit".to_string()))??;

        let row_count = result.rows.len() as u64;
        Ok(PagedQueryResult {
            columns: result.columns,
            rows: result.rows,
            row_count,
            execution_time_ms: result.execution_time_ms,
            has_more,
        })
    }

    async fn should_reconnect(&self, id: &str) -> bool {
        let connections = self.connections.read().await;
        if let Some(entry) = connections.get(id) {
            entry.config.auto_reconnect && entry.reconnect_count < MAX_RECONNECT_ATTEMPTS
        } else {
            false
        }
    }

    async fn reconnect(&self, id: &str) -> Result<(), DbError> {
        let (config, attempt) = {
            let mut connections = self.connections.write().await;
            let entry = connections
                .get_mut(id)
                .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;

            if entry.reconnect_count >= MAX_RECONNECT_ATTEMPTS {
                log::error!(
                    "Max reconnect attempts ({}) reached for connection '{}'",
                    MAX_RECONNECT_ATTEMPTS,
                    id
                );
                return Err(DbError::ConnectionError(format!(
                    "Max reconnect attempts ({}) reached",
                    MAX_RECONNECT_ATTEMPTS
                )));
            }

            entry.reconnect_count += 1;
            entry.is_healthy = false;
            let attempt = entry.reconnect_count;
            (entry.config.clone(), attempt)
        };

        let backoff_secs = 1u64 << (attempt - 1);
        log::info!(
            "Reconnect attempt {}/{} for connection '{}' (waiting {}s)...",
            attempt,
            MAX_RECONNECT_ATTEMPTS,
            id,
            backoff_secs
        );
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;

        let pm = self.get_plugin_manager().await;
        match Self::create_connection_async(&config, pm.as_deref()).await {
            Ok(new_conn) => {
                let mut connections = self.connections.write().await;
                if let Some(entry) = connections.get_mut(id) {
                    let old = std::mem::replace(&mut entry.connection, new_conn);
                    tokio::spawn(async move { old.close().await; });
                    *entry.last_heartbeat.lock().unwrap() = Instant::now();
                    entry.is_healthy = true;
                    // Reset attempt counter so future transient failures get a
                    // full reconnect budget again. Without this, a single
                    // successful reconnect "consumes" the budget and the next
                    // failure can trip MAX_RECONNECT_ATTEMPTS prematurely.
                    entry.reconnect_count = 0;
                    log::info!(
                        "Successfully reconnected connection '{}' on attempt {}",
                        id,
                        attempt
                    );
                }
                Ok(())
            }
            Err(e) => {
                log::error!(
                    "Reconnect attempt {} failed for connection '{}': {}",
                    attempt,
                    id,
                    e
                );
                Err(e)
            }
        }
    }

    /// Get database type for a connection
    pub async fn get_db_type(&self, id: &str) -> Option<DatabaseType> {
        let connections = self.connections.read().await;
        connections.get(id).map(|e| e.connection.db_type())
    }

    /// Get connection health status
    pub async fn get_connection_status(&self, id: &str) -> Result<ConnectionStatus, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;

        let elapsed = entry.last_heartbeat.lock().unwrap().elapsed();
        let last_heartbeat_str = if elapsed.as_secs() < 60 {
            format!("{}s ago", elapsed.as_secs())
        } else {
            format!(
                "{}m {}s ago",
                elapsed.as_secs() / 60,
                elapsed.as_secs() % 60
            )
        };

        Ok(ConnectionStatus {
            connected: true,
            healthy: entry.is_healthy,
            reconnect_count: entry.reconnect_count,
            last_heartbeat: last_heartbeat_str,
            keepalive_interval: entry.config.keepalive_interval,
            auto_reconnect: entry.config.auto_reconnect,
        })
    }

    /// Test a connection without storing it
    pub async fn test_connection(&self, config: ConnectionConfig) -> Result<bool, DbError> {
        let pm = self.get_plugin_manager().await;
        let connection = Self::create_connection_async(&config, pm.as_deref()).await?;

        match config.db_type {
            DatabaseType::SQLite => {
                connection.close().await;
                Ok(true)
            }
            _ => {
                let result = connection.query_sql("SELECT 1").await;
                connection.close().await;
                match result {
                    Ok(_) => Ok(true),
                    Err(e) => Err(DbError::ConnectionError(format!(
                        "Connection test failed: {}",
                        e
                    ))),
                }
            }
        }
    }

    // ========================================================================
    // Thin pass-through methods delegating to DatabaseConnection trait
    // ========================================================================

    pub async fn get_tables(&self, id: &str) -> Result<Vec<TableInfo>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_tables().await
    }

    pub async fn get_columns(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_columns(table, schema).await
    }

    pub async fn get_schemas(&self, id: &str) -> Result<Vec<String>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_schemas().await
    }

    /// Get schemas for a specific database by creating a cached sub-connection.
    /// Sub-connections use key pattern `{parent_id}:sub:{database_name}`.
    pub async fn get_schemas_for_database(
        &self,
        id: &str,
        database_name: &str,
    ) -> Result<Vec<String>, DbError> {
        let sub_id = format!("{}:sub:{}", id, database_name);

        // Return cached if sub-connection already exists
        {
            let connections = self.connections.read().await;
            if let Some(entry) = connections.get(&sub_id) {
                return entry.connection.get_schemas().await;
            }
        }

        // Clone parent config, swapping the target database
        let sub_config = {
            let connections = self.connections.read().await;
            let entry = connections
                .get(id)
                .ok_or_else(|| DbError::NotFound(format!("Parent connection '{}' not found", id)))?;
            let mut cfg = entry.config.clone();
            cfg.database = Some(database_name.to_string());
            cfg.id = sub_id.clone();
            cfg.keepalive_interval = 0;
            cfg.auto_reconnect = false;
            cfg
        };

        let pm = self.get_plugin_manager().await;
        let connection = Self::create_connection_async(&sub_config, pm.as_deref()).await?;
        let schemas = connection.get_schemas().await?;

        let sub_entry = ConnectionEntry {
            connection,
            config: sub_config,
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            is_healthy: true,
            reconnect_count: 0,
            ssh_tunnel: None,
        };

        self.connections.write().await.insert(sub_id.clone(), sub_entry);
        log::info!("Sub-connection '{}': {} schemas in database '{}'", sub_id, schemas.len(), database_name);

        Ok(schemas)
    }

    pub async fn export_table_sql(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.export_table_sql(table, schema).await
    }

    pub async fn export_database(
        &self,
        id: &str,
        tables: Option<&[String]>,
    ) -> Result<String, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;

        let all_tables = entry.connection.get_tables().await?;
        let tables_to_export: Vec<TableInfo> = match tables {
            Some(filter) => all_tables
                .into_iter()
                .filter(|t| filter.contains(&t.name))
                .collect(),
            None => all_tables,
        };

        let mut sql_parts = Vec::new();
        for table in &tables_to_export {
            let table_sql = entry
                .connection
                .export_table_sql(&table.name, table.schema.as_deref())
                .await?;
            sql_parts.push(table_sql);
        }

        Ok(format!(
            "-- CrabHub Database Export\n-- Generated at: {}\n-- Tables: {}\n\n{}",
            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
            tables_to_export.len(),
            sql_parts.join("\n")
        ))
    }

    pub async fn get_views(
        &self,
        id: &str,
        schema: Option<&str>,
    ) -> Result<Vec<TableInfo>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_views(schema).await
    }

    pub async fn get_indexes(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_indexes(table, schema).await
    }

    pub async fn get_foreign_keys(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_foreign_keys(table, schema).await
    }

    pub async fn get_table_row_count(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_table_row_count(table, schema).await
    }

    pub async fn update_table_rows(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry
            .connection
            .update_table_rows(table, schema, updates, where_conditions)
            .await
    }

    pub async fn insert_table_row(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry
            .connection
            .insert_table_row(table, schema, values)
            .await
    }

    pub async fn delete_table_rows(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry
            .connection
            .delete_table_rows(table, schema, where_conditions)
            .await
    }

    pub async fn get_table_data(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry
            .connection
            .get_table_data(table, schema, page, page_size, order_by)
            .await
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
