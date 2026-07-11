#![allow(dead_code)] // Scaffold: items reserved for upcoming features

use serde::{Deserialize, Serialize};
use thiserror::Error;

fn default_keepalive_interval() -> u64 {
    30
}

fn default_auto_reconnect() -> bool {
    true
}

fn default_query_timeout_secs() -> u64 {
    300
}

/// Supported database types
#[derive(Debug, Clone, PartialEq)]
pub enum DatabaseType {
    PostgreSQL,
    MySQL,
    SQLite,
    ClickHouse,
    // 新增：PG 协议兼容
    Kingbase,       // 人大金仓
    Vastbase,       // 海量数据库
    YashanDB,       // 崖山数据库

    // 新增：MySQL 协议兼容
    OceanBase,      // 蚂蚁 OceanBase
    TiDB,           // PingCAP TiDB
    TDSQL,          // 腾讯 TDSQL

    // 新增：ODBC 桥接
    Oracle,         // Oracle
    SQLServer,      // Microsoft SQL Server
    DaMeng,         // 达梦 DM
    GBase,          // 南大通用 GBase 8a/8t

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
            DatabaseType::Kingbase => "kingbase",
            DatabaseType::Vastbase => "vastbase",
            DatabaseType::YashanDB => "yashandb",
            DatabaseType::OceanBase => "oceanbase",
            DatabaseType::TiDB => "tidb",
            DatabaseType::TDSQL => "tdsql",
            DatabaseType::Oracle => "oracle",
            DatabaseType::SQLServer => "sqlserver",
            DatabaseType::DaMeng => "dameng",
            DatabaseType::GBase => "gbase",
            DatabaseType::Plugin(_) => "plugin",
        }
    }

    pub fn category(&self) -> &str {
        match self {
            DatabaseType::PostgreSQL | DatabaseType::MySQL | DatabaseType::SQLite => "开源数据库",
            DatabaseType::ClickHouse => "列存数据库",
            DatabaseType::GaussDB
            | DatabaseType::Kingbase
            | DatabaseType::Vastbase
            | DatabaseType::YashanDB
            | DatabaseType::OceanBase
            | DatabaseType::TiDB
            | DatabaseType::TDSQL
            | DatabaseType::DaMeng
            | DatabaseType::GBase => "国产数据库",
            DatabaseType::Oracle | DatabaseType::SQLServer => "商业数据库",
            DatabaseType::Plugin(_) => "插件",
        }
    }

    pub fn default_port(&self) -> u16 {
        match self {
            DatabaseType::PostgreSQL => 5432,
            DatabaseType::MySQL => 3306,
            DatabaseType::SQLite => 0,
            DatabaseType::ClickHouse => 8123,
            DatabaseType::GaussDB => 8000,
            DatabaseType::Kingbase => 5432,
            DatabaseType::Vastbase => 5432,
            DatabaseType::YashanDB => 1688,
            DatabaseType::OceanBase => 3306,
            DatabaseType::TiDB => 3306,
            DatabaseType::TDSQL => 3306,
            DatabaseType::Oracle => 1521,
            DatabaseType::SQLServer => 1433,
            DatabaseType::DaMeng => 5236,
            DatabaseType::GBase => 5258,
            DatabaseType::Plugin(_) => 0,
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "postgresql" => Some(DatabaseType::PostgreSQL),
            "mysql" => Some(DatabaseType::MySQL),
            "sqlite" => Some(DatabaseType::SQLite),
            "clickhouse" => Some(DatabaseType::ClickHouse),
            "kingbase" => Some(DatabaseType::Kingbase),
            "vastbase" => Some(DatabaseType::Vastbase),
            "yashandb" => Some(DatabaseType::YashanDB),
            "oceanbase" => Some(DatabaseType::OceanBase),
            "tidb" => Some(DatabaseType::TiDB),
            "tdsql" => Some(DatabaseType::TDSQL),
            "oracle" => Some(DatabaseType::Oracle),
            "sqlserver" => Some(DatabaseType::SQLServer),
            "dameng" => Some(DatabaseType::DaMeng),
            "gbase" => Some(DatabaseType::GBase),
            "gaussdb" | "opengauss" => Some(DatabaseType::GaussDB),
            other if other.starts_with("plugin:") => {
                Some(DatabaseType::Plugin(other[7..].to_string()))
            }
            _ => None,
        }
    }
}

/// Describes what a database driver can and cannot do.
/// Sent to the frontend so the UI can conditionally show/hide features.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverCapabilities {
    pub supports_schemas: bool,
    pub supports_manage_tables: bool,
    pub supports_views: bool,
    pub supports_procedures: bool,
    pub supports_triggers: bool,
    pub is_file_based: bool,
    pub supports_indexes: bool,
    pub supports_foreign_keys: bool,
    pub supports_partitions: bool,
    pub supports_cancel: bool,
    pub identifier_quote: String,
    pub default_port: u16,
}

impl Default for DriverCapabilities {
    fn default() -> Self {
        Self {
            supports_schemas: false,
            supports_manage_tables: true,
            supports_views: true,
            supports_procedures: false,
            supports_triggers: false,
            is_file_based: false,
            supports_indexes: true,
            supports_foreign_keys: true,
            supports_partitions: false,
            supports_cancel: false,
            identifier_quote: "\"".to_string(),
            default_port: 5432,
        }
    }
}

