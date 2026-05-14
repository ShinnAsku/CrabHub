use serde::{Deserialize, Serialize};
use thiserror::Error;

fn default_keepalive_interval() -> u64 {
    30
}

fn default_auto_reconnect() -> bool {
    true
}

/// Supported database types
#[derive(Debug, Clone, PartialEq)]
pub enum DatabaseType {
    PostgreSQL,
    MySQL,
    SQLite,
    ClickHouse,
    GaussDB,
    Plugin(String),
}

impl DatabaseType {
    pub fn is_plugin(&self) -> bool {
        matches!(self, DatabaseType::Plugin(_))
    }

    pub fn plugin_id(&self) -> Option<&str> {
        match self {
            DatabaseType::Plugin(id) => Some(id.as_str()),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            DatabaseType::PostgreSQL => "postgresql",
            DatabaseType::MySQL => "mysql",
            DatabaseType::SQLite => "sqlite",
            DatabaseType::ClickHouse => "clickhouse",
            DatabaseType::GaussDB => "gaussdb",
            DatabaseType::Plugin(_) => "plugin",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "postgresql" => Some(DatabaseType::PostgreSQL),
            "mysql" => Some(DatabaseType::MySQL),
            "sqlite" => Some(DatabaseType::SQLite),
            "clickhouse" => Some(DatabaseType::ClickHouse),
            "gaussdb" | "opengauss" => Some(DatabaseType::GaussDB),
            other if other.starts_with("plugin:") => {
                Some(DatabaseType::Plugin(other[7..].to_string()))
            }
            _ => None,
        }
    }
}

impl Serialize for DatabaseType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            DatabaseType::Plugin(id) => serializer.serialize_str(&format!("plugin:{}", id)),
            other => serializer.serialize_str(&other.to_string()),
        }
    }
}

impl<'de> Deserialize<'de> for DatabaseType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "postgresql" => DatabaseType::PostgreSQL,
            "mysql" => DatabaseType::MySQL,
            "sqlite" => DatabaseType::SQLite,
            "clickhouse" => DatabaseType::ClickHouse,
            "gaussdb" | "opengauss" => DatabaseType::GaussDB,
            other if other.starts_with("plugin:") => {
                DatabaseType::Plugin(other[7..].to_string())
            }
            other => return Err(serde::de::Error::custom(format!("unknown database type: {}", other))),
        })
    }
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
    pub character_maximum_length: Option<i64>,
    pub numeric_precision: Option<i64>,
    pub numeric_scale: Option<i64>,
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

/// Paged query result with has_more indicator for progressive loading
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedQueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub row_count: u64,
    pub execution_time_ms: u64,
    pub has_more: bool,
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
    // Extended metadata (primarily for PostgreSQL)
    pub oid: Option<i64>,
    pub owner: Option<String>,
    pub acl: Option<String>,
    pub primary_key: Option<String>,
    pub partition_of: Option<String>,
    pub has_indexes: Option<bool>,
    pub has_triggers: Option<bool>,
    // Extended metadata (primarily for MySQL)
    pub engine: Option<String>,
    pub data_length: Option<i64>,
    pub create_time: Option<String>,
    pub update_time: Option<String>,
    pub collation: Option<String>,
}

/// Result of an execute (INSERT/UPDATE/DELETE) operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub rows_affected: u64,
    pub execution_time_ms: u64,
}

/// Database error types with structured error codes for frontend handling
#[derive(Debug, Error)]
pub enum DbError {
    #[error("[DB-E001] Connection error: {0}")]
    ConnectionError(String),

    #[error("[DB-E002] Query error: {0}")]
    QueryError(String),

    #[error("[DB-E003] Configuration error: {0}")]
    ConfigError(String),

    #[error("[DB-E004] Not found: {0}")]
    NotFound(String),

    #[error("[DB-E005] Internal error: {0}")]
    Internal(String),

    #[error("[DB-E006] Timeout: {0}")]
    Timeout(String),

    #[error("[DB-E007] Permission denied: {0}")]
    PermissionDenied(String),
}

impl DbError {
    /// Machine-readable error code for frontend matching
    pub fn code(&self) -> &str {
        match self {
            DbError::ConnectionError(_) => "DB-E001",
            DbError::QueryError(_) => "DB-E002",
            DbError::ConfigError(_) => "DB-E003",
            DbError::NotFound(_) => "DB-E004",
            DbError::Internal(_) => "DB-E005",
            DbError::Timeout(_) => "DB-E006",
            DbError::PermissionDenied(_) => "DB-E007",
        }
    }
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
            DatabaseType::ClickHouse => write!(f, "clickhouse"),
            DatabaseType::GaussDB => write!(f, "gaussdb"),
            DatabaseType::Plugin(id) => write!(f, "plugin:{}", id),
        }
    }
}

/// Result returned after a successful database connection, including auto-detected type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub connection_id: String,
    pub detected_type: DatabaseType,
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
