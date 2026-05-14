use async_trait::async_trait;
use rust_decimal::Decimal;
use sqlx::{Column, Row, TypeInfo};
use std::time::{Duration, Instant};

use super::trait_def::{json_value_to_sql, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

// ============================================================================
// PostgreSQL Connection
// ============================================================================

pub struct PostgresConnection {
    pool: sqlx::PgPool,
    #[allow(dead_code)]
    db_type_label: DatabaseType,
}

impl PostgresConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        use urlencoding::encode;

        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(5432);
        let username = config.username.as_deref().unwrap_or("postgres");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");

        let ssl_mode = if config.ssl_enabled {
            "require"
        } else {
            "prefer"
        };

        let connection_string = if password.is_empty() {
            if database.is_empty() {
                format!(
                    "postgres://{}@{}:{}?sslmode={}",
                    encode(username),
                    host,
                    port,
                    ssl_mode
                )
            } else {
                format!(
                    "postgres://{}@{}:{}/{}?sslmode={}",
                    encode(username),
                    host,
                    port,
                    encode(database),
                    ssl_mode
                )
            }
        } else {
            if database.is_empty() {
                format!(
                    "postgres://{}:{}@{}:{}?sslmode={}",
                    encode(username),
                    encode(password),
                    host,
                    port,
                    ssl_mode
                )
            } else {
                format!(
                    "postgres://{}:{}@{}:{}/{}?sslmode={}",
                    encode(username),
                    encode(password),
                    host,
                    port,
                    encode(database),
                    ssl_mode
                )
            }
        };

        log::info!("Connecting to PostgreSQL at {}:{}", host, port);

        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .idle_timeout(Duration::from_secs(600))
            .max_lifetime(Duration::from_secs(1800))
            .acquire_timeout(Duration::from_secs(10))
            .connect(&connection_string)
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to PostgreSQL: {}", e))
            })?;

        log::info!("Successfully connected to PostgreSQL");

        Ok(Self {
            pool,
            db_type_label: config.db_type.clone(),
        })
    }
}

/// Build full table reference for PostgreSQL
fn pg_full_table(table: &str, schema: Option<&str>) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", s, table),
        _ => table.to_string(),
    }
}

fn pg_full_table_quoted(table: &str, schema: Option<&str>) -> String {
    let tbl = format!("\"{}\"", table.replace('"', "\"\""));
    match schema {
        Some(s) if !s.is_empty() => format!("\"{}\".{}", s.replace('"', "\"\""), tbl),
        _ => tbl,
    }
}

