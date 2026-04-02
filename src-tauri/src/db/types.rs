use serde::{Deserialize, Serialize};
use thiserror::Error;

fn default_keepalive_interval() -> u64 {
    30
}

fn default_auto_reconnect() -> bool {
    true
}

/// Supported database types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    PostgreSQL,
    MySQL,
    SQLite,
    MSSQL,
    ClickHouse,
    GaussDB,
}

/// SSH tunnel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub private_key: Option<String>,
}

/// Database connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_enabled: bool,
    #[serde(default = "default_keepalive_interval")]
    pub keepalive_interval: u64,
    #[serde(default = "default_auto_reconnect")]
    pub auto_reconnect: bool,
    pub ssh_tunnel: Option<SshTunnelConfig>,
}

/// Column metadata information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

/// Query result with rows and metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub row_count: u64,
    pub execution_time_ms: u64,
}

/// Table metadata information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub schema: Option<String>,
    pub row_count: Option<u64>,
    pub comment: Option<String>,
    pub table_type: String,
}

/// Result of an execute (INSERT/UPDATE/DELETE) operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub rows_affected: u64,
    pub execution_time_ms: u64,
}

/// Database error types
#[derive(Debug, Error)]
pub enum DbError {
    #[error("Connection error: {0}")]
    ConnectionError(String),

    #[error("Query error: {0}")]
    QueryError(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::Configuration(msg) => DbError::ConfigError(msg.to_string()),
            sqlx::Error::Database(db_err) => {
                DbError::QueryError(db_err.message().to_string())
            }
            sqlx::Error::Io(io_err) => DbError::ConnectionError(io_err.to_string()),
            sqlx::Error::Tls(tls_err) => DbError::ConnectionError(tls_err.to_string()),
            sqlx::Error::PoolTimedOut => {
                DbError::ConnectionError("Connection pool timed out".to_string())
            }
            sqlx::Error::PoolClosed => {
                DbError::ConnectionError("Connection pool closed".to_string())
            }
            sqlx::Error::WorkerCrashed => {
                DbError::Internal("Database worker crashed".to_string())
            }
            _ => DbError::QueryError(err.to_string()),
        }
    }
}

impl std::fmt::Display for DatabaseType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DatabaseType::PostgreSQL => write!(f, "postgresql"),
            DatabaseType::MySQL => write!(f, "mysql"),
            DatabaseType::SQLite => write!(f, "sqlite"),
            DatabaseType::MSSQL => write!(f, "mssql"),
            DatabaseType::ClickHouse => write!(f, "clickhouse"),
            DatabaseType::GaussDB => write!(f, "gaussdb"),
        }
    }
}

/// Connection health status reported to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub healthy: bool,
    pub reconnect_count: u32,
    pub last_heartbeat: String,
    pub keepalive_interval: u64,
    pub auto_reconnect: bool,
}
