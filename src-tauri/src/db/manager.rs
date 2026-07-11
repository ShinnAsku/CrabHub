use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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

/// Resolve the user-query timeout for a connection. 0 = unlimited
/// (implemented as ~30 years, far beyond any session lifetime).
fn user_query_timeout(config: &ConnectionConfig) -> Duration {
    match config.query_timeout_secs {
        0 => Duration::from_secs(60 * 60 * 24 * 365 * 30),
        s => Duration::from_secs(s),
    }
}

/// Per-connection state tracking.
///
/// Stored as `Arc` in the manager's map so callers clone the entry out and
/// release the map lock *before* awaiting SQL. All mutable state uses interior
/// mutability; the map lock is therefore only ever held for microseconds.
struct ConnectionEntry {
    /// Entry-level lock: queries take `read` (shared), reconnect swaps take
    /// `write`. Holding it across an await blocks only THIS connection.
    connection: RwLock<Box<dyn DatabaseConnection>>,
    config: ConnectionConfig,
    last_heartbeat: std::sync::Mutex<Instant>,
    is_healthy: AtomicBool,
    reconnect_count: AtomicU32,
    /// SSH tunnel (kept alive for the lifetime of the connection)
    ssh_tunnel: std::sync::Mutex<Option<crate::ssh::tunnel::SshTunnel>>,
    /// True when the user manually disconnected — triggers auto-reconnect on next SQL
    disconnected: AtomicBool,
}

/// Cached metadata payload. Cheap to clone (all Vec-of-value types).
#[derive(Clone)]
enum CachedMeta {
    Tables(Vec<TableInfo>),
    Schemas(Vec<String>),
    Columns(Vec<ColumnInfo>),
}

/// Sidebar tree expansion hits get_tables/get_schemas/get_columns repeatedly;
/// a short TTL keeps the UI snappy without risking long-stale structure.
const METADATA_CACHE_TTL: Duration = Duration::from_secs(60);

/// Manages multiple database connections
pub struct ConnectionManager {
    connections: RwLock<HashMap<String, Arc<ConnectionEntry>>>,
    plugin_manager: tokio::sync::Mutex<Option<Arc<PluginManager>>>,
    /// Per-connection cancellation token shared by ALL in-flight queries on
    /// that connection. `cancel_query` fires it once; the next query lazily
    /// installs a fresh token. A oneshot-per-connection was used before, but
    /// starting a second concurrent query dropped (= fired) the first one's
    /// sender and spuriously cancelled it.
    cancel_tokens: RwLock<HashMap<String, tokio_util::sync::CancellationToken>>,
    /// TTL cache for schema metadata, keyed by `{conn_id}\x00{kind}[\x00args]`.
    /// Invalidated on TTL expiry, successful DDL, disconnect, and manual refresh.
    metadata_cache: RwLock<HashMap<String, (Instant, CachedMeta)>>,
}

