use async_trait::async_trait;

use futures::StreamExt;
use rust_decimal::Decimal;
use sqlx::{Column, Row, TypeInfo};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::types::{
    ColumnInfo, ConnectionConfig, ConnectionStatus, DatabaseType, DbError, ExecuteResult,
    QueryResult, TableInfo,
};

/// Trait defining the interface for database connections
#[async_trait]
pub trait DatabaseConnection: Send + Sync {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError>;
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError>;
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError>;
    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError>;
    async fn get_schemas(&self) -> Result<Vec<String>, DbError>;
    #[allow(dead_code)]
    fn db_type(&self) -> DatabaseType;
    async fn close(&self);
    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError>;
}

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

        let ssl_mode = if config.ssl_enabled { "require" } else { "prefer" };

        let connection_string = if password.is_empty() {
            if database.is_empty() {
                format!(
                    "postgres://{}@{}:{}?sslmode={}",
                    encode(username), host, port, ssl_mode
                )
            } else {
                format!(
                    "postgres://{}@{}:{}/{}?sslmode={}",
                    encode(username), host, port, encode(database), ssl_mode
                )
            }
        } else {
            if database.is_empty() {
                format!(
                    "postgres://{}:{}@{}:{}?sslmode={}",
                    encode(username), encode(password), host, port, ssl_mode
                )
            } else {
                format!(
                    "postgres://{}:{}@{}:{}/{}?sslmode={}",
                    encode(username), encode(password), host, port, encode(database), ssl_mode
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
            .map_err(|e| DbError::ConnectionError(format!("Failed to connect to PostgreSQL: {}", e)))?;

        log::info!("Successfully connected to PostgreSQL");

        Ok(Self {
            pool,
            db_type_label: config.db_type.clone(),
        })
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

        let result = sqlx::query(sql).fetch_all(&self.pool).await
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

        // Extract column information from the first row
        let columns = build_columns_from_pg_row(&result[0]);

        // Convert rows to JSON maps keyed by column name - 使用 dbpaw 的精确类型匹配方法
        let mut result_rows = Vec::new();
        for row in &result {
            let mut map = serde_json::Map::new();
            for col in row.columns() {
                let name = col.name().to_string();
                let type_name = col.type_info().name();
                let value = match type_name {
                    "BOOL" => row
                        .try_get::<bool, _>(col.name())
                        .ok()
                        .map(serde_json::Value::Bool)
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "INT2" | "INT4" | "INT8" => row
                        .try_get::<i64, _>(col.name())
                        .ok()
                        .map(|v| serde_json::Value::String(v.to_string()))
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "FLOAT4" | "FLOAT8" => row
                        .try_get::<f64, _>(col.name())
                        .ok()
                        .map(serde_json::Value::from)
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "NUMERIC" | "MONEY" => row
                        .try_get::<Decimal, _>(col.name())
                        .ok()
                        .map(|v| serde_json::Value::String(v.to_string()))
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "UUID" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "DATE" | "TIME" | "TIMETZ" | "INTERVAL" | "TIMESTAMP" | "TIMESTAMPTZ" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "JSON" | "JSONB" => row
                        .try_get::<sqlx::types::Json<serde_json::Value>, _>(col.name())
                        .ok()
                        .map(|v| v.0)
                        .unwrap_or(serde_json::Value::Null),
                    _ => {
                        if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            serde_json::Value::String(String::from_utf8_lossy(&v).to_string())
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
                t.table_name,
                t.table_schema,
                obj_description(c.oid) as table_comment,
                t.table_type
            FROM information_schema.tables t
            LEFT JOIN pg_catalog.pg_class c ON c.relname = t.table_name
            LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
            WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY t.table_schema, t.table_name
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let table_type: String = row.get("table_type");
                let table_type = if table_type == "BASE TABLE" {
                    "TABLE".to_string()
                } else {
                    table_type
                };
                TableInfo {
                    name: row.get("table_name"),
                    schema: row.get("table_schema"),
                    row_count: None,
                    comment: row.get("table_comment"),
                    table_type,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("public");

        let sql = r#"
            SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                col_description(c.oid, c.ordinal_position) as column_comment,
                CASE
                    WHEN pk.column_name IS NOT NULL THEN true
                    ELSE false
                END as is_primary_key
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
                ColumnInfo {
                    name: row.get("column_name"),
                    data_type: row.get("data_type"),
                    nullable: is_nullable == "YES",
                    is_primary_key: row.get("is_primary_key"),
                    default_value: row.get("column_default"),
                    comment: row.get("column_comment"),
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

    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
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

        let col_defs: Vec<String> = rows.iter().map(|row| {
            let name: String = row.get("column_name");
            let data_type: String = row.get("data_type");
            let is_nullable: String = row.get("is_nullable");
            let default: Option<String> = row.get("column_default");
            let null_str = if is_nullable == "YES" { "" } else { " NOT NULL" };
            let default_str = match default {
                Some(d) => format!(" DEFAULT {}", d),
                None => String::new(),
            };
            format!("    {} {}{}{}", name, data_type, null_str, default_str)
        }).collect();

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
        });
    }
    result
}

// ============================================================================
// MySQL Connection
// ============================================================================

pub struct MySqlConnection {
    pool: sqlx::MySqlPool,
}

impl MySqlConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        use urlencoding::encode;
        
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(3306);
        let username = config.username.as_deref().unwrap_or("root");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");

        let connection_string = if password.is_empty() {
            if database.is_empty() {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}@{}:{}/?ssl-mode=preferred",
                        encode(username), host, port
                    )
                } else {
                    format!(
                        "mysql://{}@{}:{}",
                        encode(username), host, port
                    )
                }
            } else {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}@{}:{}/{}/?ssl-mode=preferred",
                        encode(username), host, port, encode(database)
                    )
                } else {
                    format!(
                        "mysql://{}@{}:{}/{}",
                        encode(username), host, port, encode(database)
                    )
                }
            }
        } else {
            if database.is_empty() {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}:{}@{}:{}/?ssl-mode=preferred",
                        encode(username), encode(password), host, port
                    )
                } else {
                    format!(
                        "mysql://{}:{}@{}:{}",
                        encode(username), encode(password), host, port
                    )
                }
            } else {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}:{}@{}:{}/{}/?ssl-mode=preferred",
                        encode(username), encode(password), host, port, encode(database)
                    )
                } else {
                    format!(
                        "mysql://{}:{}@{}:{}/{}",
                        encode(username), encode(password), host, port, encode(database)
                    )
                }
            }
        };

        log::info!("Connecting to MySQL at {}:{}", host, port);
        log::info!("Connection string: {}", connection_string);

        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(5)
            .idle_timeout(Duration::from_secs(600))
            .max_lifetime(Duration::from_secs(1800))
            .acquire_timeout(Duration::from_secs(10))
            .connect(&connection_string)
            .await
            .map_err(|e| {
                log::error!("MySQL connection error: {}", e);
                DbError::ConnectionError(format!("Failed to connect to MySQL: {}", e))
            })?;

        log::info!("Successfully connected to MySQL");

        Ok(Self { pool })
    }
}

