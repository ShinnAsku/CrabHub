use async_trait::async_trait;
use sqlx::{Column, Row, TypeInfo};
use std::str::FromStr;
use std::time::{Duration, Instant};

use super::trait_def::{json_value_to_sql, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

// ============================================================================
// SQLite Connection
// ============================================================================

pub struct SQLiteConnection {
    pool: sqlx::SqlitePool,
}

impl SQLiteConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
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

        let options = sqlx::sqlite::SqliteConnectOptions::from_str(&connection_string)
            .map_err(|e| DbError::ConnectionError(format!("Invalid SQLite path: {}", e)))?
            .create_if_missing(true);

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .idle_timeout(Duration::from_secs(600))
            .max_lifetime(Duration::from_secs(1800))
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to SQLite: {}", e))
            })?;

        // Enable WAL mode to allow concurrent reads with a single writer
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&pool)
            .await
            .ok();
        sqlx::query("PRAGMA busy_timeout=5000")
            .execute(&pool)
            .await
            .ok();

        log::info!("Successfully connected to SQLite");

        Ok(Self { pool })
    }
}

/// Quote a SQLite identifier with double quotes
fn sqlite_quote_table(table: &str) -> String {
    format!("\"{}\"", table.replace('"', "\"\""))
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

        let mut result_rows = Vec::new();
        for row in &result {
            let mut map = serde_json::Map::new();
            for col in row.columns() {
                let name = col.name().to_string();
                let type_name = col.type_info().name();
                let value = match type_name {
                    "INTEGER" | "INT" | "BIGINT" => {
                        if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(v) = row.try_get::<i64, _>(col.name()) {
                            serde_json::Value::String(v.to_string())
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "REAL" | "FLOAT" | "DOUBLE" => {
                        if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(col.name()) {
                            serde_json::Value::from(v)
                        } else if let Ok(v) = row.try_get::<f64, _>(col.name()) {
                            serde_json::Value::from(v)
                        } else if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "NUMERIC" | "DECIMAL" => {
                        if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    "TEXT" | "VARCHAR" | "CHAR" => {
                        if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
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
                    "DATE" | "TIME" | "DATETIME" | "TIMESTAMP" => {
                        if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                            serde_json::Value::String(v)
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
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(
        &self,
        table: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
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
                    character_maximum_length: None,
                    numeric_precision: None,
                    numeric_scale: None,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        Ok(vec!["main".to_string()])
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::SQLite
    }

    async fn export_table_sql(
        &self,
        table: &str,
        _schema: Option<&str>,
    ) -> Result<String, DbError> {
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

        let col_defs: Vec<String> = cols
            .iter()
            .map(|row| {
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
                format!(
                    "    {} {}{}{}{}",
                    name, data_type, pk_str, null_str, default_str
                )
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
        self.pool.close().await;
    }

    async fn get_views(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let sql =
            "SELECT name, 'main' as schema FROM sqlite_master WHERE type = 'view' ORDER BY name";
        let rows = self.query_sql(sql).await?;
        let views = rows
            .rows
            .iter()
            .map(|row| TableInfo {
                name: row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                schema: Some("main".to_string()),
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
        _schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let sql = format!(
            "PRAGMA index_list(\"{}\")",
            table.replace('"', "\"\"")
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
        _schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let sql = format!(
            "PRAGMA foreign_key_list(\"{}\")",
            table.replace('"', "\"\"")
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
        _schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let sql = format!(
            "SELECT COUNT(*) as cnt FROM {}",
            sqlite_quote_table(table)
        );
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
        _schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let order_clause = order_by
            .map(|o| format!(" ORDER BY {}", o))
            .unwrap_or_default();
        let offset = (page - 1) * page_size;
        let sql = format!(
            "SELECT * FROM {}{} LIMIT {} OFFSET {}",
            sqlite_quote_table(table),
            order_clause,
            page_size,
            offset
        );
        let mut result = self.query_sql(&sql).await?;
        if result.columns.is_empty() {
            result.columns = self.get_columns(table, _schema).await.unwrap_or_default();
        }
        Ok(result)
    }

    async fn update_table_rows(
        &self,
        table: &str,
        _schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        crate::db::trait_def::sanitize_where_clause(where_clause)
            .map_err(|e| DbError::QueryError(e))?;
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| format!("{} = {}", sqlite_quote_table(col), json_value_to_sql(val)))
            .collect();
        let sql = format!(
            "UPDATE {} SET {} WHERE {}",
            sqlite_quote_table(table),
            set_clauses.join(", "),
            where_clause
        );
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        _schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        let columns: Vec<String> = values.iter().map(|(c, _)| sqlite_quote_table(c)).collect();
        let value_strs: Vec<String> = values.iter().map(|(_, val)| json_value_to_sql(val)).collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            sqlite_quote_table(table),
            columns.join(", "),
            value_strs.join(", ")
        );
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        _schema: Option<&str>,
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        crate::db::trait_def::sanitize_where_clause(where_clause)
            .map_err(|e| DbError::QueryError(e))?;
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            sqlite_quote_table(table),
            where_clause
        );
        self.execute_sql(&sql).await
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
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        });
    }
    result
}