impl DatabaseType {
    pub fn capabilities(&self) -> DriverCapabilities {
        /// Build PG-compatible capabilities with double-quote identifiers
        fn pg_caps(partitions: bool, port: u16) -> DriverCapabilities {
            DriverCapabilities {
                supports_schemas: true, supports_manage_tables: true,
                supports_views: true, supports_procedures: true,
                supports_triggers: true, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: partitions, supports_cancel: true,
                identifier_quote: "\"".to_string(), default_port: port,
            }
        }
        /// Build MySQL-compatible capabilities with backtick identifiers
        fn mysql_caps(partitions: bool, port: u16) -> DriverCapabilities {
            DriverCapabilities {
                supports_schemas: false, supports_manage_tables: true,
                supports_views: true, supports_procedures: true,
                supports_triggers: true, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: partitions, supports_cancel: true,
                identifier_quote: "`".to_string(), default_port: port,
            }
        }

        match self {
            DatabaseType::PostgreSQL     => pg_caps(true,  self.default_port()),
            DatabaseType::GaussDB        => pg_caps(true,  self.default_port()),
            DatabaseType::Kingbase       => pg_caps(true,  self.default_port()),
            DatabaseType::Vastbase       => pg_caps(true,  self.default_port()),
            DatabaseType::YashanDB       => pg_caps(false, self.default_port()),
            DatabaseType::MySQL          => mysql_caps(false, self.default_port()),
            DatabaseType::OceanBase      => mysql_caps(false, self.default_port()),
            DatabaseType::TiDB           => mysql_caps(true,  self.default_port()),
            DatabaseType::TDSQL          => mysql_caps(false, self.default_port()),
            // File-based
            DatabaseType::SQLite => DriverCapabilities {
                supports_schemas: false, supports_manage_tables: true,
                supports_views: true, supports_procedures: false,
                supports_triggers: true, is_file_based: true,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: false, supports_cancel: false,
                identifier_quote: "\"".to_string(), default_port: self.default_port(),
            },
            // Column-store
            DatabaseType::ClickHouse => DriverCapabilities {
                supports_schemas: false, supports_manage_tables: true,
                supports_views: true, supports_procedures: false,
                supports_triggers: false, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: false,
                supports_partitions: false, supports_cancel: true,
                identifier_quote: "`".to_string(), default_port: self.default_port(),
            },
            // ODBC bridge group
            DatabaseType::Oracle => DriverCapabilities {
                supports_schemas: true, supports_manage_tables: true,
                supports_views: true, supports_procedures: true,
                supports_triggers: true, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: true, supports_cancel: false,
                identifier_quote: "\"".to_string(), default_port: self.default_port(),
            },
            DatabaseType::SQLServer => DriverCapabilities {
                supports_schemas: true, supports_manage_tables: true,
                supports_views: true, supports_procedures: true,
                supports_triggers: true, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: true, supports_cancel: false,
                identifier_quote: "[".to_string(), default_port: self.default_port(),
            },
            DatabaseType::DaMeng => DriverCapabilities {
                supports_schemas: true, supports_manage_tables: true,
                supports_views: true, supports_procedures: true,
                supports_triggers: true, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: true, supports_cancel: false,
                identifier_quote: "\"".to_string(), default_port: self.default_port(),
            },
            DatabaseType::GBase => DriverCapabilities {
                supports_schemas: true, supports_manage_tables: true,
                supports_views: true, supports_procedures: true,
                supports_triggers: true, is_file_based: false,
                supports_indexes: true, supports_foreign_keys: true,
                supports_partitions: false, supports_cancel: false,
                identifier_quote: "\"".to_string(), default_port: self.default_port(),
            },
            // Plugin: use defaults
            DatabaseType::Plugin(_) => DriverCapabilities::default(),
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
            "kingbase" => DatabaseType::Kingbase,
            "vastbase" => DatabaseType::Vastbase,
            "yashandb" => DatabaseType::YashanDB,
            "oceanbase" => DatabaseType::OceanBase,
            "tidb" => DatabaseType::TiDB,
            "tdsql" => DatabaseType::TDSQL,
            "oracle" => DatabaseType::Oracle,
            "sqlserver" => DatabaseType::SQLServer,
            "dameng" => DatabaseType::DaMeng,
            "gbase" => DatabaseType::GBase,
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

/// Optional connection-pool overrides supplied by the user via the
/// connection dialog. Any field left as `None` falls back to the
/// per-database default returned by `pool_config_for`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PoolOptions {
    pub max_connections: Option<u32>,
    pub idle_timeout_secs: Option<u64>,
    pub max_lifetime_secs: Option<u64>,
    pub acquire_timeout_secs: Option<u64>,
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
    /// Hard timeout for user-initiated queries, in seconds. 0 = unlimited.
    /// Metadata queries keep their own fixed 60s limit.
    #[serde(default = "default_query_timeout_secs")]
    pub query_timeout_secs: u64,
    pub ssh_tunnel: Option<SshTunnelConfig>,
    #[serde(default)]
    pub pool_options: Option<PoolOptions>,
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

// ============================================================================
// Wire (IPC) result types
// ============================================================================
//
// Internal QueryResult keeps object-shaped rows because driver metadata code
// reads cells by column name. At the IPC boundary rows are converted to
// positional arrays (aligned with `columns`) so column names are sent ONCE
// instead of once per row — roughly halving the JSON payload for wide results.
// The frontend `mapRawQueryResult` already accepts both shapes.

/// Query result serialized for the IPC boundary: rows are positional arrays.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: u64,
    pub execution_time_ms: u64,
}

/// Paged query result serialized for the IPC boundary: rows are positional arrays.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePagedQueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: u64,
    pub execution_time_ms: u64,
    pub has_more: bool,
}

/// Convert object rows to positional arrays following `columns` order.
/// Cells missing from a row map (shouldn't happen, but defensive) become null.
fn rows_to_wire(
    columns: &[ColumnInfo],
    rows: Vec<serde_json::Map<String, serde_json::Value>>,
) -> Vec<Vec<serde_json::Value>> {
    rows.into_iter()
        .map(|mut row| {
            columns
                .iter()
                .map(|c| row.remove(&c.name).unwrap_or(serde_json::Value::Null))
                .collect()
        })
        .collect()
}

impl From<QueryResult> for WireQueryResult {
    fn from(r: QueryResult) -> Self {
        let rows = rows_to_wire(&r.columns, r.rows);
        WireQueryResult {
            columns: r.columns,
            rows,
            row_count: r.row_count,
            execution_time_ms: r.execution_time_ms,
        }
    }
}

impl From<PagedQueryResult> for WirePagedQueryResult {
    fn from(r: PagedQueryResult) -> Self {
        let rows = rows_to_wire(&r.columns, r.rows);
        WirePagedQueryResult {
            columns: r.columns,
            rows,
            row_count: r.row_count,
            execution_time_ms: r.execution_time_ms,
            has_more: r.has_more,
        }
    }
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

/// Structured WHERE condition used by row-level UPDATE/DELETE on the data grid.
///
/// SECURITY: this type intentionally replaces the previous "WHERE clause string"
/// API to eliminate SQL injection. Multiple conditions are AND-joined with
/// equality semantics (`col = value`, or `col IS NULL` when value is null).
/// Arbitrary boolean expressions, OR / subqueries / function calls cannot be
/// expressed and therefore cannot be smuggled through the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhereCondition {
    pub column: String,
    pub value: serde_json::Value,
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
            DatabaseType::Kingbase => write!(f, "kingbase"),
            DatabaseType::Vastbase => write!(f, "vastbase"),
            DatabaseType::YashanDB => write!(f, "yashandb"),
            DatabaseType::OceanBase => write!(f, "oceanbase"),
            DatabaseType::TiDB => write!(f, "tidb"),
            DatabaseType::TDSQL => write!(f, "tdsql"),
            DatabaseType::Oracle => write!(f, "oracle"),
            DatabaseType::SQLServer => write!(f, "sqlserver"),
            DatabaseType::DaMeng => write!(f, "dameng"),
            DatabaseType::GBase => write!(f, "gbase"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: "text".to_string(),
            nullable: true,
            is_primary_key: false,
            default_value: None,
            comment: None,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        }
    }