#[async_trait]
impl DatabaseConnection for MySqlConnection {
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

        let columns = build_columns_from_mysql_row(&result[0]);

        // Convert rows to JSON maps keyed by column name - 使用精确类型匹配方法
        let mut result_rows = Vec::new();
        for row in &result {
            let mut map = serde_json::Map::new();
            for col in row.columns() {
                let name = col.name().to_string();
                let type_name = col.type_info().name();
                let value = match type_name {
                    "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => row
                        .try_get::<i64, _>(col.name())
                        .ok()
                        .map(|v| serde_json::Value::String(v.to_string()))
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "FLOAT" | "DOUBLE" => row
                        .try_get::<f64, _>(col.name())
                        .ok()
                        .map(serde_json::Value::from)
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "DECIMAL" | "NUMERIC" => row
                        .try_get::<Decimal, _>(col.name())
                        .ok()
                        .map(|v| serde_json::Value::String(v.to_string()))
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "DATE" | "TIME" | "DATETIME" | "TIMESTAMP" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "BOOLEAN" | "BOOL" => row
                        .try_get::<bool, _>(col.name())
                        .ok()
                        .map(serde_json::Value::Bool)
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "JSON" => row
                        .try_get::<sqlx::types::Json<serde_json::Value>, _>(col.name())
                        .ok()
                        .map(|v| v.0)
                        .unwrap_or(serde_json::Value::Null),
                    _ => {
                        if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            serde_json::Value::String(String::from_utf8_lossy(&v).to_string())
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
                TABLE_NAME as table_name,
                TABLE_SCHEMA as table_schema,
                TABLE_COMMENT as table_comment,
                TABLE_TYPE as table_type,
                TABLE_ROWS as table_rows
            FROM information_schema.tables
            WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let table_type: String = row.get("table_type");
                let table_type = if table_type == "BASE TABLE" {
                    "TABLE".to_string()
                } else {
                    table_type
                };
                TableInfo {
                    name: row.get("table_name"),
                    schema: row.get("table_schema"),
                    row_count: row.get("table_rows"),
                    comment: row.get("table_comment"),
                    table_type,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let sql = if let Some(schema_name) = schema {
            format!(r#"
                SELECT
                    COLUMN_NAME as column_name,
                    DATA_TYPE as data_type,
                    IS_NULLABLE as is_nullable,
                    COLUMN_DEFAULT as column_default,
                    COLUMN_COMMENT as column_comment,
                    COLUMN_KEY as column_key
                FROM information_schema.columns
                WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            "#, schema_name.replace('\'', "''"))
        } else {
            r#"
                SELECT
                    COLUMN_NAME as column_name,
                    DATA_TYPE as data_type,
                    IS_NULLABLE as is_nullable,
                    COLUMN_DEFAULT as column_default,
                    COLUMN_COMMENT as column_comment,
                    COLUMN_KEY as column_key
                FROM information_schema.columns
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            "#.to_string()
        };

        let rows = sqlx::query(&sql)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let columns = rows
            .iter()
            .map(|row| {
                let is_nullable: String = row.get("is_nullable");
                let column_key: String = row.get("column_key");
                ColumnInfo {
                    name: row.get("column_name"),
                    data_type: row.get("data_type"),
                    nullable: is_nullable == "YES",
                    is_primary_key: column_key == "PRI",
                    default_value: row.get("column_default"),
                    comment: row.get("column_comment"),
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = r#"
            SELECT SCHEMA_NAME
            FROM information_schema.schemata
            WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            ORDER BY SCHEMA_NAME
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let schemas = rows.iter().map(|row| row.get::<String, _>(0)).collect();
        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::MySQL
    }

    async fn export_table_sql(&self, table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        let sql = format!(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT \
             FROM information_schema.columns \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION"
        );
        let rows = sqlx::query(&sql)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let col_defs: Vec<String> = rows.iter().map(|row| {
            let name: String = row.get("COLUMN_NAME");
            let data_type: String = row.get("DATA_TYPE");
            let is_nullable: String = row.get("IS_NULLABLE");
            let default: Option<String> = row.get("COLUMN_DEFAULT");
            let null_str = if is_nullable == "YES" { "" } else { " NOT NULL" };
            let default_str = match default {
                Some(d) => format!(" DEFAULT {}", d),
                None => String::new(),
            };
            format!("    {} {}{}{}", name, data_type, null_str, default_str)
        }).collect();

        Ok(format!(
            "-- Table: {}\nCREATE TABLE IF NOT EXISTS {} (\n{}\n);\n",
            table, table, col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

/// Build column info from a MySqlRow
fn build_columns_from_mysql_row(row: &sqlx::mysql::MySqlRow) -> Vec<ColumnInfo> {
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
        });
    }
    result
}

// ============================================================================
// SQLite Connection
// ============================================================================

pub struct SQLiteConnection {
    pool: sqlx::SqlitePool,
}

impl SQLiteConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        // For SQLite, the "host" field contains the file path
        let db_path = config
            .host
            .as_deref()
            .unwrap_or_else(|| config.database.as_deref().unwrap_or(""));

        let connection_string = if db_path.starts_with("sqlite:") {
            db_path.to_string()
        } else if db_path.is_empty() {
            "sqlite::memory:".to_string()
        } else {
            format!("sqlite:{}", db_path)
        };

        log::info!("Connecting to SQLite at {}", db_path);

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(5)
            .idle_timeout(Duration::from_secs(600))
            .max_lifetime(Duration::from_secs(1800))
            .acquire_timeout(Duration::from_secs(10))
            .connect(&connection_string)
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to SQLite: {}", e))
            })?;

        log::info!("Successfully connected to SQLite");

        Ok(Self { pool })
    }
}

#[async_trait]
impl DatabaseConnection for SQLiteConnection {
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

        let columns = build_columns_from_sqlite_row(&result[0]);

        // Convert rows to JSON maps keyed by column name - 使用精确类型匹配方法
        let mut result_rows = Vec::new();
        for row in &result {
            let mut map = serde_json::Map::new();
            for col in row.columns() {
                let name = col.name().to_string();
                let type_name = col.type_info().name();
                let value = match type_name {
                    "INTEGER" | "INT" | "BIGINT" => row
                        .try_get::<i64, _>(col.name())
                        .ok()
                        .map(|v| serde_json::Value::String(v.to_string()))
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "REAL" | "FLOAT" | "DOUBLE" => row
                        .try_get::<f64, _>(col.name())
                        .ok()
                        .map(serde_json::Value::from)
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "NUMERIC" | "DECIMAL" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "TEXT" | "VARCHAR" | "CHAR" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "BOOLEAN" | "BOOL" => row
                        .try_get::<bool, _>(col.name())
                        .ok()
                        .map(serde_json::Value::Bool)
                        .or_else(|| {
                            row.try_get::<String, _>(col.name())
                                .ok()
                                .map(serde_json::Value::String)
                        })
                        .unwrap_or(serde_json::Value::Null),
                    "DATE" | "TIME" | "DATETIME" | "TIMESTAMP" => row
                        .try_get::<String, _>(col.name())
                        .ok()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                    "JSON" => row
                        .try_get::<sqlx::types::Json<serde_json::Value>, _>(col.name())
                        .ok()
                        .map(|v| v.0)
                        .unwrap_or(serde_json::Value::Null),
                    _ => {
                        if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            serde_json::Value::String(String::from_utf8_lossy(&v).to_string())
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
            SELECT name, type
            FROM sqlite_master
            WHERE type IN ('table', 'view')
            AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let table_type: String = row.get(1);
                TableInfo {
                    name: row.get(0),
                    schema: None,
                    row_count: None,
                    comment: None,
                    table_type: table_type.to_uppercase(),
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let escaped_table = table.replace("\"", "\"\"");
        let sql = format!("PRAGMA table_info(\"{}\")", escaped_table);

        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let columns = rows
            .iter()
            .map(|row| {
                let pk: i32 = row.get(5);
                let notnull: i32 = row.get(3);
                let dflt_value: Option<String> = row.get(4);
                ColumnInfo {
                    name: row.get(1),
                    data_type: row.get(2),
                    nullable: notnull == 0,
                    is_primary_key: pk > 0,
                    default_value: dflt_value,
                    comment: None,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        // SQLite does not have schemas, return "main" as the default
        Ok(vec!["main".to_string()])
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::SQLite
    }

    async fn export_table_sql(&self, table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        // SQLite has a built-in way to get CREATE TABLE sql
        let sql = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?";
        let rows = sqlx::query(sql)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        if let Some(row) = rows.first() {
            let create_sql: Option<String> = row.get(0);
            if let Some(sql) = create_sql {
                return Ok(format!("-- Table: {}\n{}\n", table, sql));
            }
        }

        // Fallback: build from PRAGMA
        let escaped_table = table.replace("\"", "\"\"");
        let pragma_sql = format!("PRAGMA table_info(\"{}\")", escaped_table);
        let cols = sqlx::query(&pragma_sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let col_defs: Vec<String> = cols.iter().map(|row| {
            let name: String = row.get(1);
            let data_type: String = row.get(2);
            let notnull: i32 = row.get(3);
            let dflt_value: Option<String> = row.get(4);
            let pk: i32 = row.get(5);
            let pk_str = if pk > 0 { " PRIMARY KEY" } else { "" };
            let null_str = if notnull == 0 { "" } else { " NOT NULL" };
            let default_str = match dflt_value {
                Some(d) => format!(" DEFAULT {}", d),
                None => String::new(),
            };
            format!("    {} {}{}{}{}", name, data_type, pk_str, null_str, default_str)
        }).collect();

        Ok(format!(
            "-- Table: {}\nCREATE TABLE IF NOT EXISTS {} (\n{}\n);\n",
            table, table, col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

/// Build column info from a SqliteRow
fn build_columns_from_sqlite_row(row: &sqlx::sqlite::SqliteRow) -> Vec<ColumnInfo> {
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
        });
    }
    result
}

// ============================================================================
// GaussDB TLS Support
// ============================================================================

/// Wrapper around `native_tls::TlsConnector` that implements `tokio_gaussdb::tls::MakeTlsConnect`.
struct GaussDbTlsConnector(native_tls::TlsConnector);

impl<S> tokio_gaussdb::tls::MakeTlsConnect<S> for GaussDbTlsConnector
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    type Stream = GaussDbTlsStream<S>;
    type TlsConnect = GaussDbTlsConnect;
    type Error = std::io::Error;

    fn make_tls_connect(&mut self, _domain: &str) -> Result<Self::TlsConnect, Self::Error> {
        Ok(GaussDbTlsConnect(self.0.clone()))
    }
}

struct GaussDbTlsConnect(native_tls::TlsConnector);

impl<S> tokio_gaussdb::tls::TlsConnect<S> for GaussDbTlsConnect
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    type Stream = GaussDbTlsStream<S>;
    type Error = std::io::Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self::Stream, Self::Error>> + Send>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            let tls_stream = tokio_native_tls::TlsConnector::from(self.0)
                .connect("gaussdb", stream)
                .await
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            Ok(GaussDbTlsStream(tls_stream))
        })
    }
}

/// Newtype wrapper around `tokio_native_tls::TlsStream` to implement `tokio_gaussdb::tls::TlsStream`.
struct GaussDbTlsStream<S>(tokio_native_tls::TlsStream<S>);

impl<S> tokio::io::AsyncRead for GaussDbTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl<S> tokio::io::AsyncWrite for GaussDbTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

impl<S> tokio_gaussdb::tls::TlsStream for GaussDbTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn channel_binding(&self) -> tokio_gaussdb::tls::ChannelBinding {
        tokio_gaussdb::tls::ChannelBinding::none()
    }
}

// ============================================================================
// GaussDB Connection (using tokio-gaussdb - Huawei official driver)
// ============================================================================

pub struct GaussDBConnection {
    client: tokio_gaussdb::Client,
}

impl GaussDBConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(5432);
        let username = config.username.as_deref().unwrap_or("gaussdb");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");

        let ssl_mode = if config.ssl_enabled { "require" } else { "prefer" };

        let connection_string = if password.is_empty() {
            if database.is_empty() {
                format!(
                    "host={} port={} user={} sslmode={}",
                    host, port, username, ssl_mode
                )
            } else {
                format!(
                    "host={} port={} user={} dbname={} sslmode={}",
                    host, port, username, database, ssl_mode
                )
            }
        } else {
            if database.is_empty() {
                format!(
                    "host={} port={} user={} password={} sslmode={}",
                    host, port, username, password, ssl_mode
                )
            } else {
                format!(
                    "host={} port={} user={} password={} dbname={} sslmode={}",
                    host, port, username, password, database, ssl_mode
                )
            }
        };

        log::info!("Connecting to GaussDB at {}:{}", host, port);

        let client = if config.ssl_enabled {
            let tls_connector = native_tls::TlsConnector::new()
                .map_err(|e| DbError::ConnectionError(format!("TLS error: {}", e)))?;
            let tls = GaussDbTlsConnector(tls_connector);
            let (client, connection) = tokio_gaussdb::connect(&connection_string, tls)
                .await
                .map_err(|e| {
                    DbError::ConnectionError(format!(
                        "GaussDB TLS connection failed: {}",
                        e
                    ))
                })?;
            // Spawn the connection task in the background
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    log::error!("GaussDB connection error: {}", e);
                }
            });
            client
        } else {
            let (client, connection) = tokio_gaussdb::connect(&connection_string, tokio_gaussdb::NoTls)
                .await
                .map_err(|e| {
                    DbError::ConnectionError(format!(
                        "Failed to connect to GaussDB: {}",
                        e
                    ))
                })?;
            // Spawn the connection task in the background
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    log::error!("GaussDB connection error: {}", e);
                }
            });
            client
        };

        log::info!("Successfully connected to GaussDB");

        Ok(Self { client })
    }