#[async_trait]
impl DatabaseConnection for PostgresConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = Instant::now();
        let result = sqlx::query(sql)
            .execute(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(ExecuteResult {
            rows_affected: result.rows_affected(),
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = Instant::now();

        let result = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let elapsed = start.elapsed().as_millis() as u64;

        if result.is_empty() {
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                execution_time_ms: elapsed,
            });
        }

        let columns = build_columns_from_pg_row(&result[0]);

        let mut result_rows = Vec::new();
        for row in &result {
            let mut map = serde_json::Map::new();
            for col in row.columns() {
                let name = col.name().to_string();
                let type_name = col.type_info().name();
                let value = match type_name {
                    "BOOL" => {
                        if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(col.name()) {
                            serde_json::Value::Bool(v)
                        } else if let Ok(v) = row.try_get::<bool, _>(col.name()) {
                            serde_json::Value::Bool(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INT2" => {
                        if let Ok(Some(v)) = row.try_get::<Option<i16>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<i16, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INT4" | "OID" => {
                        if let Ok(Some(v)) = row.try_get::<Option<i32>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<i32, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INT8" => {
                        if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<i64, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "FLOAT4" => {
                        if let Ok(Some(v)) = row.try_get::<Option<f32>, _>(col.name()) {
                            serde_json::Value::from(v as f64)
                        } else if let Ok(v) = row.try_get::<f32, _>(col.name()) {
                            serde_json::Value::from(v as f64)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "FLOAT8" => {
                        if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(col.name()) {
                            serde_json::Value::from(v)
                        } else if let Ok(v) = row.try_get::<f64, _>(col.name()) {
                            serde_json::Value::from(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "NUMERIC" | "MONEY" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Decimal>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<Decimal, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<i64, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "XML" => {
                        if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "UUID" => {
                        if let Ok(Some(v)) = row.try_get::<Option<uuid::Uuid>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<uuid::Uuid, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "DATE" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<chrono::NaiveDate>, _>(col.name())
                        {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TIME" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<chrono::NaiveTime>, _>(col.name())
                        {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TIMETZ" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<sqlx::postgres::types::PgTimeTz>, _>(col.name())
                        {
                            serde_json::Value::String(format!("{}{}", v.time, v.offset))
                        } else if let Ok(v) =
                            row.try_get::<sqlx::postgres::types::PgTimeTz, _>(col.name())
                        {
                            serde_json::Value::String(format!("{}{}", v.time, v.offset))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TIMESTAMP" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<chrono::NaiveDateTime>, _>(col.name())
                        {
                            serde_json::Value::String(
                                v.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
                            )
                        } else if let Ok(v) =
                            row.try_get::<chrono::NaiveDateTime, _>(col.name())
                        {
                            serde_json::Value::String(
                                v.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
                            )
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TIMESTAMPTZ" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col.name())
                        {
                            serde_json::Value::String(
                                v.format("%Y-%m-%d %H:%M:%S%.f%z").to_string(),
                            )
                        } else if let Ok(v) =
                            row.try_get::<chrono::DateTime<chrono::Utc>, _>(col.name())
                        {
                            serde_json::Value::String(
                                v.format("%Y-%m-%d %H:%M:%S%.f%z").to_string(),
                            )
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INTERVAL" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<sqlx::postgres::types::PgInterval>, _>(col.name())
                        {
                            serde_json::Value::String(format_pg_interval(&v))
                        } else if let Ok(v) =
                            row.try_get::<sqlx::postgres::types::PgInterval, _>(col.name())
                        {
                            serde_json::Value::String(format_pg_interval(&v))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "JSON" | "JSONB" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<sqlx::types::Json<serde_json::Value>>, _>(
                                col.name(),
                            )
                        {
                            v.0
                        } else if let Ok(v) =
                            row.try_get::<sqlx::types::Json<serde_json::Value>, _>(col.name())
                        {
                            v.0
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "BYTEA" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02x}", b)).collect();
                            serde_json::Value::String(format!("\\x{}", hex_str))
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02x}", b)).collect();
                            serde_json::Value::String(format!("\\x{}", hex_str))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INET" | "CIDR" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<ipnetwork::IpNetwork>, _>(col.name())
                        {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) =
                            row.try_get::<ipnetwork::IpNetwork, _>(col.name())
                        {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "MACADDR" | "MACADDR8" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<mac_address::MacAddress>, _>(col.name())
                        {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) =
                            row.try_get::<mac_address::MacAddress, _>(col.name())
                        {
                            serde_json::Value::String(v.to_string())
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "POINT" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            if v.len() == 16 {
                                let x = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let y = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!("({},{})", x, y))
                            } else {
                                serde_json::Value::Null
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            if v.len() == 16 {
                                let x = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let y = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!("({},{})", x, y))
                            } else {
                                serde_json::Value::Null
                            }
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "CIRCLE" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            if v.len() == 24 {
                                let cx = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let cy = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let r = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!("<({},{}),{}>", cx, cy, r))
                            } else {
                                serde_json::Value::Null
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            if v.len() == 24 {
                                let cx = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let cy = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let r = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!("<({},{}),{}>", cx, cy, r))
                            } else {
                                serde_json::Value::Null
                            }
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "LINE" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            if v.len() == 24 {
                                let a = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let b = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let c = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!("{{{},{},{}}}", a, b, c))
                            } else {
                                serde_json::Value::Null
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            if v.len() == 24 {
                                let a = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let b = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let c = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!("{{{},{},{}}}", a, b, c))
                            } else {
                                serde_json::Value::Null
                            }
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "LSEG" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            if v.len() == 32 {
                                let x1 = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let y1 = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let x2 = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                let y2 = f64::from_be_bytes(
                                    v[24..32].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!(
                                    "[({},{}),({},{})]",
                                    x1, y1, x2, y2
                                ))
                            } else {
                                serde_json::Value::Null
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            if v.len() == 32 {
                                let x1 = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let y1 = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let x2 = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                let y2 = f64::from_be_bytes(
                                    v[24..32].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!(
                                    "[({},{}),({},{})]",
                                    x1, y1, x2, y2
                                ))
                            } else {
                                serde_json::Value::Null
                            }
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "BOX" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            if v.len() == 32 {
                                let x1 = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let y1 = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let x2 = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                let y2 = f64::from_be_bytes(
                                    v[24..32].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!(
                                    "(({},{}),({},{}))",
                                    x1, y1, x2, y2
                                ))
                            } else {
                                serde_json::Value::Null
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            if v.len() == 32 {
                                let x1 = f64::from_be_bytes(
                                    v[0..8].try_into().unwrap_or([0u8; 8]),
                                );
                                let y1 = f64::from_be_bytes(
                                    v[8..16].try_into().unwrap_or([0u8; 8]),
                                );
                                let x2 = f64::from_be_bytes(
                                    v[16..24].try_into().unwrap_or([0u8; 8]),
                                );
                                let y2 = f64::from_be_bytes(
                                    v[24..32].try_into().unwrap_or([0u8; 8]),
                                );
                                serde_json::Value::String(format!(
                                    "(({},{}),({},{}))",
                                    x1, y1, x2, y2
                                ))
                            } else {
                                serde_json::Value::Null
                            }
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "PATH" | "POLYGON" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02x}", b)).collect();
                            serde_json::Value::String(hex_str)
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02x}", b)).collect();
                            serde_json::Value::String(hex_str)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    // Array types
                    "BOOL[]" | "_BOOL" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<bool>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|b| b.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<bool>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|b| b.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INT2[]" | "_INT2" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<i16>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|i| i.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<i16>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|i| i.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INT4[]" | "_INT4" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<i32>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|i| i.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<i32>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|i| i.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "INT8[]" | "_INT8" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<i64>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|i| i.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<i64>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|i| i.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "FLOAT4[]" | "_FLOAT4" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<f32>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|f| f.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<f32>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|f| f.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "FLOAT8[]" | "_FLOAT8" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<f64>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|f| f.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<f64>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|f| f.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TEXT[]" | "_TEXT" | "VARCHAR[]" | "_VARCHAR" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<String>>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|s| format!("\"{}\"", s))
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<String>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|s| format!("\"{}\"", s))
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "UUID[]" | "_UUID" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<Vec<uuid::Uuid>>, _>(col.name())
                        {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|u| u.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else if let Ok(v) = row.try_get::<Vec<uuid::Uuid>, _>(col.name()) {
                            serde_json::Value::String(format!(
                                "{{{}}}",
                                v.iter()
                                    .map(|u| u.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    _ => {
                        // Try string first (covers most remaining types)
                        if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name())
                        {
                            serde_json::Value::String(
                                String::from_utf8_lossy(&v).to_string(),
                            )
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            serde_json::Value::String(
                                String::from_utf8_lossy(&v).to_string(),
                            )
                        } else {
                            serde_json::Value::Null
                        }
                    }
                };
                map.insert(name, value);
            }
            result_rows.push(map);
        }

        let row_count = result_rows.len() as u64;

        Ok(QueryResult {
            columns,
            rows: result_rows,
            row_count,
            execution_time_ms: elapsed,
        })
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = r#"
            SELECT
                c.oid::bigint AS oid,
                c.relname AS table_name,
                n.nspname AS table_schema,
                r.rolname AS owner,
                CASE c.relkind
                    WHEN 'r' THEN 'TABLE'
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'MATERIALIZED VIEW'
                    WHEN 'p' THEN 'PARTITIONED TABLE'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                    ELSE 'TABLE'
                END AS table_type,
                obj_description(c.oid, 'pg_class') AS table_comment,
                c.reltuples::bigint AS row_count,
                c.relhasindex AS has_indexes,
                c.relhastriggers AS has_triggers,
                pg_catalog.array_to_string(c.relacl, E'\n') AS acl,
                (
                    SELECT string_agg(a.attname, ', ' ORDER BY array_position(ix.indkey, a.attnum))
                    FROM pg_index ix
                    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
                    WHERE ix.indrelid = c.oid AND ix.indisprimary
                ) AS primary_key,
                (
                    SELECT p.relname
                    FROM pg_inherits inh
                    JOIN pg_class p ON p.oid = inh.inhparent
                    WHERE inh.inhrelid = c.oid
                    LIMIT 1
                ) AS partition_of
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
            ORDER BY n.nspname, c.relname
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let oid: Option<i64> = row.try_get("oid").ok();
                let row_count_raw: Option<i64> = row.try_get("row_count").ok();
                let row_count =
                    row_count_raw.and_then(|v| if v >= 0 { Some(v as u64) } else { None });
                TableInfo {
                    name: row.get("table_name"),
                    schema: row.get("table_schema"),
                    row_count,
                    comment: row.try_get("table_comment").ok().flatten(),
                    table_type: row
                        .try_get::<String, _>("table_type")
                        .unwrap_or_else(|_| "TABLE".to_string()),
                    oid,
                    owner: row.try_get("owner").ok().flatten(),
                    acl: row.try_get("acl").ok().flatten(),
                    primary_key: row.try_get("primary_key").ok().flatten(),
                    partition_of: row.try_get("partition_of").ok().flatten(),
                    has_indexes: row.try_get("has_indexes").ok(),
                    has_triggers: row.try_get("has_triggers").ok(),
                    engine: None,
                    data_length: None,
                    create_time: None,
                    update_time: None,
                    collation: None,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("public");

        let sql = r#"
            SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                col_description(cls.oid, c.ordinal_position) as column_comment,
                CASE
                    WHEN pk.column_name IS NOT NULL THEN true
                    ELSE false
                END as is_primary_key,
                c.character_maximum_length,
                c.numeric_precision::bigint as numeric_precision,
                c.numeric_scale::bigint as numeric_scale
            FROM information_schema.columns c
            LEFT JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name
            LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = c.table_schema
            LEFT JOIN (
                SELECT
                    kcu.table_schema,
                    kcu.table_name,
                    kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk ON pk.table_schema = c.table_schema
                AND pk.table_name = c.table_name
                AND pk.column_name = c.column_name
            WHERE c.table_name = $1 AND c.table_schema = $2
            ORDER BY c.ordinal_position
        "#;

        let rows = sqlx::query(sql)
            .bind(table)
            .bind(schema_name)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let columns = rows
            .iter()
            .map(|row| {
                let is_nullable: String = row.get("is_nullable");
                let char_max_len: Option<i32> = row.get("character_maximum_length");
                let num_precision: Option<i64> = row.get("numeric_precision");
                let num_scale: Option<i64> = row.get("numeric_scale");
                ColumnInfo {
                    name: row.get("column_name"),
                    data_type: row.get("data_type"),
                    nullable: is_nullable == "YES",
                    is_primary_key: row.get("is_primary_key"),
                    default_value: row.get("column_default"),
                    comment: row.get("column_comment"),
                    character_maximum_length: char_max_len.map(|v| v as i64),
                    numeric_precision: num_precision,
                    numeric_scale: num_scale,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = r#"
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let schemas = rows.iter().map(|row| row.get::<String, _>(0)).collect();
        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        self.db_type_label.clone()
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_name = $1 AND table_schema = $2 \
             ORDER BY ordinal_position"
        );
        let rows = sqlx::query(&sql)
            .bind(table)
            .bind(schema_name)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let col_defs: Vec<String> = rows
            .iter()
            .map(|row| {
                let name: String = row.get("column_name");
                let data_type: String = row.get("data_type");
                let is_nullable: String = row.get("is_nullable");
                let default: Option<String> = row.get("column_default");
                let null_str = if is_nullable == "YES" {
                    ""
                } else {
                    " NOT NULL"
                };
                let default_str = match default {
                    Some(d) => format!(" DEFAULT {}", d),
                    None => String::new(),
                };
                format!("    {} {}{}{}", name, data_type, null_str, default_str)
            })
            .collect();

        let full_table = if schema_name == "public" {
            table.to_string()
        } else {
            format!("{}.{}", schema_name, table)
        };

        Ok(format!(
            "-- Table: {}\nCREATE TABLE IF NOT EXISTS {} (\n{}\n);\n",
            full_table,
            full_table,
            col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let schema_filter = match schema {
            Some(s) => format!("AND table_schema = '{}'", s.replace('\'', "''")),
            None => String::new(),
        };
        let sql = format!(
            "SELECT table_name, table_schema, NULL::text as table_comment, 'VIEW' as table_type \
             FROM information_schema.views \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             {} ORDER BY table_schema, table_name",
            schema_filter
        );
        let rows = self.query_sql(&sql).await?;
        let views = rows
            .rows
            .iter()
            .map(|row| TableInfo {
                name: row
                    .get("table_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                schema: row
                    .get("table_schema")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                row_count: None,
                comment: None,
                table_type: "VIEW".to_string(),
                oid: None,
                owner: None,
                acl: None,
                primary_key: None,
                partition_of: None,
                has_indexes: None,
                has_triggers: None,
                engine: None,
                data_length: None,
                create_time: None,
                update_time: None,
                collation: None,
            })
            .collect();
        Ok(views)
    }

    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            "SELECT index_name, is_unique, is_primary, column_names FROM (\
                SELECT i.relname as index_name, ix.indisunique as is_unique, \
                ix.indisprimary as is_primary, \
                array_to_string(array_agg(a.attname), ', ') as column_names \
                FROM pg_class t JOIN pg_index ix ON t.oid = ix.indrelid \
                JOIN pg_class i ON i.oid = ix.indexrelid \
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
                JOIN pg_namespace n ON n.oid = t.relnamespace \
                WHERE t.relname = '{}' AND n.nspname = '{}' \
                GROUP BY i.relname, ix.indisunique, ix.indisprimary\
            ) sub ORDER BY index_name",
            table.replace('\'', "''"),
            schema_name.replace('\'', "''")
        );
        let rows = self.query_sql(&sql).await?;
        Ok(rows
            .rows
            .into_iter()
            .map(|m| serde_json::Value::Object(m))
            .collect())
    }

    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            r#"
            SELECT
                tc.constraint_name,
                kcu.column_name,
                ccu.table_schema as foreign_table_schema,
                ccu.table_name as foreign_table_name,
                ccu.column_name as foreign_column_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '{}' AND tc.table_schema = '{}'
            "#,
            table.replace('\'', "''"),
            schema_name.replace('\'', "''")
        );
        let rows = self.query_sql(&sql).await?;
        Ok(rows
            .rows
            .into_iter()
            .map(|m| serde_json::Value::Object(m))
            .collect())
    }

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let full_table = pg_full_table(table, schema);
        let sql = format!("SELECT COUNT(*) as cnt FROM {}", full_table);
        let rows = self.query_sql(&sql).await?;
        if let Some(row) = rows.rows.first() {
            if let Some(cnt) = row
                .get("cnt")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
            {
                return Ok(cnt);
            }
        }
        Ok(0)
    }

    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let full_table = pg_full_table(table, schema);
        let order_clause = order_by
            .map(|o| format!(" ORDER BY {}", o))
            .unwrap_or_default();
        let offset = (page - 1) * page_size;
        let sql = format!(
            "SELECT * FROM {}{} LIMIT {} OFFSET {}",
            full_table, order_clause, page_size, offset
        );
        let mut result = self.query_sql(&sql).await?;
        if result.columns.is_empty() {
            result.columns = self.get_columns(table, schema).await.unwrap_or_default();
        }
        Ok(result)
    }

    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        use crate::db::trait_def::{escape_identifier, sanitize_where_clause};
        use crate::db::types::DatabaseType;
        sanitize_where_clause(where_clause)
            .map_err(|e| DbError::QueryError(e))?;
        let full_table = pg_full_table_quoted(table, schema);
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| format!("{} = {}", escape_identifier(col, &DatabaseType::PostgreSQL), json_value_to_sql(val)))
            .collect();
        let sql = format!(
            "UPDATE {} SET {} WHERE {}",
            full_table,
            set_clauses.join(", "),
            where_clause
        );
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        use crate::db::trait_def::escape_identifier;
        use crate::db::types::DatabaseType;
        let full_table = pg_full_table_quoted(table, schema);
        let columns: Vec<String> = values.iter()
            .map(|(c, _)| escape_identifier(c, &DatabaseType::PostgreSQL))
            .collect();
        let value_strs: Vec<String> = values.iter().map(|(_, val)| json_value_to_sql(val)).collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            full_table,
            columns.join(", "),
            value_strs.join(", ")
        );
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        use crate::db::trait_def::sanitize_where_clause;
        sanitize_where_clause(where_clause)
            .map_err(|e| DbError::QueryError(e))?;
        let full_table = pg_full_table_quoted(table, schema);
        let sql = format!("DELETE FROM {} WHERE {}", full_table, where_clause);
        self.execute_sql(&sql).await
    }
}

/// Build column info from a PgRow by inspecting column descriptions
fn build_columns_from_pg_row(row: &sqlx::postgres::PgRow) -> Vec<ColumnInfo> {
    use sqlx::Column;

    let columns = row.columns();
    let mut result = Vec::with_capacity(columns.len());
    for col in columns {
        result.push(ColumnInfo {
            name: col.name().to_string(),
            data_type: format!("{:?}", col.type_info()),
            nullable: true,
            is_primary_key: false,
            default_value: None,
            comment: None,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        });
    }
    result
}

/// Format a PgInterval into a human-readable string
fn format_pg_interval(interval: &sqlx::postgres::types::PgInterval) -> String {
    let mut parts = Vec::new();
    if interval.months != 0 {
        let years = interval.months / 12;
        let months = interval.months % 12;
        if years != 0 {
            parts.push(format!(
                "{} year{}",
                years,
                if years.abs() != 1 { "s" } else { "" }
            ));
        }
        if months != 0 {
            parts.push(format!(
                "{} mon{}",
                months,
                if months.abs() != 1 { "s" } else { "" }
            ));
        }
    }
    if interval.days != 0 {
        parts.push(format!(
            "{} day{}",
            interval.days,
            if interval.days.abs() != 1 { "s" } else { "" }
        ));
    }
    if interval.microseconds != 0 {
        let total_secs = interval.microseconds / 1_000_000;
        let hours = total_secs / 3600;
        let mins = (total_secs % 3600) / 60;
        let secs = total_secs % 60;
        let micros = interval.microseconds % 1_000_000;
        if micros != 0 {
            parts.push(format!(
                "{:02}:{:02}:{:02}.{:06}",
                hours, mins, secs, micros
            ));
        } else {
            parts.push(format!("{:02}:{:02}:{:02}", hours, mins, secs));
        }
    }
    if parts.is_empty() {
        "00:00:00".to_string()
    } else {
        parts.join(" ")
    }
}
