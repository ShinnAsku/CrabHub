use async_trait::async_trait;
use rust_decimal::Decimal;
use sqlx::{Column, Row, TypeInfo};
use std::time::{Duration, Instant};

use super::trait_def::{json_value_to_sql, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

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
                        encode(username),
                        host,
                        port
                    )
                } else {
                    format!("mysql://{}@{}:{}", encode(username), host, port)
                }
            } else {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}@{}:{}/{}/?ssl-mode=preferred",
                        encode(username),
                        host,
                        port,
                        encode(database)
                    )
                } else {
                    format!(
                        "mysql://{}@{}:{}/{}",
                        encode(username),
                        host,
                        port,
                        encode(database)
                    )
                }
            }
        } else {
            if database.is_empty() {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}:{}@{}:{}/?ssl-mode=preferred",
                        encode(username),
                        encode(password),
                        host,
                        port
                    )
                } else {
                    format!(
                        "mysql://{}:{}@{}:{}",
                        encode(username),
                        encode(password),
                        host,
                        port
                    )
                }
            } else {
                if config.ssl_enabled {
                    format!(
                        "mysql://{}:{}@{}:{}/{}/?ssl-mode=preferred",
                        encode(username),
                        encode(password),
                        host,
                        port,
                        encode(database)
                    )
                } else {
                    format!(
                        "mysql://{}:{}@{}:{}/{}",
                        encode(username),
                        encode(password),
                        host,
                        port,
                        encode(database)
                    )
                }
            }
        };

        log::info!("Connecting to MySQL at {}:{}", host, port);

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

        // Set charset to utf8mb4 to ensure string columns are returned properly
        sqlx::query("SET NAMES utf8mb4")
            .execute(&pool)
            .await
            .map_err(|e| {
                log::warn!("Failed to SET NAMES utf8mb4: {}", e);
                DbError::ConnectionError(format!("Failed to set charset: {}", e))
            })?;

        log::info!("Successfully connected to MySQL");

        Ok(Self { pool })
    }
}

/// Quote a MySQL identifier with backticks
fn mysql_quote_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