    /// Convert a row to a JSON map using string representation for all values
    fn row_to_json_map(
        row: &tokio_gaussdb::Row,
        col_count: usize,
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        for col_idx in 0..col_count {
            let col_name = row.columns()[col_idx].name().to_string();
            let val: serde_json::Value = match row.get::<_, Option<String>>(col_idx) {
                Some(s) => {
                    // Try to parse as JSON first (for numbers, booleans, etc.)
                    if s == "NULL" {
                        serde_json::Value::Null
                    } else if s == "true" {
                        serde_json::Value::Bool(true)
                    } else if s == "false" {
                        serde_json::Value::Bool(false)
                    } else if let Ok(n) = s.parse::<i64>() {
                        serde_json::Value::Number(serde_json::Number::from(n))
                    } else if let Ok(n) = s.parse::<f64>() {
                        serde_json::Number::from_f64(n)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::String(s))
                    } else {
                        serde_json::Value::String(s)
                    }
                }
                None => serde_json::Value::Null,
            };
            map.insert(col_name, val);
        }
        map
    }
}

#[async_trait]
impl DatabaseConnection for GaussDBConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = Instant::now();
        let result = self
            .client
            .execute(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(ExecuteResult {
            rows_affected: result,
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = Instant::now();

        let rows = self
            .client
            .query(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let elapsed = start.elapsed().as_millis() as u64;

        if rows.is_empty() {
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                execution_time_ms: elapsed,
            });
        }

        // Build column info from the first row
        let columns: Vec<ColumnInfo> = {
            let first_row = &rows[0];
            first_row
                .columns()
                .iter()
                .map(|col| ColumnInfo {
                    name: col.name().to_string(),
                    data_type: format!("{:?}", col.type_()),
                    nullable: true,
                    is_primary_key: false,
                    default_value: None,
                    comment: None,
                })
                .collect()
        };

        let col_count = columns.len();

        // Convert rows to JSON maps
        let result_rows: Vec<serde_json::Map<String, serde_json::Value>> = rows
            .iter()
            .map(|row| Self::row_to_json_map(row, col_count))
            .collect();

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
                t.table_name,
                t.table_schema,
                t.table_type
            FROM information_schema.tables t
            WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY t.table_schema, t.table_name
        "#;

        let rows = self
            .client
            .query(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let table_type: String = row.get(2);
                let table_type = if table_type == "BASE TABLE" {
                    "TABLE".to_string()
                } else {
                    table_type
                };
                TableInfo {
                    name: row.get(0),
                    schema: row.get(1),
                    row_count: None,
                    comment: None,
                    table_type,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("public");

        let sql = r#"
            SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                CASE
                    WHEN pk.column_name IS NOT NULL THEN true
                    ELSE false
                END as is_primary_key
            FROM information_schema.columns c
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

        let rows = self
            .client
            .query(sql, &[&table, &schema_name])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let columns = rows
            .iter()
            .map(|row| {
                let is_nullable: String = row.get(2);
                ColumnInfo {
                    name: row.get(0),
                    data_type: row.get(1),
                    nullable: is_nullable == "YES",
                    is_primary_key: row.get(4),
                    default_value: row.get(3),
                    comment: None,
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

        let rows = self
            .client
            .query(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let schemas = rows.iter().map(|row| row.get::<_, String>(0)).collect();
        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::GaussDB
    }

    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = r#"
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = $2
            ORDER BY ordinal_position
        "#;
        let rows = self
            .client
            .query(sql, &[&table, &schema_name])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let col_defs: Vec<String> = rows
            .iter()
            .map(|row| {
                let name: String = row.get(0);
                let data_type: String = row.get(1);
                let is_nullable: String = row.get(2);
                let default: Option<String> = row.get(3);
                let null_str = if is_nullable == "YES" { "" } else { " NOT NULL" };
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
        // The client is dropped automatically when this struct is dropped.
        // The background connection task will also finish.
    }
}

// ============================================================================
// MSSQL Connection (using tiberius - native TDS client)
// ============================================================================

use tokio_util::compat::TokioAsyncWriteCompatExt;

pub struct MSSQLConnection {
    client: Arc<tokio::sync::Mutex<tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>>>,
}

impl MSSQLConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(1433);
        let username = config.username.as_deref().unwrap_or("sa");
        let password = config.password.as_deref().unwrap_or("");

        log::info!("Connecting to MSSQL at {}:{}", host, port);

        let mut config_builder = tiberius::Config::new();
        config_builder.host(host);
        config_builder.port(port);
        config_builder.authentication(tiberius::AuthMethod::sql_server(username, password));
        if let Some(database) = &config.database {
            if !database.is_empty() {
                config_builder.database(database);
            }
        }
        config_builder.trust_cert();

        let tcp = tokio::net::TcpStream::connect(config_builder.get_addr())
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to MSSQL TCP: {}", e))
            })?;

        tcp.set_nodelay(true)
            .map_err(|e| DbError::ConnectionError(format!("Failed to set TCP nodelay: {}", e)))?;

        let client = tiberius::Client::connect(config_builder, tcp.compat_write())
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to MSSQL: {}", e))
            })?;

        log::info!("Successfully connected to MSSQL");

        Ok(Self {
            client: Arc::new(tokio::sync::Mutex::new(client)),
        })
    }

    /// Convert a ColumnData value to a serde_json::Value
    fn column_data_to_json(data: &tiberius::ColumnData) -> serde_json::Value {
        match data {
            tiberius::ColumnData::U8(Some(v)) => serde_json::Value::Number(serde_json::Number::from(*v)),
            tiberius::ColumnData::I16(Some(v)) => serde_json::Value::Number(serde_json::Number::from(*v)),
            tiberius::ColumnData::I32(Some(v)) => serde_json::Value::Number(serde_json::Number::from(*v)),
            tiberius::ColumnData::I64(Some(v)) => serde_json::Value::Number(serde_json::Number::from(*v)),
            tiberius::ColumnData::F32(Some(v)) => serde_json::Number::from_f64(*v as f64)
                .map(serde_json::Value::Number)
                .unwrap_or_else(|| serde_json::Value::String(v.to_string())),
            tiberius::ColumnData::F64(Some(v)) => serde_json::Number::from_f64(*v)
                .map(serde_json::Value::Number)
                .unwrap_or_else(|| serde_json::Value::String(v.to_string())),
            tiberius::ColumnData::Bit(Some(v)) => serde_json::Value::Bool(*v),
            tiberius::ColumnData::String(Some(s)) => serde_json::Value::String(s.to_string()),
            tiberius::ColumnData::Guid(Some(u)) => serde_json::Value::String(u.to_string()),
            tiberius::ColumnData::Numeric(Some(n)) => serde_json::Value::String(n.to_string()),
            tiberius::ColumnData::Xml(Some(x)) => serde_json::Value::String(x.to_string()),
            tiberius::ColumnData::DateTime(Some(dt)) => serde_json::Value::String(format!("{:?}", dt)),
            tiberius::ColumnData::SmallDateTime(Some(dt)) => serde_json::Value::String(format!("{:?}", dt)),
            tiberius::ColumnData::Time(Some(t)) => serde_json::Value::String(format!("{:?}", t)),
            tiberius::ColumnData::Date(Some(d)) => serde_json::Value::String(format!("{:?}", d)),
            tiberius::ColumnData::DateTime2(Some(dt)) => serde_json::Value::String(format!("{:?}", dt)),
            tiberius::ColumnData::DateTimeOffset(Some(dto)) => serde_json::Value::String(format!("{:?}", dto)),
            tiberius::ColumnData::Binary(Some(b)) => {
                // Represent binary data as hex string
                serde_json::Value::String(
                    b.iter().map(|byte| format!("{:02X}", byte)).collect()
                )
            }
            // Null values for all types
            tiberius::ColumnData::U8(None)
            | tiberius::ColumnData::I16(None)
            | tiberius::ColumnData::I32(None)
            | tiberius::ColumnData::I64(None)
            | tiberius::ColumnData::F32(None)
            | tiberius::ColumnData::F64(None)
            | tiberius::ColumnData::Bit(None)
            | tiberius::ColumnData::String(None)
            | tiberius::ColumnData::Guid(None)
            | tiberius::ColumnData::Binary(None)
            | tiberius::ColumnData::Numeric(None)
            | tiberius::ColumnData::Xml(None)
            | tiberius::ColumnData::DateTime(None)
            | tiberius::ColumnData::SmallDateTime(None)
            | tiberius::ColumnData::Time(None)
            | tiberius::ColumnData::Date(None)
            | tiberius::ColumnData::DateTime2(None)
            | tiberius::ColumnData::DateTimeOffset(None) => serde_json::Value::Null,
        }
    }
}

#[async_trait]
impl DatabaseConnection for MSSQLConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = Instant::now();
        let mut client = self.client.lock().await;
        let result = client
            .execute(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(ExecuteResult {
            rows_affected: result.total(),
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = Instant::now();
        let mut client = self.client.lock().await;

        let stream = client
            .query(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let mut rows: Vec<tiberius::Row> = vec![];
        let mut column_info: Option<Vec<ColumnInfo>> = None;

        // Pull all results from the stream using futures::StreamExt
        let mut stream = stream.into_row_stream();
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| DbError::QueryError(e.to_string()))?;
            if column_info.is_none() {
                let cols: Vec<ColumnInfo> = row
                    .columns()
                    .iter()
                    .map(|col: &tiberius::Column| ColumnInfo {
                        name: col.name().to_string(),
                        data_type: format!("{:?}", col.column_type()),
                        nullable: true,
                        is_primary_key: false,
                        default_value: None,
                        comment: None,
                    })
                    .collect();
                column_info = Some(cols);
            }
            rows.push(row);
        }

        let elapsed = start.elapsed().as_millis() as u64;

        if rows.is_empty() {
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                execution_time_ms: elapsed,
            });
        }

        let columns = column_info.unwrap_or_default();

        // Convert rows to JSON maps
        let mut result_rows = Vec::new();
        for row in &rows {
            let mut map = serde_json::Map::new();
            for (col, data) in row.cells() {
                let val = Self::column_data_to_json(data);
                map.insert(col.name().to_string(), val);
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
                TABLE_NAME,
                TABLE_SCHEMA,
                TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        "#;

        let mut client = self.client.lock().await;
        let stream = client
            .query(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let mut tables = Vec::new();
        let mut stream = stream.into_row_stream();
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| DbError::QueryError(e.to_string()))?;
            let table_type: &str = row.get(2).unwrap_or("TABLE");
            let table_type = if table_type == "BASE TABLE" {
                "TABLE"
            } else {
                table_type
            };
            tables.push(TableInfo {
                name: row.get::<&str, _>(0).unwrap_or_default().to_string(),
                schema: row.get::<&str, _>(1).map(|s| s.to_string()),
                row_count: None,
                comment: None,
                table_type: table_type.to_string(),
            });
        }

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("dbo");

        let sql = r#"
            SELECT
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                CASE
                    WHEN pk.COLUMN_NAME IS NOT NULL THEN 1
                    ELSE 0
                END AS IS_PRIMARY_KEY
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT
                    kcu.TABLE_SCHEMA,
                    kcu.TABLE_NAME,
                    kcu.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                    ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                    AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
                AND pk.TABLE_NAME = c.TABLE_NAME
                AND pk.COLUMN_NAME = c.COLUMN_NAME
            WHERE c.TABLE_NAME = @P1 AND c.TABLE_SCHEMA = @P2
            ORDER BY c.ORDINAL_POSITION
        "#;

        let mut client = self.client.lock().await;
        let stream = client
            .query(sql, &[&table, &schema_name])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let mut columns = Vec::new();
        let mut stream = stream.into_row_stream();
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| DbError::QueryError(e.to_string()))?;
            let is_nullable: &str = row.get(2).unwrap_or("YES");
            let is_pk: i32 = row.get(4).unwrap_or(0);
            columns.push(ColumnInfo {
                name: row.get::<&str, _>(0).unwrap_or_default().to_string(),
                data_type: row.get::<&str, _>(1).unwrap_or_default().to_string(),
                nullable: is_nullable == "YES",
                is_primary_key: is_pk == 1,
                default_value: row.get::<&str, _>(3).map(|s| s.to_string()),
                comment: None,
            });
        }

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = r#"
            SELECT DISTINCT SCHEMA_NAME
            FROM INFORMATION_SCHEMA.SCHEMATA
            WHERE SCHEMA_NAME NOT IN ('guest', 'INFORMATION_SCHEMA', 'sys')
            ORDER BY SCHEMA_NAME
        "#;

        let mut client = self.client.lock().await;
        let stream = client
            .query(sql, &[])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let mut schemas = Vec::new();
        let mut stream = stream.into_row_stream();
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| DbError::QueryError(e.to_string()))?;
            if let Some(schema) = row.get::<&str, usize>(0) {
                schemas.push(schema.to_string());
            }
        }

        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::MSSQL
    }

    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        let schema_name = schema.unwrap_or("dbo");
        let sql = r#"
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = @P1 AND TABLE_SCHEMA = @P2
            ORDER BY ORDINAL_POSITION
        "#;

        let mut client = self.client.lock().await;
        let stream = client
            .query(sql, &[&table, &schema_name])
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let mut col_defs: Vec<String> = Vec::new();
        let mut stream = stream.into_row_stream();
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| DbError::QueryError(e.to_string()))?;
            let name: &str = row.get(0).unwrap_or_default();
            let data_type: &str = row.get(1).unwrap_or_default();
            let is_nullable: &str = row.get(2).unwrap_or("YES");
            let default: Option<&str> = row.get(3);
            let null_str = if is_nullable == "YES" { "" } else { " NOT NULL" };
            let default_str = match default {
                Some(d) => format!(" DEFAULT {}", d),
                None => String::new(),
            };
            col_defs.push(format!("    {} {}{}{}", name, data_type, null_str, default_str));
        }

        let full_table = format!("[{}].[{}]", schema_name, table);

        Ok(format!(
            "-- Table: {}\nCREATE TABLE {} (\n{}\n);\n",
            full_table,
            full_table,
            col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        // The client is dropped automatically when this struct is dropped.
    }
}

