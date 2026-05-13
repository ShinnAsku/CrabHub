use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::clickhouse::ClickHouseConnection;
use super::gaussdb::GaussDBConnection;
use super::mysql::MySqlConnection;
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
    last_heartbeat: Instant,
    is_healthy: bool,
    reconnect_count: u32,
}

/// Manages multiple database connections
pub struct ConnectionManager {
    connections: RwLock<HashMap<String, ConnectionEntry>>,
    plugin_manager: std::sync::Mutex<Option<Arc<PluginManager>>>,
}

impl ConnectionManager {
    /// Create a new connection manager
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            plugin_manager: std::sync::Mutex::new(None),
        }
    }

    /// Inject the plugin manager (called during app setup)
    pub fn set_plugin_manager(&self, pm: Arc<PluginManager>) {
        *self.plugin_manager.lock().unwrap() = Some(pm);
    }

    fn get_plugin_manager(&self) -> Option<Arc<PluginManager>> {
        self.plugin_manager.lock().unwrap().clone()
    }

    /// Start the background heartbeat loop
    pub async fn start_heartbeat(manager: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            let connection_infos: Vec<(String, bool, bool)> = {
                let connections = manager.connections.read().await;
                connections
                    .iter()
                    .map(|(id, entry)| {
                        (
                            id.clone(),
                            entry.config.keepalive_interval == 0,
                            entry.config.auto_reconnect,
                        )
                    })
                    .collect()
            };

            for (id, skip_keepalive, auto_reconnect) in &connection_infos {
                if *skip_keepalive {
                    continue;
                }

                let result = {
                    let connections = manager.connections.read().await;
                    if let Some(entry) = connections.get(id) {
                        entry.connection.query_sql("SELECT 1").await
                    } else {
                        continue;
                    }
                };

                match result {
                    Ok(_) => {
                        log::debug!("Heartbeat OK for connection '{}'", id);
                        let mut conns = manager.connections.write().await;
                        if let Some(e) = conns.get_mut(id) {
                            e.last_heartbeat = Instant::now();
                            e.is_healthy = true;
                        }
                    }
                    Err(e) => {
                        log::warn!("Heartbeat failed for connection '{}': {}", id, e);
                        {
                            let mut conns = manager.connections.write().await;
                            if let Some(e) = conns.get_mut(id) {
                                e.is_healthy = false;
                            }
                        }
                        if *auto_reconnect {
                            let _ = manager.reconnect(id).await;
                        }
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
                Ok(Box::new(GaussDBConnection::new(config).await?))
            }
            DatabaseType::MySQL => Ok(Box::new(MySqlConnection::new(config).await?)),
            DatabaseType::SQLite => Ok(Box::new(SQLiteConnection::new(config).await?)),
            DatabaseType::ClickHouse => {
                Ok(Box::new(ClickHouseConnection::new(config).await?))
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
            last_heartbeat: Instant::now(),
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

    /// Disconnect from a database
    pub async fn disconnect(&self, id: &str) -> Result<(), DbError> {
        let mut connections = self.connections.write().await;
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

    /// Execute a SQL query with auto-reconnect
    pub async fn query(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
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

    async fn execute_inner(&self, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.execute_sql(sql).await
    }

    async fn query_inner(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.query_sql(sql).await
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

        // Inject LIMIT+1 to detect whether more rows exist
        let db_type = entry.connection.db_type();
        let modified_sql =
            sql_limiter::inject_limit_offset(sql, &db_type, limit + 1, offset);
        let mut result = entry.connection.query_sql(&modified_sql).await?;

        let has_more = result.rows.len() as u64 > limit;
        if has_more {
            result.rows.truncate(limit as usize);
        }

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

        let old_conn = {
            let mut connections = self.connections.write().await;
            connections
                .get_mut(id)
                .map(|e| std::mem::replace(&mut e.connection, Box::new(DummyConnection)))
        };

        if let Some(old) = old_conn {
            old.close().await;
        }

        let pm = self.get_plugin_manager();
        match Self::create_connection_async(&config, pm.as_deref()).await {
            Ok(new_conn) => {
                let mut connections = self.connections.write().await;
                if let Some(entry) = connections.get_mut(id) {
                    entry.connection = new_conn;
                    entry.last_heartbeat = Instant::now();
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

    /// Get connection health status
    pub async fn get_connection_status(&self, id: &str) -> Result<ConnectionStatus, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;

        let elapsed = entry.last_heartbeat.elapsed();
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
