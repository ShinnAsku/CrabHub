use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::metadata_cache::{CachedMeta, MetadataCache};
use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectResult, ConnectionConfig, ConnectionStatus, DatabaseType, DbError,
    ExecuteResult, PagedQueryResult, QueryResult, TableInfo,
};
use crate::plugins::manager::PluginManager;

// ============================================================================
// Connection Manager
// ============================================================================

const MAX_RECONNECT_ATTEMPTS: u32 = 3;

/// Resolve the user-query timeout for a connection. 0 = unlimited
/// (implemented as ~30 years, far beyond any session lifetime).
pub(super) fn user_query_timeout(config: &ConnectionConfig) -> Duration {
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
pub(super) struct ConnectionEntry {
    /// Entry-level lock: queries take `read` (shared), reconnect swaps take
    /// `write`. Holding it across an await blocks only THIS connection.
    pub(super) connection: RwLock<Box<dyn DatabaseConnection>>,
    pub(super) config: ConnectionConfig,
    pub(super) last_heartbeat: std::sync::Mutex<Instant>,
    pub(super) is_healthy: AtomicBool,
    pub(super) reconnect_count: AtomicU32,
    /// SSH tunnel (kept alive for the lifetime of the connection)
    pub(super) ssh_tunnel: std::sync::Mutex<Option<crate::ssh::tunnel::SshTunnel>>,
    /// True when the user manually disconnected — triggers auto-reconnect on next SQL
    pub(super) disconnected: AtomicBool,
}

/// Manages multiple database connections
pub struct ConnectionManager {
    pub(super) connections: RwLock<HashMap<String, Arc<ConnectionEntry>>>,
    pub(super) executions: Arc<super::execution_registry::ExecutionRegistry>,
    pub(super) transactions: Arc<super::transactions::TransactionService>,
    pub(super) plugin_manager: tokio::sync::Mutex<Option<Arc<PluginManager>>>,
    /// Per-connection cancellation token shared by ALL in-flight queries on
    /// that connection. `cancel_query` fires it once; the next query lazily
    /// installs a fresh token. A oneshot-per-connection was used before, but
    /// starting a second concurrent query dropped (= fired) the first one's
    /// sender and spuriously cancelled it.
    pub(super) cancel_tokens: RwLock<HashMap<String, tokio_util::sync::CancellationToken>>,
    pub(super) metadata_cache: MetadataCache,
}

impl ConnectionManager {
    /// Create a new connection manager
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            executions: Arc::new(super::execution_registry::ExecutionRegistry::default()),
            transactions: Arc::new(super::transactions::TransactionService::default()),
            plugin_manager: tokio::sync::Mutex::new(None),
            cancel_tokens: RwLock::new(HashMap::new()),
            metadata_cache: MetadataCache::default(),
        }
    }

    // --- Metadata cache helpers ---

    pub(super) async fn meta_get(&self, key: &str) -> Option<CachedMeta> {
        self.metadata_cache.get(key).await
    }

    pub(super) async fn meta_put(&self, key: String, value: CachedMeta) {
        self.metadata_cache.put(key, value).await;
    }

    /// Drop all cached metadata for a connection (DDL ran, refresh clicked,
    /// or the connection went away).
    pub async fn invalidate_metadata(&self, id: &str) {
        self.metadata_cache.invalidate(id).await;
    }

    /// DDL statements change structure; anything else leaves the cache valid.
    pub(super) fn is_ddl(sql: &str) -> bool {
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
                let connection = entry.connection.write().await;
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
    pub(super) async fn cancel_token(&self, id: &str) -> tokio_util::sync::CancellationToken {
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

    pub(super) async fn get_plugin_manager(&self) -> Option<Arc<PluginManager>> {
        self.plugin_manager.lock().await.clone()
    }

    /// Clone the entry Arc for `id`, holding the map lock only briefly.
    /// Callers await SQL on the returned entry WITHOUT blocking the map.
    pub(super) async fn entry(&self, id: &str) -> Result<Arc<ConnectionEntry>, DbError> {
        let connections = self.connections.read().await;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))
    }

    /// Like [`Self::entry`], but rejects manually disconnected connections.
    pub(super) async fn active_entry(&self, id: &str) -> Result<Arc<ConnectionEntry>, DbError> {
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
    pub(super) async fn create_connection_async(
        config: &ConnectionConfig,
        plugin_manager: Option<&PluginManager>,
    ) -> Result<Box<dyn DatabaseConnection>, DbError> {
        super::connector::create_connection_async(config, plugin_manager).await
    }

    pub(super) async fn prepare_transport(config: &ConnectionConfig) -> Result<(ConnectionConfig, Option<crate::ssh::tunnel::SshTunnel>), DbError> {
        super::connector::prepare_transport(config).await
    }

    /// Connect to a database and store the connection
    pub async fn connect(&self, config: ConnectionConfig) -> Result<ConnectResult, DbError> {
        let (effective_config, ssh_tunnel) = Self::prepare_transport(&config).await?;
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
            let connection = old.connection.write().await;
            self.transactions.disconnect(&connection_id);
            connection.close().await;
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
        self.transactions.disconnect(id);
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
            let connection = sub_entry.connection.write().await;
            self.transactions.disconnect(&sub_id);
            connection.close().await;
            log::info!("Closed sub-connection '{}'", sub_id);
        }

        if let Some(entry) = entry {
            let connection = entry.connection.write().await;
            self.transactions.disconnect(id);
            connection.close().await;
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
        super::query_service::execute(self, id, sql).await
    }

    /// Execute a user-initiated query with cancellation support (for the query editor).
    pub async fn query(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        super::query_service::query(self, id, sql).await
    }

    /// Execute a metadata/internal query WITHOUT cancellation support.
    /// Used by schema loading, database listing, etc. — not user-facing.
    pub async fn query_metadata(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        super::query_service::query_metadata(self, id, sql).await
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
        super::query_service::query_paged(self, id, sql, limit, offset).await
    }

    /// Run a query with cancellation support (for user-initiated queries).
    /// Uses both oneshot cancel AND tokio timeout to ensure queries can always be interrupted.
    pub(super) async fn query_inner_cancellable(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        super::query_service::query_inner_cancellable(self, id, sql).await
    }

    /// Run a non-cancellable query (for metadata/internal use).
    /// Does NOT create a cancel token, so it doesn't interfere with user queries.
    /// Has a 60-second timeout — metadata queries should be fast; anything longer
    /// indicates a stuck connection.
    pub(super) async fn query_inner(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        super::query_service::query_inner(self, id, sql).await
    }

    /// Non-cancellable execute (for metadata/internal use). 60s timeout.
    pub(super) async fn execute_inner(&self, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
        super::query_service::execute_inner(self, id, sql).await
    }

    pub(super) async fn query_paged_inner(
        &self,
        id: &str,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<PagedQueryResult, DbError> {
        super::query_service::query_paged_inner(self, id, sql, limit, offset).await
    }

    pub(super) async fn should_reconnect(&self, id: &str) -> bool {
        match self.entry(id).await {
            Ok(entry) => {
                entry.config.auto_reconnect
                    && entry.reconnect_count.load(Ordering::Relaxed) < MAX_RECONNECT_ATTEMPTS
            }
            Err(_) => false,
        }
    }

    pub(super) async fn reconnect(&self, id: &str) -> Result<(), DbError> {
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

        let (effective_config, new_tunnel) = Self::prepare_transport(&config).await?;
        let pm = self.get_plugin_manager().await;
        match Self::create_connection_async(&effective_config, pm.as_deref()).await {
            Ok(new_conn) => {
                // Entry-level write lock: waits for in-flight queries on this
                // connection to finish, but never blocks other connections.
                let (old, old_tunnel) = {
                    let mut connection = entry.connection.write().await;
                    self.transactions.disconnect(id);
                    let old = std::mem::replace(&mut *connection, new_conn);
                    let old_tunnel = std::mem::replace(&mut *entry.ssh_tunnel.lock().unwrap(), new_tunnel);
                    (old, old_tunnel)
                };
                tokio::spawn(async move {
                    old.close().await;
                    if let Some(tunnel) = old_tunnel { tunnel.close().await; }
                });
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

    pub fn cancel_execution(&self, owner: &str, execution_id: &str) -> bool {
        super::query_service::cancel_execution(self, owner, execution_id)
    }

    pub async fn transaction(&self, owner: &str, request: super::transactions::TransactionRequest) -> Result<super::transactions::TransactionResult, DbError> {
        super::query_service::transaction(self, owner, request).await
    }

    pub async fn insert_rows_bulk(&self, owner: &str, request: &super::bulk::BulkRequest) -> Result<super::bulk::BulkOutcome, DbError> {
        super::query_service::insert_rows_bulk(self, owner, request).await
    }

    pub async fn query_read_only(&self, id: &str, sql: &str, explain: bool) -> Result<QueryResult, DbError> {
        super::query_service::query_read_only(self, id, sql, explain).await
    }

    pub async fn supports_script_sessions(&self, id: &str) -> Result<bool, DbError> {
        super::query_service::supports_script_sessions(self, id).await
    }

    pub async fn connection_capabilities(&self, id: &str) -> Result<super::types::ConnectionCapabilities, DbError> {
        super::query_service::connection_capabilities(self, id).await
    }

    pub fn acknowledge_execution(&self, owner: &str, execution_id: &str, sequence: usize) -> bool {
        super::query_service::acknowledge_execution(self, owner, execution_id, sequence)
    }

    pub fn expect_execution_ack(&self, owner: &str, execution_id: &str, sequence: usize, sender: tokio::sync::oneshot::Sender<()>) -> bool {
        super::query_service::expect_execution_ack(self, owner, execution_id, sequence, sender)
    }

    pub async fn execute_script(
        &self,
        owner: &str,
        execution_id: &str,
        id: &str,
        statements: &[String],
        options: &super::execution::ScriptOptions,
    ) -> Result<super::execution::ScriptOutcome, DbError> {
        super::query_service::execute_script(self, owner, execution_id, id, statements, options).await
    }

    pub async fn execute_script_progress(
        &self,
        owner: &str,
        request: &super::execution::ScriptRequest,
        progress: Option<&tokio::sync::mpsc::Sender<super::execution::ExecutionDelivery>>,
    ) -> Result<super::execution::ScriptOutcome, DbError> {
        super::query_service::execute_script_progress(self, owner, request, progress).await
    }

    /// Execute a batch of SQL statements sequentially on one connection.
    /// Shared by the Tauri command layer and the web server. Queries return
    /// wire-format paged results; DML returns ExecuteResult; per-statement
    /// errors are embedded so one failure doesn't abort the batch.
    pub async fn execute_batch_json(&self, id: &str, statements: &[String]) -> Result<Vec<serde_json::Value>, String> {
        super::query_service::execute_batch_json(self, id, statements).await
    }

    /// List databases visible on a connection, using per-dialect catalog SQL.
    pub async fn get_databases(&self, id: &str) -> Result<Vec<String>, DbError> {
        super::metadata_service::get_databases(self, id).await
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
        let (effective_config, _tunnel) = Self::prepare_transport(&config).await?;
        let pm = self.get_plugin_manager().await;
        let connection = Self::create_connection_async(&effective_config, pm.as_deref()).await?;

        match config.db_type {
            DatabaseType::SQLite => {
                connection.close().await;
                Ok(true)
            }
            _ => {
                let result = connection.ping().await;
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

    /// Switch the active database by reconnecting with the new database name
    /// in the connection config. This is the most reliable approach as it
    /// avoids connection-pool session-state issues with USE.
    pub async fn switch_database(&self, id: &str, database: &str) -> Result<(), DbError> {
        if self.transactions.has_connection(id) {
            return Err(DbError::QueryError("Finish the active transaction before switching databases".into()));
        }
        let entry = self.entry(id).await?;
        let db_type = {
            let connection = entry.connection.read().await;
            connection.db_type()
        };
        let supports_switch = matches!(
            db_type,
            DatabaseType::MySQL | DatabaseType::TiDB | DatabaseType::TDSQL
                | DatabaseType::OceanBase | DatabaseType::ClickHouse
        );
        if !supports_switch {
            return Err(DbError::ConfigError(format!(
                "switch_database not supported for {:?}", db_type
            )));
        }

        log::info!("Switching database on connection '{}' to '{}'", id, database);

        // Build new config with the target database
        let mut new_config = entry.config.clone();
        new_config.database = Some(database.to_string());

        // Create a new connection with the updated config
        let new_connection = Self::create_connection_async(&new_config, self.plugin_manager.lock().await.as_deref()).await?;

        // Replace the connection atomically
        {
            let mut conn = entry.connection.write().await;
            if self.transactions.has_connection(id) {
                new_connection.close().await;
                return Err(DbError::QueryError("A transaction started while switching databases; no switch was performed".into()));
            }
            let old = std::mem::replace(&mut *conn, new_connection);
            tokio::spawn(async move { old.close().await });
        }

        // Update config and clear cached metadata
        *entry.last_heartbeat.lock().unwrap() = Instant::now();
        entry.is_healthy.store(true, Ordering::Relaxed);
        self.invalidate_metadata(id).await;
        log::info!("Switched database for '{}' to '{}'", id, database);
        Ok(())
    }

    pub async fn get_tables(&self, id: &str) -> Result<Vec<TableInfo>, DbError> {
        super::metadata_service::get_tables(self, id).await
    }

    pub async fn get_columns(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        super::metadata_service::get_columns(self, id, table, schema).await
    }

    pub async fn get_schemas(&self, id: &str) -> Result<Vec<String>, DbError> {
        super::metadata_service::get_schemas(self, id).await
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
            if !matches!(cfg.db_type, DatabaseType::DaMeng | DatabaseType::YashanDB) {
                cfg.database = Some(database_name.to_string());
            }
            cfg.id = sub_id.clone();
            cfg.keepalive_interval = 0;
            cfg.auto_reconnect = false;
            cfg
        };

        let (effective_config, tunnel) = Self::prepare_transport(&sub_config).await?;
        let pm = self.get_plugin_manager().await;
        let connection = match Self::create_connection_async(&effective_config, pm.as_deref()).await {
            Ok(connection) => connection,
            Err(error) => {
                if let Some(tunnel) = tunnel { tunnel.close().await; }
                return Err(error);
            }
        };
        let schemas = match connection.get_schemas().await {
            Ok(schemas) => schemas,
            Err(error) => {
                connection.close().await;
                if let Some(tunnel) = tunnel { tunnel.close().await; }
                return Err(error);
            }
        };

        let sub_entry = Arc::new(ConnectionEntry {
            connection: RwLock::new(connection),
            config: sub_config,
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            is_healthy: AtomicBool::new(true),
            reconnect_count: AtomicU32::new(0),
            ssh_tunnel: std::sync::Mutex::new(tunnel),
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
        super::metadata_service::export_table_sql(self, id, table, schema).await
    }

    pub async fn export_database(
        &self,
        id: &str,
        tables: Option<&[String]>,
    ) -> Result<String, DbError> {
        super::metadata_service::export_database(self, id, tables).await
    }

    pub async fn get_views(
        &self,
        id: &str,
        schema: Option<&str>,
    ) -> Result<Vec<TableInfo>, DbError> {
        super::metadata_service::get_views(self, id, schema).await
    }

    pub async fn get_indexes(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        super::metadata_service::get_indexes(self, id, table, schema).await
    }

    pub async fn get_foreign_keys(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        super::metadata_service::get_foreign_keys(self, id, table, schema).await
    }

    pub async fn get_table_row_count(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        super::metadata_service::get_table_row_count(self, id, table, schema).await
    }

    pub async fn update_table_rows(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        super::metadata_service::update_table_rows(self, id, table, schema, updates, where_conditions).await
    }

    pub async fn insert_table_row(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        super::metadata_service::insert_table_row(self, id, table, schema, values).await
    }

    pub async fn delete_table_rows(
        &self,
        id: &str,
        table: &str,
        schema: Option<&str>,
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        super::metadata_service::delete_table_rows(self, id, table, schema, where_conditions).await
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
        super::metadata_service::get_table_data(self, id, table, schema, page, page_size, order_by).await
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