// ============================================================================
// ClickHouse Connection (using HTTP API via reqwest)
// ============================================================================

pub struct ClickHouseConnection {
    client: reqwest::Client,
    url: String,
    database: String,
    username: String,
    password: String,
}

impl ClickHouseConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(8123);
        let username = config.username.as_deref().unwrap_or("default");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("default");

        let scheme = if config.ssl_enabled { "https" } else { "http" };
        let url = format!("{}://{}:{}", scheme, host, port);

        log::info!("Connecting to ClickHouse at {}", url);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| DbError::ConnectionError(format!("Failed to create HTTP client: {}", e)))?;

        // Test connection with a simple query
        let test_url = format!("{}/?user={}&database={}", url, username, database);
        let mut req = client.get(&test_url);
        if !password.is_empty() {
            req = req.basic_auth(username, Some(password));
        }
        let resp = req
            .body("SELECT 1 FORMAT JSONEachRow")
            .send()
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to ClickHouse: {}", e))
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::ConnectionError(format!(
                "ClickHouse connection failed ({}): {}",
                status, body
            )));
        }

        log::info!("Successfully connected to ClickHouse");

        Ok(Self {
            client,
            url,
            database: database.to_string(),
            username: username.to_string(),
            password: password.to_string(),
        })
    }

    /// Build a request with authentication
    fn build_request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.request(method, url);
        if !self.password.is_empty() {
            req = req.basic_auth(&self.username, Some(&self.password));
        } else {
            req = req.basic_auth(&self.username, None::<&str>);
        }
        req
    }
}

