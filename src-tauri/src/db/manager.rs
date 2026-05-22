use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::clickhouse::ClickHouseConnection;
use super::dialect::DialectConfig;
use super::gauss_rs::GaussAsyncConnection;
use super::mysql::MySqlConnection;
use super::pg_compatible::PgCompatibleConnection;
use super::postgres::PostgresConnection;
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
    /// Updated by heartbeat AND by every user query, so heartbeat can skip busy conns
    last_heartbeat: std::sync::Mutex<Instant>,
    is_healthy: bool,
    reconnect_count: u32,
}

/// Manages multiple database connections
pub struct ConnectionManager {
    connections: RwLock<HashMap<String, ConnectionEntry>>,
    plugin_manager: std::sync::Mutex<Option<Arc<PluginManager>>>,
    /// Per-connection cancel senders. Dropping the sender cancels the active query.
    cancel_tokens: RwLock<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

impl ConnectionManager {
    /// Create a new connection manager
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            plugin_manager: std::sync::Mutex::new(None),
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
        *self.plugin_manager.lock().unwrap() = Some(pm);
    }

    fn get_plugin_manager(&self) -> Option<Arc<PluginManager>> {
        self.plugin_manager.lock().unwrap().clone()
    }

    /// Background loop that checks connection health without running SQL queries.
    /// Health is determined by whether recent user queries succeeded (last_heartbeat
    /// is touched on every successful query). This avoids any TCP-level contention
    /// with user queries on the same connection.
    pub async fn start_heartbeat(manager: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            let to_check: Vec<(String, bool)> = {
                let connections = manager.connections.read().await;
                connections
                    .iter()
                    .filter(|(_, e)| e.config.keepalive_interval != 0)
                    .map(|(id, e)| {
                        let idle_secs = e.last_heartbeat.lock().unwrap().elapsed().as_secs();
                        (id.clone(), idle_secs > 120)
                    })
                    .collect()
            };

            for (id, is_stale) in &to_check {
                if *is_stale {
                    log::debug!("Heartbeat: connection '{}' idle for >120s, marking unhealthy", id);
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
            // PG-compatible: use PostgresConnection as provisional driver
            DatabaseType::Kingbase
            | DatabaseType::Vastbase
            | DatabaseType::YashanDB => {
                Ok(Box::new(PostgresConnection::new(config).await?))
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
            DatabaseType::Oracle
            | DatabaseType::SQLServer
            | DatabaseType::DaMeng
            | DatabaseType::GBase => {
                Err(DbError::ConfigError(format!(
                    "Driver for {:?} is not yet implemented",
                    config.db_type
                )))
            }
        }
    }

    /// Connect to a database and store the connection
    pub async fn connect(&self, config: ConnectionConfig) -> Result<ConnectResult, DbError> {
        let pm = self.get_plugin_manager();
        let connection = Self::create_connection_async(&config, pm.as_deref()).await?;
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
        if let Ok(ref _r) = result {
            *entry.last_heartbeat.lock().unwrap() = Instant::now();
        }
        result
    }

    /// Run a non-cancellable query (for metadata/internal use).
    /// Does NOT create a cancel token, so it doesn't interfere with user queries.
    async fn query_inner(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        let result = entry.connection.query_sql(sql).await;
        if let Ok(ref _r) = result {
            *entry.last_heartbeat.lock().unwrap() = Instant::now();
        }
        result
    }

    /// Non-cancellable execute (for metadata/internal use).
    async fn execute_inner(&self, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        let result = entry.connection.execute_sql(sql).await;
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

        // If the user already specified a LIMIT / TOP / FETCH, execute as-is
        if sql_limiter::has_user_limit(sql) {
            let result = entry.connection.query_sql(sql).await?;
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
        let (result, has_more) = entry.connection.query_sql_paged(&modified_sql, limit, offset).await?;

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

        let pm = self.get_plugin_manager();
        match Self::create_connection_async(&config, pm.as_deref()).await {
            Ok(new_conn) => {
                let mut connections = self.connections.write().await;
                if let Some(entry) = connections.get_mut(id) {
                    let old = std::mem::replace(&mut entry.connection, new_conn);
                    tokio::spawn(async move { old.close().await; });
                    *entry.last_heartbeat.lock().unwrap() = Instant::now();
                    entry.is_healthy = true;
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
        let pm = self.get_plugin_manager();
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

        let pm = self.get_plugin_manager();
        let connection = Self::create_connection_async(&sub_config, pm.as_deref()).await?;
        let schemas = connection.get_schemas().await?;

        let sub_entry = ConnectionEntry {
            connection,
            config: sub_config,
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            is_healthy: true,
            reconnect_count: 0,
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
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry
            .connection
            .update_table_rows(table, schema, updates, where_clause)
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
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry
            .connection
            .delete_table_rows(table, schema, where_clause)
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

/// Dummy connection used as a placeholder when swapping connections during reconnect
struct DummyConnection;

#[async_trait]
impl DatabaseConnection for DummyConnection {
    async fn execute_sql(&self, _sql: &str) -> Result<ExecuteResult, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn query_sql(&self, _sql: &str) -> Result<QueryResult, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn query_sql_paged(
        &self,
        _sql: &str,
        _limit: u64,
        _offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_columns(
        &self,
        _table: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    fn db_type(&self) -> DatabaseType {
        DatabaseType::PostgreSQL // placeholder
    }
    async fn close(&self) {}
    async fn export_table_sql(
        &self,
        _table: &str,
        _schema: Option<&str>,
    ) -> Result<String, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_views(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_indexes(
        &self,
        _table: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_foreign_keys(
        &self,
        _table: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_table_row_count(
        &self,
        _table: &str,
        _schema: Option<&str>,
    ) -> Result<u64, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn get_table_data(
        &self,
        _table: &str,
        _schema: Option<&str>,
        _page: u32,
        _page_size: u32,
        _order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn update_table_rows(
        &self,
        _table: &str,
        _schema: Option<&str>,
        _updates: &[(String, serde_json::Value)],
        _where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn insert_table_row(
        &self,
        _table: &str,
        _schema: Option<&str>,
        _values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
    async fn delete_table_rows(
        &self,
        _table: &str,
        _schema: Option<&str>,
        _where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        Err(DbError::ConnectionError(
            "Connection is being reconnected".to_string(),
        ))
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
