use async_trait::async_trait;
use sqlx::{Column, Row};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::dialect::DialectConfig;
use super::pg_utils;
use super::trait_def::{escape_identifier, json_value_to_sql, sanitize_where_clause, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

// ============================================================================
// PG Wire-Protocol Compatible Connection
// Acts as a base driver for any database speaking the PostgreSQL wire protocol.
// ============================================================================

pub struct PgCompatibleConnection {
    pool: sqlx::PgPool,
    dialect: DialectConfig,
    #[allow(dead_code)]
    cancel_token: CancellationToken,
}

impl PgCompatibleConnection {
    pub async fn new(config: &ConnectionConfig, dialect: DialectConfig) -> Result<Self, DbError> {
        use urlencoding::encode;

        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(dialect.default_port);
        let username = config.username.as_deref().unwrap_or("postgres");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");

        let conn_str = format!(
            "postgres://{}:{}@{}:{}/{}?sslmode=prefer",
            encode(username),
            encode(password),
            host,
            port,
            encode(database),
        );

        log::info!(
            "Connecting to PG-compatible database {} at {}:{}",
            database,
            host,
            port
        );

        let pc = crate::db::pool_config::PoolConfig::with_overrides(&config.db_type, config.pool_options.as_ref());
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(pc.max_connections)
            .idle_timeout(Duration::from_secs(pc.idle_timeout_secs))
            .max_lifetime(Duration::from_secs(pc.max_lifetime_secs))
            .acquire_timeout(Duration::from_secs(pc.acquire_timeout_secs))
            .connect(&conn_str)
            .await
            .map_err(|e| DbError::ConnectionError(format!("Failed to connect: {}", e)))?;

        log::info!("Successfully connected to PG-compatible database");

        Ok(Self {
            pool,
            dialect,
            cancel_token: CancellationToken::new(),
        })
    }

    /// Cancel the current running query by signalling the cancellation token.
    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }
}

// ============================================================================
// DatabaseConnection trait implementation
// ============================================================================

#[async_trait]
impl DatabaseConnection for PgCompatibleConnection {
    // ---------------------------------------------------------------------------
    // Core operations
    // ---------------------------------------------------------------------------

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

        let (columns, rows) = pg_utils::parse_pg_rows(&result);
        let row_count = rows.len() as u64;

        Ok(QueryResult {
            columns,
            rows,
            row_count,
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        _offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        // SQL already has LIMIT limit+1 injected — fetch_all is safe (bounded to ~1001 rows)
        let result = self.query_sql(sql).await?;
        let has_more = result.rows.len() as u64 > limit;
        let rows = if has_more {
            result.rows.into_iter().take(limit as usize).collect()
        } else {
            result.rows
        };
        Ok((QueryResult { rows, ..result }, has_more))
    }

    // ---------------------------------------------------------------------------
    // Metadata
    // ---------------------------------------------------------------------------

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_tables;
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let table_type: String = row
                    .try_get("table_type")
                    .unwrap_or_else(|_| "BASE TABLE".to_string());
                TableInfo {
                    name: row.get("table_name"),
                    schema: row.try_get("table_schema").ok(),
                    row_count: None,
                    comment: None,
                    table_type,
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
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = self.dialect.metadata_queries.list_columns;

        let rows = sqlx::query(sql)
            .bind(schema_name)
            .bind(table)
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
                    is_primary_key: false,
                    default_value: row.get("column_default"),
                    comment: None,
                    character_maximum_length: char_max_len.map(|v| v as i64),
                    numeric_precision: num_precision,
                    numeric_scale: num_scale,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = self.dialect.metadata_queries.list_schemas;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let schemas = rows.iter().map(|row| row.get::<String, _>(0)).collect();
        Ok(schemas)
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_views;

        let views_sql = match schema {
            Some(s) => format!(
                "{} AND table_schema = '{}'",
                sql,
                s.replace('\'', "''")
            ),
            None => sql.to_string(),
        };

        let rows = sqlx::query(&views_sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let views = rows
            .iter()
            .map(|row| TableInfo {
                name: row.get("table_name"),
                schema: row.try_get("table_schema").ok(),
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
        let sql = self.dialect.metadata_queries.list_indexes;

        let rows = sqlx::query(sql)
            .bind(schema_name)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let indexes: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| {
                let mut map = serde_json::Map::new();
                for col in row.columns() {
                    let name = col.name().to_string();
                    let value: serde_json::Value = row
                        .try_get::<Option<String>, _>(col.name())
                        .ok()
                        .flatten()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null);
                    map.insert(name, value);
                }
                serde_json::Value::Object(map)
            })
            .collect();

        Ok(indexes)
    }

    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = self.dialect.metadata_queries.list_foreign_keys;

        let rows = sqlx::query(sql)
            .bind(schema_name)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let fks: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| {
                let mut map = serde_json::Map::new();
                for col in row.columns() {
                    let name = col.name().to_string();
                    let value: serde_json::Value = row
                        .try_get::<Option<String>, _>(col.name())
                        .ok()
                        .flatten()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null);
                    map.insert(name, value);
                }
                serde_json::Value::Object(map)
            })
            .collect();