#[async_trait]
impl DatabaseConnection for ClickHouseConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = Instant::now();
        let query_url = format!("{}/?database={}", self.url, self.database);
        let resp = self
            .build_request(reqwest::Method::POST, &query_url)
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| DbError::QueryError(format!("ClickHouse request failed: {}", e)))?;

        let elapsed = start.elapsed().as_millis() as u64;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::QueryError(format!(
                "ClickHouse error ({}): {}",
                status, body
            )));
        }

        // ClickHouse returns "Ok." for successful DDL/DML
        let body = resp.text().await.unwrap_or_default();
        let rows_affected = if body.contains("Ok.") {
            // Parse summary if available, e.g. "Ok. 5 rows."
            if let Some(pos) = body.find("rows.") {
                let prefix = &body[..pos];
                // Try to extract the number before "rows."
                let parts: Vec<&str> = prefix.split_whitespace().collect();
                if let Some(last) = parts.last() {
                    if let Ok(n) = last.parse::<u64>() {
                        n
                    } else {
                        0
                    }
                } else {
                    0
                }
            } else {
                0
            }
        } else {
            0
        };

        Ok(ExecuteResult {
            rows_affected,
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = Instant::now();

        // Append FORMAT JSONEachRow to get JSON output
        let formatted_sql = if sql.trim().to_uppercase().contains("FORMAT ") {
            sql.to_string()
        } else {
            format!("{} FORMAT JSONEachRow", sql.trim())
        };

        let query_url = format!("{}/?database={}", self.url, self.database);
        let resp = self
            .build_request(reqwest::Method::POST, &query_url)
            .body(formatted_sql)
            .send()
            .await
            .map_err(|e| DbError::QueryError(format!("ClickHouse request failed: {}", e)))?;

        let elapsed = start.elapsed().as_millis() as u64;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::QueryError(format!(
                "ClickHouse error ({}): {}",
                status, body
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| DbError::QueryError(format!("Failed to read response: {}", e)))?;

        if body.trim().is_empty() {
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                execution_time_ms: elapsed,
            });
        }

        // Parse JSONEachRow format: each line is a JSON object
        let mut result_rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
        let mut columns: Vec<ColumnInfo> = Vec::new();

        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).map_err(|e| {
                    DbError::QueryError(format!("Failed to parse ClickHouse response: {}", e))
                })?;

            // Build column info from the first row
            if columns.is_empty() {
                for (key, value) in &map {
                    columns.push(ColumnInfo {
                        name: key.clone(),
                        data_type: infer_clickhouse_type(value),
                        nullable: true,
                        is_primary_key: false,
                        default_value: None,
                        comment: None,
                    });
                }
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
        let sql = format!(
            "SELECT name, engine, total_rows, comment FROM system.tables WHERE database = '{}' ORDER BY name",
            self.database
        );

        let result = self.query_sql(&sql).await?;

        let tables = result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let engine = row
                    .get("engine")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let total_rows = row
                    .get("total_rows")
                    .and_then(|v| {
                        if v.is_null() {
                            None
                        } else {
                            Some(v.as_u64().unwrap_or(0))
                        }
                    });
                let comment = row
                    .get("comment")
                    .and_then(|v| {
                        let s = v.as_str().unwrap_or("");
                        if s.is_empty() {
                            None
                        } else {
                            Some(s.to_string())
                        }
                    });

                let table_type = if engine.contains("View") || engine.contains("MATERIALIZED") {
                    "VIEW".to_string()
                } else {
                    "TABLE".to_string()
                };

                TableInfo {
                    name,
                    schema: Some(self.database.clone()),
                    row_count: total_rows,
                    comment,
                    table_type,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let sql = format!(
            "SELECT name, type, default_kind, default_expression, comment, is_in_primary_key \
             FROM system.columns \
             WHERE database = '{}' AND table = '{}' \
             ORDER BY position",
            self.database, table
        );

        let result = self.query_sql(&sql).await?;

        let columns = result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let data_type = row
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let is_primary_key = row
                    .get("is_in_primary_key")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    == 1;
                let default_expression = row
                    .get("default_expression")
                    .and_then(|v| {
                        if v.is_null() {
                            None
                        } else {
                            Some(v.as_str().unwrap_or("").to_string())
                        }
                    });
                let comment = row
                    .get("comment")
                    .and_then(|v| {
                        let s = v.as_str().unwrap_or("");
                        if s.is_empty() {
                            None
                        } else {
                            Some(s.to_string())
                        }
                    });

                // ClickHouse Nullable types indicate nullable columns
                let nullable = data_type.starts_with("Nullable(");

                ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    is_primary_key,
                    default_value: default_expression,
                    comment,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        // ClickHouse doesn't have schemas in the traditional sense.
        // Return the current database name as the only "schema".
        Ok(vec![self.database.clone()])
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::ClickHouse
    }

    async fn export_table_sql(&self, table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        let sql = format!(
            "SELECT name, type, default_kind, default_expression, comment \
             FROM system.columns \
             WHERE database = '{}' AND table = '{}' \
             ORDER BY position",
            self.database, table
        );

        let result = self.query_sql(&sql).await?;

        let col_defs: Vec<String> = result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let data_type = row
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");
                let default_kind = row
                    .get("default_kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let default_expression = row
                    .get("default_expression")
                    .and_then(|v| {
                        if v.is_null() {
                            None
                        } else {
                            v.as_str()
                        }
                    })
                    .unwrap_or("");

                let default_str = match default_kind {
                    "DEFAULT" => format!(" DEFAULT {}", default_expression),
                    "MATERIALIZED" => format!(" MATERIALIZED {}", default_expression),
                    "ALIAS" => format!(" ALIAS {}", default_expression),
                    "EPHEMERAL" => format!(" EPHEMERAL {}", default_expression),
                    _ => String::new(),
                };

                format!("    {} {}{}", name, data_type, default_str)
            })
            .collect();

        Ok(format!(
            "-- Table: {}\nCREATE TABLE IF NOT EXISTS {} (\n{}\n);\n",
            table,
            table,
            col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        // The reqwest::Client is dropped automatically when this struct is dropped.
    }
}

/// Infer a ClickHouse data type from a JSON value
fn infer_clickhouse_type(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "Nullable(String)".to_string(),
        serde_json::Value::Bool(_) => "Bool".to_string(),
        serde_json::Value::Number(n) => {
            if n.is_i64() {
                "Int64".to_string()
            } else if n.is_u64() {
                "UInt64".to_string()
            } else {
                "Float64".to_string()
            }
        }
        serde_json::Value::String(_) => "String".to_string(),
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                "Array(Nullable(String))".to_string()
            } else {
                let inner_type = infer_clickhouse_type(&arr[0]);
                format!("Array({})", inner_type)
            }
        }
        serde_json::Value::Object(_) => "Object".to_string(),
    }
}

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
}