    fn obj_row(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn wire_rows_follow_column_order() {
        let result = QueryResult {
            columns: vec![col("id"), col("name")],
            rows: vec![
                // Map iteration order differs from column order — conversion must align.
                obj_row(&[("name", json!("alice")), ("id", json!(1))]),
                obj_row(&[("id", json!(2)), ("name", json!("bob"))]),
            ],
            row_count: 2,
            execution_time_ms: 5,
        };
        let wire = WireQueryResult::from(result);
        assert_eq!(wire.rows, vec![
            vec![json!(1), json!("alice")],
            vec![json!(2), json!("bob")],
        ]);
        assert_eq!(wire.row_count, 2);
    }

    #[test]
    fn wire_rows_missing_cell_becomes_null() {
        let result = QueryResult {
            columns: vec![col("a"), col("b")],
            rows: vec![obj_row(&[("a", json!(true))])],
            row_count: 1,
            execution_time_ms: 0,
        };
        let wire = WireQueryResult::from(result);
        assert_eq!(wire.rows, vec![vec![json!(true), serde_json::Value::Null]]);
    }

    #[test]
    fn wire_serialization_has_no_per_row_column_names() {
        let result = PagedQueryResult {
            columns: vec![col("very_long_column_name")],
            rows: vec![obj_row(&[("very_long_column_name", json!(42))]); 3],
            row_count: 3,
            execution_time_ms: 0,
            has_more: false,
        };
        let wire = WirePagedQueryResult::from(result);
        let json = serde_json::to_string(&wire).unwrap();
        // Column name must appear exactly once (in `columns`), not once per row.
        assert_eq!(json.matches("very_long_column_name").count(), 1);
        assert!(json.contains("\"rows\":[[42],[42],[42]]"));
    }
}