        Ok(fks)
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = self.dialect.metadata_queries.list_columns;

        let rows = sqlx::query(sql)
            .bind(schema_name)
            .bind(table)
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

    // ---------------------------------------------------------------------------
    // Data operations
    // ---------------------------------------------------------------------------

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let full_table_ref = pg_utils::full_table(table, schema);
        let sql = format!("SELECT COUNT(*) as cnt FROM {}", full_table_ref);
        let rows = self.query_sql(&sql).await?;
        if let Some(row) = rows.rows.first() {
            if let Some(cnt) = row
                .get("cnt")
                .and_then(|v| v.as_u64())
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
        let full_table_ref = pg_utils::full_table(table, schema);
        let order_clause = if let Some(o) = order_by {
            crate::db::trait_def::sanitize_order_by(o)?;
            format!(" ORDER BY {}", o)
        } else {
            String::new()
        };
        let offset = (page - 1) * page_size;
        let sql = format!(
            "SELECT * FROM {}{} LIMIT {} OFFSET {}",
            full_table_ref, order_clause, page_size, offset
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
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let full_table_ref = pg_utils::full_table_quoted(table, schema);
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| {
                format!(
                    "{} = {}",
                    escape_identifier(col, &self.dialect.db_type),
                    json_value_to_sql(val)
                )
            })
            .collect();
        let db_type = self.dialect.db_type.clone();
        let where_sql = crate::db::trait_def::build_where_sql(
            where_conditions,
            &|c| escape_identifier(c, &db_type),
        )?;
        let sql = format!(
            "UPDATE {} SET {} WHERE {}",
            full_table_ref,
            set_clauses.join(", "),
            where_sql
        );
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        let full_table_ref = pg_utils::full_table_quoted(table, schema);
        let columns: Vec<String> = values
            .iter()
            .map(|(c, _)| escape_identifier(c, &self.dialect.db_type))
            .collect();
        let value_strs: Vec<String> =
            values.iter().map(|(_, val)| json_value_to_sql(val)).collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            full_table_ref,
            columns.join(", "),
            value_strs.join(", ")
        );
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let full_table_ref = pg_utils::full_table_quoted(table, schema);
        let db_type = self.dialect.db_type.clone();
        let where_sql = crate::db::trait_def::build_where_sql(
            where_conditions,
            &|c| escape_identifier(c, &db_type),
        )?;
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            full_table_ref, where_sql
        );
        self.execute_sql(&sql).await
    }

    // ---------------------------------------------------------------------------
    // Connection identity & lifecycle
    // ---------------------------------------------------------------------------

    fn db_type(&self) -> DatabaseType {
        self.dialect.db_type.clone()
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}