impl ConnectionManager {
    /// Create a new connection manager
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
        }
    }

    /// Start the background heartbeat loop
    pub async fn start_heartbeat(manager: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            // Collect connection IDs and their keepalive settings
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
            // Read lock is dropped here

            for (id, skip_keepalive, auto_reconnect) in &connection_infos {
                if *skip_keepalive {
                    continue;
                }

                // Send heartbeat via SELECT 1
                let result = {
                    let connections = manager.connections.read().await;
                    if let Some(entry) = connections.get(id) {
                        entry.connection.query_sql("SELECT 1").await
                    } else {
                        continue;
                    }
                };
                // Read lock is dropped here

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
                        log::warn!(
                            "Heartbeat failed for connection '{}': {}",
                            id,
                            e
                        );
                        // Mark as unhealthy
                        {
                            let mut conns = manager.connections.write().await;
                            if let Some(e) = conns.get_mut(id) {
                                e.is_healthy = false;
                            }
                        }
                        // Attempt auto-reconnect if enabled
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
    ) -> Result<Box<dyn DatabaseConnection>, DbError> {
        match config.db_type {
            DatabaseType::PostgreSQL => Ok(Box::new(PostgresConnection::new(config).await?)),
            DatabaseType::GaussDB => Ok(Box::new(GaussDBConnection::new(config).await?)),
            DatabaseType::MySQL => Ok(Box::new(MySqlConnection::new(config).await?)),
            DatabaseType::SQLite => Ok(Box::new(SQLiteConnection::new(config).await?)),
            DatabaseType::MSSQL => Ok(Box::new(MSSQLConnection::new(config).await?)),
            DatabaseType::ClickHouse => Ok(Box::new(ClickHouseConnection::new(config).await?)),
        }
    }

    /// Connect to a database and store the connection
    pub async fn connect(&self, config: ConnectionConfig) -> Result<String, DbError> {
        let connection = Self::create_connection_async(&config).await?;

        let connection_id = config.id.clone();
        log::info!(
            "Connected to database '{}' with id '{}'",
            config.name,
            connection_id
        );

        let entry = ConnectionEntry {
            connection,
            config: config.clone(),
            last_heartbeat: Instant::now(),
            is_healthy: true,
            reconnect_count: 0,
        };

        let mut connections = self.connections.write().await;
        // Close old connection if ID already exists
        if let Some(old) = connections.insert(connection_id.clone(), entry) {
            old.connection.close().await;
            log::info!(
                "Closed old connection for id '{}'",
                connection_id
            );
        }

        Ok(connection_id)
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

    /// Execute a SQL statement (INSERT, UPDATE, DELETE, DDL) with auto-reconnect
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

    /// Execute a SQL query (SELECT) with auto-reconnect
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

    /// Internal execute without reconnect
    async fn execute_inner(&self, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.execute_sql(sql).await
    }

    /// Internal query without reconnect
    async fn query_inner(&self, id: &str, sql: &str) -> Result<QueryResult, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.query_sql(sql).await
    }

    /// Check if auto-reconnect should be attempted for a connection
    async fn should_reconnect(&self, id: &str) -> bool {
        let connections = self.connections.read().await;
        if let Some(entry) = connections.get(id) {
            entry.config.auto_reconnect && entry.reconnect_count < MAX_RECONNECT_ATTEMPTS
        } else {
            false
        }
    }

    /// Attempt to reconnect a connection with exponential backoff
    async fn reconnect(&self, id: &str) -> Result<(), DbError> {
        // Get current config and reconnect count
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

        // Exponential backoff: 1s, 2s, 4s
        let backoff_secs = 1u64 << (attempt - 1);
        log::info!(
            "Reconnect attempt {}/{} for connection '{}' (waiting {}s)...",
            attempt,
            MAX_RECONNECT_ATTEMPTS,
            id,
            backoff_secs
        );
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;

        // Close old connection and create new one
        let old_conn = {
            let mut connections = self.connections.write().await;
            connections
                .get_mut(id)
                .map(|e| std::mem::replace(&mut e.connection, Box::new(DummyConnection)))
        };

        if let Some(old) = old_conn {
            old.close().await;
        }

        match Self::create_connection_async(&config).await {
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
            format!("{}m {}s ago", elapsed.as_secs() / 60, elapsed.as_secs() % 60)
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

    /// Get all tables for a connection
    pub async fn get_tables(&self, id: &str) -> Result<Vec<TableInfo>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_tables().await
    }

    /// Get columns for a specific table
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

    /// Get all schemas for a connection
    pub async fn get_schemas(&self, id: &str) -> Result<Vec<String>, DbError> {
        let connections = self.connections.read().await;
        let entry = connections
            .get(id)
            .ok_or_else(|| DbError::NotFound(format!("Connection '{}' not found", id)))?;
        entry.connection.get_schemas().await
    }

    /// Test a connection without storing it
    pub async fn test_connection(&self, config: ConnectionConfig) -> Result<bool, DbError> {
        let connection = Self::create_connection_async(&config).await?;

        // Try to execute a simple query to verify the connection
        match config.db_type {
            DatabaseType::SQLite => {
                // For SQLite, just connecting is enough
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

    /// Export a single table as SQL
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

    /// Export entire database as SQL script
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
            "-- openDB Database Export\n-- Generated at: {}\n-- Tables: {}\n\n{}",
            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
            tables_to_export.len(),
            sql_parts.join("\n")
        ))
    }
}

/// Dummy connection used as a placeholder when swapping connections during reconnect
struct DummyConnection;

#[async_trait]
impl DatabaseConnection for DummyConnection {
    async fn execute_sql(&self, _sql: &str) -> Result<ExecuteResult, DbError> {
        Err(DbError::ConnectionError("Connection is being reconnected".to_string()))
    }
    async fn query_sql(&self, _sql: &str) -> Result<QueryResult, DbError> {
        Err(DbError::ConnectionError("Connection is being reconnected".to_string()))
    }
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        Err(DbError::ConnectionError("Connection is being reconnected".to_string()))
    }
    async fn get_columns(&self, _table: &str, _schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        Err(DbError::ConnectionError("Connection is being reconnected".to_string()))
    }
    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        Err(DbError::ConnectionError("Connection is being reconnected".to_string()))
    }
    fn db_type(&self) -> DatabaseType {
        DatabaseType::PostgreSQL // placeholder
    }
    async fn close(&self) {}
    async fn export_table_sql(&self, _table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        Err(DbError::ConnectionError("Connection is being reconnected".to_string()))
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
