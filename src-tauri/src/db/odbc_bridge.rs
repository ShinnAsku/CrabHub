use async_trait::async_trait;
use std::time::Instant;

use odbc_api::{ConnectionOptions, Cursor, ResultSetMetadata};

use super::dialect::DialectConfig;
use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

/// ODBC bridge connection — wraps a synchronous ODBC connection and
/// delegates all I/O to `tokio::task::spawn_blocking`.
///
/// Used for databases that are not natively supported by sqlx:
/// Oracle, SQL Server, DaMeng (达梦), GBase (南大通用).
pub struct OdbcConnection {
    dialect: DialectConfig,
    connection_string: String,
}

impl OdbcConnection {
    /// Create a new ODBC bridge connection.
    ///
    /// The `connection_string` is an ODBC connection string such as
    /// `Driver={ODBC Driver 17 for SQL Server};Server=...;`.
    /// The actual TCP connection is lazily established on the first
    /// `spawn_blocking` call.
    pub fn new(dialect: DialectConfig, connection_string: String) -> Self {
        Self {
            dialect,
            connection_string,
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Replace `{schema}` and `{table}` placeholders inside metadata SQL strings.
fn replace_params(sql: &str, schema: Option<&str>, table: Option<&str>) -> String {
    let mut s = sql.to_string();
    if let Some(schema) = schema {
        s = s.replace("{schema}", schema);
    } else {
        s = s.replace("{schema}", "");
    }
    if let Some(table) = table {
        s = s.replace("{table}", table);
    } else {
        s = s.replace("{table}", "");
    }
    s
}

/// Describe columns from a cursor and return `ColumnInfo` vec.
fn describe_columns_from_cursor(
    cursor: &mut impl ResultSetMetadata,
) -> Result<Vec<ColumnInfo>, DbError> {
    let col_count = cursor
        .num_result_cols()
        .map_err(|e| DbError::QueryError(format!("ODBC num_result_cols: {}", e)))?;

    let mut columns = Vec::with_capacity(col_count as usize);
    for i in 1..=col_count as u16 {
        let mut desc = odbc_api::handles::ColumnDescription::default();
        cursor
            .describe_col(i, &mut desc)
            .map_err(|e| DbError::QueryError(format!("ODBC describe_col {}: {}", i, e)))?;

        let name = desc
            .name_to_string()
            .map_err(|e| DbError::QueryError(format!("ODBC column name decode: {}", e)))?;
        let nullable = desc.could_be_nullable();
        let data_type = format!("{:?}", desc.data_type);

        columns.push(ColumnInfo {
            name,
            data_type,
            nullable,
            is_primary_key: false,
            default_value: None,
            comment: None,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        });
    }
    Ok(columns)
}

/// Fetch up to `max_rows` rows from a cursor, returning serde_json maps.
/// `col_names` must be the ordered list of column names from `describe_columns_from_cursor`.
fn fetch_rows_from_cursor(
    cursor: &mut impl Cursor,
    col_names: &[String],
    max_rows: usize,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, DbError> {
    let mut rows = Vec::new();
    while let Some(mut row) = cursor
        .next_row()
        .map_err(|e| DbError::QueryError(format!("ODBC next_row: {}", e)))?
    {
        let mut map = serde_json::Map::new();
        for (idx, name) in col_names.iter().enumerate() {
            let col_idx = (idx + 1) as u16;
            let mut buf: Vec<u8> = Vec::new();
            let value = match row.get_text(col_idx, &mut buf) {
                Ok(true) => serde_json::Value::String(
                    String::from_utf8_lossy(&buf).to_string(),
                ),
                _ => serde_json::Value::Null,
            };
            map.insert(name.clone(), value);
        }
        rows.push(map);

        if rows.len() >= max_rows {
            break;
        }
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Trait implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl DatabaseConnection for OdbcConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let conn_str = self.connection_string.clone();
        let sql = sql.to_string();

        tokio::task::spawn_blocking(move || -> Result<ExecuteResult, DbError> {
            let start = Instant::now();

            let env = odbc_api::Environment::new()
                .map_err(|e| DbError::ConnectionError(format!("ODBC env init: {}", e)))?;
            let _conn = env
                .connect_with_connection_string(&conn_str, ConnectionOptions::default())
                .map_err(|e| DbError::ConnectionError(format!("ODBC connect: {}", e)))?;

            let _ = _conn
                .execute(&sql, ())
                .map_err(|e| DbError::QueryError(format!("ODBC execute: {}", e)))?;

            // ODBC driver reports row count via SQLRowCount on the statement handle,
            // but odbc-api only exposes it on Preallocated/Prepared types.
            // For the initial implementation we return 0.
            let elapsed = start.elapsed().as_millis() as u64;
            Ok(ExecuteResult {
                rows_affected: 0,
                execution_time_ms: elapsed,
            })
        })
        .await
        .map_err(|e| DbError::Internal(format!("spawn_blocking: {}", e)))?
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let conn_str = self.connection_string.clone();
        let sql = sql.to_string();

        tokio::task::spawn_blocking(move || -> Result<QueryResult, DbError> {
            let start = Instant::now();

            let env = odbc_api::Environment::new()
                .map_err(|e| DbError::ConnectionError(format!("ODBC env init: {}", e)))?;
            let _conn = env
                .connect_with_connection_string(&conn_str, ConnectionOptions::default())
                .map_err(|e| DbError::ConnectionError(format!("ODBC connect: {}", e)))?;

            let mut cursor = _conn
                .execute(&sql, ())
                .map_err(|e| DbError::QueryError(format!("ODBC query: {}", e)))?
                .ok_or_else(|| {
                    DbError::QueryError("ODBC query returned no result set".into())
                })?;

            // Describe columns
            let columns = describe_columns_from_cursor(&mut cursor)?;

            // Collect column names for row fetching
            let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

            // Fetch up to 500 rows
            let rows = fetch_rows_from_cursor(&mut cursor, &col_names, 500)?;

            let elapsed = start.elapsed().as_millis() as u64;
            let row_count = rows.len() as u64;

            Ok(QueryResult {
                columns,
                rows,
                row_count,
                execution_time_ms: elapsed,
            })
        })
        .await
        .map_err(|e| DbError::Internal(format!("spawn_blocking: {}", e)))?
    }

    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        // Inject dialect-specific LIMIT/OFFSET syntax, requesting limit+1 rows
        // to detect whether more data exists.
        let limited_sql = match self.dialect.limit_syntax {
            super::dialect::LimitSyntax::LimitOffset => {
                format!("{} LIMIT {} OFFSET {}", sql, limit + 1, offset)
            }
            super::dialect::LimitSyntax::FetchNext => {
                format!(
                    "{} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
                    sql,
                    offset,
                    limit + 1
                )
            }
            super::dialect::LimitSyntax::TopN => {
                // SQL Server-style TOP with subquery for offset
                format!(
                    "SELECT * FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS _odbc_rn \
                     FROM ({}) AS _inner) AS _outer \
                     WHERE _odbc_rn > {} AND _odbc_rn <= {}",
                    sql,
                    offset,
                    offset + limit + 1
                )
            }
        };

        let result = self.query_sql(&limited_sql).await?;
        let has_more = result.rows.len() as u64 > limit;
        let rows = if has_more {
            result
                .rows
                .into_iter()
                .take(limit as usize)
                .collect()
        } else {
            result.rows
        };

        Ok((QueryResult { rows, ..result }, has_more))
    }

    fn db_type(&self) -> DatabaseType {
        self.dialect.db_type.clone()
    }

    async fn close(&self) {
        // ODBC resources are released on drop.
    }

    // ------------------------------------------------------------------
    // Metadata helpers
    // ------------------------------------------------------------------

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = replace_params(self.dialect.metadata_queries.list_tables, None, None);
        let result = self.query_sql(&sql).await?;

        let tables: Vec<TableInfo> = result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .get("TABLE_NAME")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let schema = row
                    .get("OWNER")
                    .or_else(|| row.get("TABLE_SCHEMA"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let table_type = row
                    .get("TABLE_TYPE")
                    .and_then(|v| v.as_str())
                    .unwrap_or("BASE TABLE")
                    .to_string();
                TableInfo {
                    name,
                    schema,
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
        let sql = replace_params(
            self.dialect.metadata_queries.list_columns,
            schema,
            Some(table),
        );
        let result = self.query_sql(&sql).await?;

        let columns: Vec<ColumnInfo> = result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .get("COLUMN_NAME")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let data_type = row
                    .get("DATA_TYPE")
                    .and_then(|v| v.as_str())
                    .unwrap_or("UNKNOWN")
                    .to_string();
                let nullable = match row.get("NULLABLE").and_then(|v| v.as_str()) {
                    Some("Y" | "YES" | "1") => true,
                    Some("N" | "NO" | "0") => false,
                    _ => true,
                };
                let default_value = row
                    .get("DATA_DEFAULT")
                    .or_else(|| row.get("COLUMN_DEFAULT"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let char_len = row
                    .get("CHAR_LENGTH")
                    .or_else(|| row.get("CHARACTER_MAXIMUM_LENGTH"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<i64>().ok());
                let precision = row
                    .get("DATA_PRECISION")
                    .or_else(|| row.get("NUMERIC_PRECISION"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<i64>().ok());
                let scale = row
                    .get("DATA_SCALE")
                    .or_else(|| row.get("NUMERIC_SCALE"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<i64>().ok());

                ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    is_primary_key: false,
                    default_value,
                    comment: None,
                    character_maximum_length: char_len,
                    numeric_precision: precision,
                    numeric_scale: scale,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = replace_params(self.dialect.metadata_queries.list_schemas, None, None);
        let result = self.query_sql(&sql).await?;
        let schemas: Vec<String> = result
            .rows
            .iter()
            .filter_map(|row| {
                row.get("USERNAME")
                    .or_else(|| row.get("SCHEMA_NAME"))
                    .or_else(|| row.values().next())
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        Ok(schemas)
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let columns = self.get_columns(table, schema).await?;
        let schema_prefix = schema
            .map(|s| format!("{}.", s))
            .unwrap_or_default();
        let col_defs: Vec<String> = columns
            .iter()
            .map(|c| format!("    {} {}", c.name, c.data_type))
            .collect();
        Ok(format!(
            "-- Table: {}{}\nCREATE TABLE {}{} (\n{}\n);\n",
            schema_prefix,
            table,
            schema_prefix,
            table,
            col_defs.join(",\n")
        ))
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let sql = replace_params(self.dialect.metadata_queries.list_views, schema, None);
        let result = self.query_sql(&sql).await?;

        let views: Vec<TableInfo> = result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .get("VIEW_NAME")
                    .or_else(|| row.get("TABLE_NAME"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let schema = row
                    .get("OWNER")
                    .or_else(|| row.get("TABLE_SCHEMA"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                TableInfo {
                    name,
                    schema,
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
                }
            })
            .collect();

        Ok(views)
    }

    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let sql = replace_params(
            self.dialect.metadata_queries.list_indexes,
            schema,
            Some(table),
        );
        let result = self.query_sql(&sql).await?;
        Ok(result
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
        let sql = replace_params(
            self.dialect.metadata_queries.list_foreign_keys,
            schema,
            Some(table),
        );
        let result = self.query_sql(&sql).await?;
        Ok(result
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
        let sql = replace_params(
            self.dialect.metadata_queries.table_row_count,
            schema,
            Some(table),
        );
        let result = self.query_sql(&sql).await?;
        if let Some(row) = result.rows.first() {
            if let Some(cnt) = row
                .values()
                .next()
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
            {
                return Ok(cnt);
            }
            if let Some(cnt) = row.values().next().and_then(|v| v.as_i64()) {
                return Ok(cnt as u64);
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
        let offset = ((page.saturating_sub(1)) * page_size) as u64;
        let limit = page_size as u64;

        let sql = match self.dialect.limit_syntax {
            super::dialect::LimitSyntax::LimitOffset => {
                format!(
                    "SELECT * FROM \"{}\"{} LIMIT {} OFFSET {}",
                    table, order_clause, limit, offset
                )
            }
            super::dialect::LimitSyntax::FetchNext => {
                format!(
                    "SELECT * FROM \"{}\"{} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
                    table, order_clause, offset, limit
                )
            }
            super::dialect::LimitSyntax::TopN => {
                format!("SELECT TOP {} * FROM \"{}\"{}", limit, table, order_clause)
            }
        };

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
        let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| {
                format!(
                    "{} = {}",
                    esc(col),
                    crate::db::trait_def::json_value_to_sql(val)
                )
            })
            .collect();
        let sql = format!(
            "UPDATE {} SET {} WHERE {}",
            esc(table),
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
        let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let columns: Vec<String> = values.iter().map(|(c, _)| esc(c)).collect();
        let value_strs: Vec<String> = values
            .iter()
            .map(|(_, val)| crate::db::trait_def::json_value_to_sql(val))
            .collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            esc(table),
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
        let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            esc(table),
            where_clause
        );
        self.execute_sql(&sql).await
    }
}