impl ConnectionManager {
    /// Create a new connection manager
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            plugin_manager: tokio::sync::Mutex::new(None),
            cancel_tokens: RwLock::new(HashMap::new()),
            metadata_cache: RwLock::new(HashMap::new()),
        }
    }

    // --- Metadata cache helpers ---

    async fn meta_get(&self, key: &str) -> Option<CachedMeta> {
        let cache = self.metadata_cache.read().await;
        cache
            .get(key)
            .filter(|(at, _)| at.elapsed() < METADATA_CACHE_TTL)
            .map(|(_, v)| v.clone())
    }

    async fn meta_put(&self, key: String, value: CachedMeta) {
        self.metadata_cache.write().await.insert(key, (Instant::now(), value));
    }

    /// Drop all cached metadata for a connection (DDL ran, refresh clicked,
    /// or the connection went away).
    pub async fn invalidate_metadata(&self, id: &str) {
        let prefix = format!("{}\x00", id);
        let mut cache = self.metadata_cache.write().await;
        cache.retain(|k, _| !k.starts_with(&prefix));
    }

    /// DDL statements change structure; anything else leaves the cache valid.
    fn is_ddl(sql: &str) -> bool {
        let upper = sql.trim_start().to_uppercase();
        ["CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "COMMENT"]
            .iter()
            .any(|kw| upper.starts_with(kw))
    }

    /// Cancel the currently-running quer(ies) on the given connection.
    ///
    /// Two-phase: (1) fire the shared CancellationToken, which immediately
    /// resolves the `tokio::select!` branch of every in-flight query so the
    /// UI unblocks; (2) best-effort SERVER-SIDE cancel in the background —
    /// without it the statement keeps running on the server and holds a pool
    /// connection hostage.
    pub async fn cancel_query(&self, id: &str) -> bool {
        let client_cancelled = match self.cancel_tokens.write().await.remove(id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        };
        if let Ok(entry) = self.entry(id).await {
            let conn_id = id.to_string();
            tokio::spawn(async move {
                let connection = entry.connection.read().await;
                if connection.cancel_running_query().await {
                    log::info!("Server-side cancel dispatched for connection '{}'", conn_id);
                }
            });
        }
        client_cancelled
    }

    /// Get (or lazily create) the shared cancel token for a connection.
    /// Cloning is cheap; every concurrent query on the connection listens on
    /// the same token, so one cancel stops them all without affecting others.
    async fn cancel_token(&self, id: &str) -> tokio_util::sync::CancellationToken {
        let mut tokens = self.cancel_tokens.write().await;
        tokens
            .entry(id.to_string())
            .or_insert_with(tokio_util::sync::CancellationToken::new)
            .clone()
    }

    /// Inject the plugin manager (called during app setup)
    pub fn set_plugin_manager(&self, pm: Arc<PluginManager>) {
        *self.plugin_manager.try_lock().expect("plugin_manager lock uncontended during setup") = Some(pm);
    }

    async fn get_plugin_manager(&self) -> Option<Arc<PluginManager>> {
        self.plugin_manager.lock().await.clone()
    }

    /// Clone the entry Arc for `id`, holding the map lock only briefly.
    /// Callers await SQL on the returned entry WITHOUT blocking the map.
    async fn entry(&self, id: &str) -> Result<Arc<ConnectionEntry>, DbError> {
        let connections = self.connections.read().await;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))
    }

    /// Like [`Self::entry`], but rejects manually disconnected connections.
    async fn active_entry(&self, id: &str) -> Result<Arc<ConnectionEntry>, DbError> {
        let entry = self.entry(id).await?;
        if entry.disconnected.load(Ordering::Relaxed) {
            return Err(DbError::ConnectionError("Connection is disconnected".into()));
        }
        Ok(entry)
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
                    let conns = manager.connections.read().await;
                    if let Some(e) = conns.get(id) {
                        e.is_healthy.store(false, Ordering::Relaxed);
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

        let entry = Arc::new(ConnectionEntry {
            connection: RwLock::new(connection),
            config: config.clone(),
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            is_healthy: AtomicBool::new(true),
            reconnect_count: AtomicU32::new(0),
            ssh_tunnel: std::sync::Mutex::new(ssh_tunnel),
            disconnected: AtomicBool::new(false),
        });

        let old = {
            let mut connections = self.connections.write().await;
            connections.insert(connection_id.clone(), entry)
        };
        if let Some(old) = old {
            old.connection.read().await.close().await;
            log::info!("Closed old connection for id '{}'", connection_id);
        }
        // A (re)connect may target a different database; stale metadata must go.
        self.invalidate_metadata(&connection_id).await;

        Ok(ConnectResult {
            connection_id,
            detected_type,
        })
    }

    /// Disconnect from a database and all its sub-connections.
    /// The connection entry is kept in the map (with disconnected=true) so that
    /// auto-reconnect can re-establish the connection on the next SQL execution.
    pub async fn disconnect(&self, id: &str) -> Result<(), DbError> {
        // Remove sub-connections and grab the main entry; the map lock is only
        // held for this short block — closing happens outside it.
        let (subs, entry) = {
            let mut connections = self.connections.write().await;
            let sub_prefix = format!("{}:sub:", id);
            let sub_ids: Vec<String> = connections
                .keys()
                .filter(|k| k.starts_with(&sub_prefix))
                .cloned()
                .collect();
            let subs: Vec<(String, Arc<ConnectionEntry>)> = sub_ids
                .into_iter()
                .filter_map(|sid| connections.remove(&sid).map(|e| (sid, e)))
                .collect();
            (subs, connections.get(id).cloned())
        };

        for (sub_id, sub_entry) in subs {
            sub_entry.connection.read().await.close().await;
            log::info!("Closed sub-connection '{}'", sub_id);
        }

        if let Some(entry) = entry {
            entry.connection.read().await.close().await;
            let tunnel = entry.ssh_tunnel.lock().unwrap().take();
            if let Some(tunnel) = tunnel {
                tunnel.close().await;
            }
            entry.is_healthy.store(false, Ordering::Relaxed);
            entry.disconnected.store(true, Ordering::Relaxed);
            entry.reconnect_count.store(0, Ordering::Relaxed); // reset for fresh reconnect budget
            self.invalidate_metadata(id).await;
            log::info!("Disconnected from database '{}' (entry kept for auto-reconnect)", id);
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
                    let retried = self.execute_inner(id, sql).await;
                    if retried.is_ok() && Self::is_ddl(sql) {
                        self.invalidate_metadata(id).await;
                    }
                    return retried;
                }
            }
        }
        if result.is_ok() && Self::is_ddl(sql) {
            self.invalidate_metadata(id).await;
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
        let cancel = self.cancel_token(id).await;
        let entry = self.active_entry(id).await?;
        let connection = entry.connection.read().await;
        // Configurable hard timeout (default 300s, 0 = unlimited) prevents
        // queries from hanging indefinitely
        let timeout_dur = user_query_timeout(&entry.config);
        let timeout = tokio::time::sleep(timeout_dur);
        tokio::pin!(timeout);
        let result = tokio::select! {
            r = connection.query_sql(sql) => r,
            _ = cancel.cancelled() => {
                log::info!("Query cancelled by user for connection '{}'", id);
                Err(DbError::QueryError("Query cancelled".to_string()))
            }
            _ = &mut timeout => {
                log::warn!("Query timed out ({}s) for connection '{}'", timeout_dur.as_secs(), id);
                Err(DbError::Timeout(format!("Query exceeded {}s limit", timeout_dur.as_secs())))
            }
        };
        if result.is_ok() {
            *entry.last_heartbeat.lock().unwrap() = Instant::now();
        }
        result
    }

    /// Run a non-cancellable query (for metadata/internal use).
    /// Does NOT create a cancel token, so it doesn't interfere with user queries.
    /// Has a 60-second timeout — metadata queries should be fast; anything longer
    /// indicates a stuck connection.
    async fn query_inner(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let entry = self.active_entry(id).await?;
        let connection = entry.connection.read().await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            connection.query_sql(sql),
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
        let entry = self.active_entry(id).await?;
        let connection = entry.connection.read().await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            connection.execute_sql(sql),
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
        let entry = self.active_entry(id).await?;
        let connection = entry.connection.read().await;

        // Configurable hard timeout matching the cancellable path; prevents
        // runaway queries from holding a pool connection indefinitely.
        let timeout = user_query_timeout(&entry.config);

        // If the user already specified a LIMIT / TOP / FETCH, execute as-is
        if sql_limiter::has_user_limit(sql) {
            let result = tokio::time::timeout(timeout, connection.query_sql(sql))
                .await
                .map_err(|_| DbError::Timeout(format!("Query exceeded {}s limit", timeout.as_secs())))??;
            return Ok(PagedQueryResult {
                columns: result.columns,
                rows: result.rows,
                row_count: result.row_count,
                execution_time_ms: result.execution_time_ms,
                has_more: false,
            });
        }

        // Use streaming paged query that fetches at most limit+1 rows
        let db_type = connection.db_type();
        let modified_sql =
            sql_limiter::inject_limit_offset(sql, &db_type, limit + 1, offset);
        let (result, has_more) = tokio::time::timeout(
            timeout,
            connection.query_sql_paged(&modified_sql, limit, offset),
        )
        .await
        .map_err(|_| DbError::Timeout(format!("Query exceeded {}s limit", timeout.as_secs())))??;

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
        match self.entry(id).await {
            Ok(entry) => {
                entry.config.auto_reconnect
                    && entry.reconnect_count.load(Ordering::Relaxed) < MAX_RECONNECT_ATTEMPTS
            }
            Err(_) => false,
        }
    }

    async fn reconnect(&self, id: &str) -> Result<(), DbError> {
        let entry = self.entry(id).await?;

        let prev = entry.reconnect_count.fetch_add(1, Ordering::Relaxed);
        if prev >= MAX_RECONNECT_ATTEMPTS {
            entry.reconnect_count.store(MAX_RECONNECT_ATTEMPTS, Ordering::Relaxed);
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
        entry.is_healthy.store(false, Ordering::Relaxed);
        let attempt = prev + 1;
        let config = entry.config.clone();

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
                // Entry-level write lock: waits for in-flight queries on this
                // connection to finish, but never blocks other connections.
                let old = {
                    let mut connection = entry.connection.write().await;
                    std::mem::replace(&mut *connection, new_conn)
                };
                tokio::spawn(async move { old.close().await; });
                *entry.last_heartbeat.lock().unwrap() = Instant::now();
                entry.is_healthy.store(true, Ordering::Relaxed);
                entry.disconnected.store(false, Ordering::Relaxed);
                // Reset attempt counter so future transient failures get a
                // full reconnect budget again. Without this, a single
                // successful reconnect "consumes" the budget and the next
                // failure can trip MAX_RECONNECT_ATTEMPTS prematurely.
                entry.reconnect_count.store(0, Ordering::Relaxed);
                log::info!(
                    "Successfully reconnected connection '{}' on attempt {}",
                    id,
                    attempt
                );
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
        let entry = self.entry(id).await.ok()?;
        let db_type = entry.connection.read().await.db_type();
        Some(db_type)
    }

    /// List all live connections (for the RPC / MCP surface). Excludes
    /// sub-connections and never exposes credentials.
    pub async fn list_connections(&self) -> Vec<serde_json::Value> {
        let connections = self.connections.read().await;
        connections
            .iter()
            .filter(|(id, _)| !id.contains(":sub:"))
            .map(|(id, e)| {
                serde_json::json!({
                    "id": id,
                    "name": e.config.name,
                    "dbType": e.config.db_type.as_str(),
                    "host": e.config.host,
                    "database": e.config.database,
                    "healthy": e.is_healthy.load(Ordering::Relaxed),
                    "disconnected": e.disconnected.load(Ordering::Relaxed),
                })
            })
            .collect()
    }

    /// Get connection health status
    pub async fn get_connection_status(&self, id: &str) -> Result<ConnectionStatus, DbError> {
        let entry = self.entry(id).await?;

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
            healthy: entry.is_healthy.load(Ordering::Relaxed),
            reconnect_count: entry.reconnect_count.load(Ordering::Relaxed),
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
        let key = format!("{}\x00tables", id);
        if let Some(CachedMeta::Tables(t)) = self.meta_get(&key).await {
            return Ok(t);
        }
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        let tables = connection.get_tables().await?;
        self.meta_put(key, CachedMeta::Tables(tables.clone())).await;
        Ok(tables)
    }

    pub async fn get_columns(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let key = format!("{}\x00columns\x00{}\x00{}", id, schema.unwrap_or(""), table);
        if let Some(CachedMeta::Columns(c)) = self.meta_get(&key).await {
            return Ok(c);
        }
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        let columns = connection.get_columns(table, schema).await?;
        self.meta_put(key, CachedMeta::Columns(columns.clone())).await;
        Ok(columns)
    }

    pub async fn get_schemas(&self, id: &str) -> Result<Vec<String>, DbError> {
        let key = format!("{}\x00schemas", id);
        if let Some(CachedMeta::Schemas(s)) = self.meta_get(&key).await {
            return Ok(s);
        }
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        let schemas = connection.get_schemas().await?;
        self.meta_put(key, CachedMeta::Schemas(schemas.clone())).await;
        Ok(schemas)
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
        if let Ok(entry) = self.entry(&sub_id).await {
            let connection = entry.connection.read().await;
            return connection.get_schemas().await;
        }

        // Clone parent config, swapping the target database
        let sub_config = {
            let entry = self.entry(id).await.map_err(|_| {
                DbError::NotFound(format!("Parent connection '{}' not found", id))
            })?;
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

        let sub_entry = Arc::new(ConnectionEntry {
            connection: RwLock::new(connection),
            config: sub_config,
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            is_healthy: AtomicBool::new(true),
            reconnect_count: AtomicU32::new(0),
            ssh_tunnel: std::sync::Mutex::new(None),
            disconnected: AtomicBool::new(false),
        });

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
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection.export_table_sql(table, schema).await
    }

    pub async fn export_database(
        &self,
        id: &str,
        tables: Option<&[String]>,
    ) -> Result<String, DbError> {
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;

        let all_tables = connection.get_tables().await?;
        let tables_to_export: Vec<TableInfo> = match tables {
            Some(filter) => all_tables
                .into_iter()
                .filter(|t| filter.contains(&t.name))
                .collect(),
            None => all_tables,
        };

        let mut sql_parts = Vec::new();
        for table in &tables_to_export {
            let table_sql = connection
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
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection.get_views(schema).await
    }

    pub async fn get_indexes(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection.get_indexes(table, schema).await
    }

    pub async fn get_foreign_keys(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection.get_foreign_keys(table, schema).await
    }

    pub async fn get_table_row_count(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection.get_table_row_count(table, schema).await
    }

    pub async fn update_table_rows(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection
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
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection
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
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection
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
        let entry = self.entry(id).await?;
        let connection = entry.connection.read().await;
        connection
            .get_table_data(table, schema, page, page_size, order_by)
            .await
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