/// Build full table reference for MySQL with backtick quoting
fn mysql_full_table(table: &str, schema: Option<&str>) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!("{}.{}", mysql_quote_ident(s), mysql_quote_ident(table))
        }
        _ => mysql_quote_ident(table),
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

        let mut result_rows = Vec::new();
        for row in &result {
            let mut map = serde_json::Map::new();
            for col in row.columns() {
                let name = col.name().to_string();
                let type_name = col.type_info().name();
                let value = match type_name {
                    "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
                        if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(col.name()) {
                            serde_json::json!(v)
                        } else if let Ok(v) = row.try_get::<i64, _>(col.name()) {
                            serde_json::json!(v)
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "FLOAT" | "DOUBLE" => {
                        if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(col.name()) {
                            serde_json::json!(v)
                        } else if let Ok(v) = row.try_get::<f64, _>(col.name()) {
                            serde_json::json!(v)
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "DECIMAL" | "NUMERIC" => {
                        if let Ok(Some(v)) = row.try_get::<Option<Decimal>, _>(col.name()) {
                            serde_json::json!(v)
                        } else if let Ok(v) = row.try_get::<Decimal, _>(col.name()) {
                            serde_json::json!(v)
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT"
                    | "ENUM" | "SET" => {
                        if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
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
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
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
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "DATETIME" | "TIMESTAMP" => {
                        if let Ok(Some(v)) =
                            row.try_get::<Option<chrono::NaiveDateTime>, _>(col.name())
                        {
                            serde_json::Value::String(
                                v.format("%Y-%m-%d %H:%M:%S").to_string(),
                            )
                        } else if let Ok(v) =
                            row.try_get::<chrono::NaiveDateTime, _>(col.name())
                        {
                            serde_json::Value::String(
                                v.format("%Y-%m-%d %H:%M:%S").to_string(),
                            )
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "YEAR" => {
                        if let Ok(Some(v)) = row.try_get::<Option<i16>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<i16, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "BOOLEAN" | "BOOL" => {
                        if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(col.name()) {
                            serde_json::Value::Bool(v)
                        } else if let Ok(v) = row.try_get::<bool, _>(col.name()) {
                            serde_json::Value::Bool(v)
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "BIT" => {
                        // BIT type: read as bytes, display as binary
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            let bits: String =
                                v.iter().map(|b| format!("{:08b}", b)).collect();
                            serde_json::Value::String(format!("b'{}'", bits.trim_start_matches('0')))
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            let bits: String =
                                v.iter().map(|b| format!("{:08b}", b)).collect();
                            serde_json::Value::String(format!("b'{}'", bits.trim_start_matches('0')))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "BINARY" | "VARBINARY" => {
                        // BINARY/VARBINARY: try UTF-8 first, fall back to hex
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            match String::from_utf8(v.clone()) {
                                Ok(s) => serde_json::Value::String(s),
                                Err(_) => {
                                    let hex_str: String =
                                        v.iter().map(|b| format!("{:02X}", b)).collect();
                                    serde_json::Value::String(format!("0x{}", hex_str))
                                }
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            match String::from_utf8(v.clone()) {
                                Ok(s) => serde_json::Value::String(s),
                                Err(_) => {
                                    let hex_str: String =
                                        v.iter().map(|b| format!("{:02X}", b)).collect();
                                    serde_json::Value::String(format!("0x{}", hex_str))
                                }
                            }
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
                        // BLOB types: read as bytes, display as hex
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02X}", b)).collect();
                            serde_json::Value::String(format!("0x{}", hex_str))
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02X}", b)).collect();
                            serde_json::Value::String(format!("0x{}", hex_str))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "GEOMETRY" | "POINT" | "LINESTRING" | "POLYGON" | "MULTIPOINT"
                    | "MULTILINESTRING" | "MULTIPOLYGON" | "GEOMETRYCOLLECTION" => {
                        // Spatial types: read as bytes, display as hex
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02X}", b)).collect();
                            serde_json::Value::String(format!("0x{}", hex_str))
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            let hex_str: String =
                                v.iter().map(|b| format!("{:02X}", b)).collect();
                            serde_json::Value::String(format!("0x{}", hex_str))
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "JSON" => {
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
                    _ => {
                        // FIX Bug #3: Try Vec<u8> BEFORE String to avoid panics on BINARY columns
                        if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                            // Try interpreting as UTF-8 first, fall back to hex
                            match String::from_utf8(v.clone()) {
                                Ok(s) => serde_json::Value::String(s),
                                Err(_) => {
                                    let hex_str: String =
                                        v.iter().map(|b| format!("{:02X}", b)).collect();
                                    serde_json::Value::String(format!("0x{}", hex_str))
                                }
                            }
                        } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                            match String::from_utf8(v.clone()) {
                                Ok(s) => serde_json::Value::String(s),
                                Err(_) => {
                                    let hex_str: String =
                                        v.iter().map(|b| format!("{:02X}", b)).collect();
                                    serde_json::Value::String(format!("0x{}", hex_str))
                                }
                            }
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
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
                CAST(TABLE_NAME AS CHAR) as table_name,
                CAST(TABLE_SCHEMA AS CHAR) as table_schema,
                CAST(TABLE_COMMENT AS CHAR) as table_comment,
                CAST(TABLE_TYPE AS CHAR) as table_type,
                TABLE_ROWS as table_rows,
                CAST(ENGINE AS CHAR) as engine,
                DATA_LENGTH as data_length,
                CREATE_TIME as create_time,
                UPDATE_TIME as update_time,
                CAST(TABLE_COLLATION AS CHAR) as collation
            FROM information_schema.tables
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
                let create_time: Option<chrono::NaiveDateTime> =
                    row.try_get("create_time").ok().flatten();
                let update_time: Option<chrono::NaiveDateTime> =
                    row.try_get("update_time").ok().flatten();
                let data_length: Option<i64> = row.try_get("data_length").ok().flatten();
                TableInfo {
                    name: row.get("table_name"),
                    schema: row.get("table_schema"),
                    row_count: row.get("table_rows"),
                    comment: row
                        .try_get::<Option<String>, _>("table_comment")
                        .ok()
                        .flatten()
                        .filter(|s| !s.is_empty()),
                    table_type,
                    oid: None,
                    owner: None,
                    acl: None,
                    primary_key: None,
                    partition_of: None,
                    has_indexes: None,
                    has_triggers: None,
                    engine: row.try_get("engine").ok().flatten(),
                    data_length,
                    create_time: create_time
                        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()),
                    update_time: update_time
                        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()),
                    collation: row.try_get("collation").ok().flatten(),
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
        let sql = if let Some(schema_name) = schema {
            format!(
                r#"
                SELECT
                    CAST(COLUMN_NAME AS CHAR) as column_name,
                    CAST(DATA_TYPE AS CHAR) as data_type,
                    CAST(IS_NULLABLE AS CHAR) as is_nullable,
                    CAST(COLUMN_DEFAULT AS CHAR) as column_default,
                    CAST(COLUMN_COMMENT AS CHAR) as column_comment,
                    CAST(COLUMN_KEY AS CHAR) as column_key,
                    CHARACTER_MAXIMUM_LENGTH as char_max_length,
                    NUMERIC_PRECISION as num_precision,
                    NUMERIC_SCALE as num_scale
                FROM information_schema.columns
                WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            "#,
                schema_name.replace('\'', "''")
            )
        } else {
            r#"
                SELECT
                    CAST(COLUMN_NAME AS CHAR) as column_name,
                    CAST(DATA_TYPE AS CHAR) as data_type,
                    CAST(IS_NULLABLE AS CHAR) as is_nullable,
                    CAST(COLUMN_DEFAULT AS CHAR) as column_default,
                    CAST(COLUMN_COMMENT AS CHAR) as column_comment,
                    CAST(COLUMN_KEY AS CHAR) as column_key,
                    CHARACTER_MAXIMUM_LENGTH as char_max_length,
                    NUMERIC_PRECISION as num_precision,
                    NUMERIC_SCALE as num_scale
                FROM information_schema.columns
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            "#
            .to_string()
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
                let char_max_len: Option<i64> = row.get("char_max_length");
                let num_precision: Option<i64> = row.get("num_precision");
                let num_scale: Option<i64> = row.get("num_scale");
                ColumnInfo {
                    name: row.get("column_name"),
                    data_type: row.get("data_type"),
                    nullable: is_nullable == "YES",
                    is_primary_key: column_key == "PRI",
                    default_value: row.get("column_default"),
                    comment: row.get("column_comment"),
                    character_maximum_length: char_max_len,
                    numeric_precision: num_precision,
                    numeric_scale: num_scale,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = r#"
            SELECT CAST(SCHEMA_NAME AS CHAR) as schema_name
            FROM information_schema.schemata
            ORDER BY SCHEMA_NAME
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let schemas = rows
            .iter()
            .map(|row| row.get::<String, _>("schema_name"))
            .collect();
        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::MySQL
    }

    /// FIX Bug #2: Use SHOW CREATE TABLE with fallback to INFORMATION_SCHEMA
    /// If SHOW CREATE TABLE fails (e.g. permission denied on system tables), construct DDL manually
    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let full_table = mysql_full_table(table, schema);

        // Try SHOW CREATE TABLE first — gives the most complete DDL
        let sql = format!("SHOW CREATE TABLE {}", full_table);
        match self.query_sql(&sql).await {
            Ok(result) => {
                if let Some(row) = result.rows.first() {
                    // SHOW CREATE TABLE returns "Create Table" column for tables
                    if let Some(create_sql) = row.get("Create Table").and_then(|v| v.as_str()) {
                        return Ok(format!("{};\n", create_sql));
                    }
                    // For views, the column name is "Create View"
                    if let Some(create_sql) = row.get("Create View").and_then(|v| v.as_str()) {
                        return Ok(format!("{};\n", create_sql));
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "SHOW CREATE TABLE failed for {}, falling back to INFORMATION_SCHEMA: {}",
                    full_table,
                    e
                );
            }
        }

        // Fallback: construct DDL from INFORMATION_SCHEMA
        let columns = self.get_columns(table, schema).await?;
        if columns.is_empty() {
            return Err(DbError::QueryError(format!(
                "No columns found for table {}",
                full_table
            )));
        }

        let col_defs: Vec<String> = columns
            .iter()
            .map(|col| {
                let null_str = if col.nullable { "" } else { " NOT NULL" };
                let default_str = match &col.default_value {
                    Some(d) => format!(" DEFAULT {}", d),
                    None => String::new(),
                };
                let comment_str = match &col.comment {
                    Some(c) if !c.is_empty() => {
                        format!(" COMMENT '{}'", c.replace('\'', "''"))
                    }
                    _ => String::new(),
                };
                format!(
                    "    {} {}{}{}{}",
                    mysql_quote_ident(&col.name),
                    col.data_type,
                    null_str,
                    default_str,
                    comment_str
                )
            })
            .collect();

        let pk_cols: Vec<String> = columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| mysql_quote_ident(&c.name))
            .collect();
        let pk_clause = if pk_cols.is_empty() {
            String::new()
        } else {
            format!(",\n    PRIMARY KEY ({})", pk_cols.join(", "))
        };

        Ok(format!(
            "-- Table: {}\nCREATE TABLE {} (\n{}{}\n);\n",
            full_table,
            full_table,
            col_defs.join(",\n"),
            pk_clause
        ))
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let schema_filter = match schema {
            Some(s) => format!("WHERE TABLE_SCHEMA = '{}'", s.replace('\'', "''")),
            None => String::new(),
        };
        let sql = format!(
            "SELECT CAST(TABLE_NAME AS CHAR) as table_name, CAST(TABLE_SCHEMA AS CHAR) as table_schema, \
             CAST(TABLE_COMMENT AS CHAR) as table_comment, 'VIEW' as table_type \
             FROM information_schema.views \
             {} ORDER BY TABLE_SCHEMA, TABLE_NAME",
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
                comment: row
                    .get("table_comment")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty()),
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
        let sql = match schema {
            Some(s) if !s.is_empty() => {
                format!(
                    "SHOW INDEX FROM {} FROM {}",
                    mysql_quote_ident(table),
                    mysql_quote_ident(s)
                )
            }
            _ => format!("SHOW INDEX FROM {}", mysql_quote_ident(table)),
        };
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
        let schema_filter = match schema {
            Some(s) if !s.is_empty() => {
                format!("AND TABLE_SCHEMA = '{}'", s.replace('\'', "''"))
            }
            _ => "AND TABLE_SCHEMA = DATABASE()".to_string(),
        };
        let sql = format!(
            r#"
            SELECT CAST(CONSTRAINT_NAME AS CHAR) as CONSTRAINT_NAME,
                   CAST(COLUMN_NAME AS CHAR) as COLUMN_NAME,
                   CAST(REFERENCED_TABLE_SCHEMA AS CHAR) as REFERENCED_TABLE_SCHEMA,
                   CAST(REFERENCED_TABLE_NAME AS CHAR) as REFERENCED_TABLE_NAME,
                   CAST(REFERENCED_COLUMN_NAME AS CHAR) as REFERENCED_COLUMN_NAME
            FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE TABLE_NAME = '{}' AND REFERENCED_TABLE_NAME IS NOT NULL {}
            "#,
            table.replace('\'', "''"),
            schema_filter
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
        let full_table = mysql_full_table(table, schema);
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

    /// FIX Bug #1: Use backtick quoting for MySQL identifiers
    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let full_table = mysql_full_table(table, schema);
        let order_clause = order_by
            .map(|o| format!(" ORDER BY {}", o))
            .unwrap_or_default();
        let offset = (page - 1) * page_size;
        let sql = format!(
            "SELECT * FROM {}{} LIMIT {} OFFSET {}",
            full_table, order_clause, page_size, offset
        );
        let mut result = self.query_sql(&sql).await?;
        // When the table is empty, query_sql returns no columns.
        // Populate column metadata from get_columns so the frontend can still show headers.
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
        crate::db::trait_def::sanitize_where_clause(where_clause)
            .map_err(|e| DbError::QueryError(e))?;
        let full_table = mysql_full_table(table, schema);
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| {
                format!("{} = {}", mysql_quote_ident(col), json_value_to_sql(val))
            })
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
        let full_table = mysql_full_table(table, schema);
        let columns: Vec<String> = values.iter().map(|(c, _)| mysql_quote_ident(c)).collect();
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
        crate::db::trait_def::sanitize_where_clause(where_clause)
            .map_err(|e| DbError::QueryError(e))?;
        let full_table = mysql_full_table(table, schema);
        let sql = format!("DELETE FROM {} WHERE {}", full_table, where_clause);
        self.execute_sql(&sql).await
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
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        });
    }
    result
}
