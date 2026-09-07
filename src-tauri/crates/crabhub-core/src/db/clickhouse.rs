use async_trait::async_trait;

use super::pool_config::PoolConfig;
use super::trait_def::{json_value_to_sql, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

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

        let scheme = if config.ssl_enabled {
            "https"
        } else {
            "http"
        };
        let url = format!("{}://{}:{}", scheme, host, port);

        log::info!("Connecting to ClickHouse at {}", url);

        // Apply per-connection pool overrides (max_connections → pool_max_idle_per_host,
        // idle_timeout_secs → pool_idle_timeout, acquire_timeout_secs → request timeout).
        let pool_cfg = PoolConfig::with_overrides(&DatabaseType::ClickHouse, config.pool_options.as_ref());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(pool_cfg.acquire_timeout_secs.max(1)))
            .pool_max_idle_per_host(pool_cfg.max_connections as usize)
            .pool_idle_timeout(Some(std::time::Duration::from_secs(pool_cfg.idle_timeout_secs)))
            .build()
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to create HTTP client: {}", e))
            })?;

        // Test connection with a simple query
        let resp = client.post(&url)
            .query(&[("database", database)])
            .basic_auth(username, Some(password))
            .body("SELECT 1 FORMAT JSONEachRow")
            .send()
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!(
                    "ClickHouse[{}/{}] handshake transport failed: {}",
                    url, database, e
                ))
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::ConnectionError(format!(
                "ClickHouse[{}/{}] handshake rejected ({}): {}",
                url, database, status, body
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

    /// Stable identifier used in every error message so support can correlate
    /// failures across logs without leaking the password (we deliberately
    /// include host/port/database but never credentials).
    fn ctx(&self) -> String {
        format!("ClickHouse[{}/{}]", self.url, self.database)
    }

    /// Return the database name with single quotes escaped for safe SQL interpolation.
    fn escaped_db(&self) -> String {
        self.database.replace('\'', "''")
    }
}

/// Build full table reference for ClickHouse
fn ch_quote_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

fn ch_full_table(table: &str, schema: Option<&str>) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", ch_quote_ident(s), ch_quote_ident(table)),
        _ => ch_quote_ident(table),
    }
}

#[async_trait]
impl DatabaseConnection for ClickHouseConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        let resp = self
            .build_request(reqwest::Method::POST, &self.url)
            .query(&[("database", self.database.as_str()), ("wait_end_of_query", "1")])
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| DbError::QueryError(format!("{} execute transport failed: {}", self.ctx(), e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::QueryError(format!(
                "{} execute error ({}): {}",
                self.ctx(), status, body
            )));
        }

        let rows_affected = resp.headers().get("X-ClickHouse-Summary")
            .and_then(|header| serde_json::from_slice::<serde_json::Value>(header.as_bytes()).ok())
            .and_then(|summary| summary.get("written_rows").and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok())))
            .unwrap_or(0);
        resp.text().await
            .map_err(|error| DbError::QueryError(format!("{} failed to read execution response: {}", self.ctx(), error)))?;

        Ok(ExecuteResult {
            rows_affected,
            execution_time_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = std::time::Instant::now();
        let sql = grid_query(sql);
        let resp = self
            .build_request(reqwest::Method::POST, &self.url)
            .query(&[("database", self.database.as_str()), ("default_format", "JSON"),
                ("output_format_json_quote_decimals", "1"), ("wait_end_of_query", "1")])
            .body(sql)
            .send()
            .await
            .map_err(|e| DbError::QueryError(format!("{} query transport failed: {}", self.ctx(), e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::QueryError(format!(
                "{} query error ({}): {}",
                self.ctx(), status, body
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| DbError::QueryError(format!("{} failed to read response body: {}", self.ctx(), e)))?;
        parse_query_result(&body, start.elapsed().as_millis() as u64)
            .map_err(|error| DbError::QueryError(format!("{} expected JSON with column metadata: {}", self.ctx(), error)))
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let db = self.database.replace('\'', "''");
        let sql = format!(
            "SELECT name, engine, total_rows, comment FROM system.tables WHERE database = '{}' ORDER BY name",
            db
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
                let total_rows = row.get("total_rows").and_then(|v| {
                    if v.is_null() {
                        None
                    } else {
                        Some(v.as_u64().unwrap_or(0))
                    }
                });
                let comment = row.get("comment").and_then(|v| {
                    let s = v.as_str().unwrap_or("");
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.to_string())
                    }
                });

                let table_type =
                    if engine.contains("View") || engine.contains("MATERIALIZED") {
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
        let sql = format!(
            "SELECT name, type, default_kind, default_expression, comment, is_in_primary_key \
             FROM system.columns \
             WHERE database = '{}' AND table = '{}' \
             ORDER BY position",
            self.escaped_db(), crate::db::trait_def::escape_sql_string(table)
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
                let default_expression = row.get("default_expression").and_then(|v| {
                    if v.is_null() {
                        None
                    } else {
                        Some(v.as_str().unwrap_or("").to_string())
                    }
                });
                let comment = row.get("comment").and_then(|v| {
                    let s = v.as_str().unwrap_or("");
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.to_string())
                    }
                });

                let nullable = data_type.starts_with("Nullable(");

                ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    is_primary_key,
                    default_value: default_expression,
                    comment,
                    character_maximum_length: None,
                    numeric_precision: None,
                    numeric_scale: None,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        Ok(vec![self.database.clone()])
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::ClickHouse
    }

    async fn export_table_sql(
        &self,
        table: &str,
        _schema: Option<&str>,
    ) -> Result<String, DbError> {
        let sql = format!(
            "SELECT name, type, default_kind, default_expression, comment \
             FROM system.columns \
             WHERE database = '{}' AND table = '{}' \
             ORDER BY position",
            self.escaped_db(), crate::db::trait_def::escape_sql_string(table)
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

    async fn get_views(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let sql = format!(
            "SELECT name, engine FROM system.tables WHERE database = '{}' AND engine LIKE '%View%' ORDER BY name",
            self.escaped_db()
        );
        let rows = self.query_sql(&sql).await?;
        let views = rows
            .rows
            .iter()
            .map(|row| TableInfo {
                name: row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                schema: None,
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
        let db = self.escaped_db();
        let t = crate::db::trait_def::escape_sql_string(table);
        let result = self.query_sql(&format!(
            "SELECT name, type, expr, granularity FROM system.data_skipping_indices \
             WHERE database = '{db}' AND table = '{t}'"
        )).await?;
        Ok(result.rows.into_iter().map(|r| serde_json::json!({
            "index_name": r.get("name"), "index_type": r.get("type"),
            "expression": r.get("expr"), "granularity": r.get("granularity"),
        })).collect())
    }

    async fn get_foreign_keys(
        &self,
        _table: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        // ClickHouse doesn't support foreign keys
        Ok(vec![])
    }

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let full_table = ch_full_table(table, schema);
        let sql = format!("SELECT COUNT() as cnt FROM {}", full_table);
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
        let full_table = ch_full_table(table, schema);
        let order_clause = if let Some(o) = order_by {
            crate::db::trait_def::sanitize_order_by(o)?;
            format!(" ORDER BY {}", o)
        } else {
            String::new()
        };
        let offset = (page.saturating_sub(1)) * page_size;
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
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let full_table = ch_full_table(table, schema);
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| format!("{} = {}", ch_quote_ident(col), json_value_to_sql(val)))
            .collect();
        let where_sql = crate::db::trait_def::build_where_sql(
            where_conditions,
            &|c| ch_quote_ident(c),
        )?;
        let sql = format!(
            "ALTER TABLE {} UPDATE {} WHERE {}",
            full_table,
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
        let full_table = ch_full_table(table, schema);
        let columns: Vec<String> = values.iter().map(|(c, _)| ch_quote_ident(c)).collect();
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
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let full_table = ch_full_table(table, schema);
        let where_sql = crate::db::trait_def::build_where_sql(
            where_conditions,
            &|c| ch_quote_ident(c),
        )?;
        let sql = format!(
            "ALTER TABLE {} DELETE WHERE {}",
            full_table, where_sql
        );
        self.execute_sql(&sql).await
    }
}

fn grid_query(sql: &str) -> String {
    use sqlparser::{ast::{FormatClause, Ident, Statement}, dialect::ClickHouseDialect, parser::Parser};
    if let Ok(mut statements) = Parser::parse_sql(&ClickHouseDialect {}, sql) {
        if statements.len() == 1 {
            if let Statement::Query(query) = &mut statements[0] {
                if query.format_clause.is_some() {
                    query.format_clause = Some(FormatClause::Identifier(Ident::new("JSON")));
                    return statements[0].to_string();
                }
            }
        }
    }
    sql.to_string()
}

fn parse_query_result(body: &str, elapsed: u64) -> Result<QueryResult, serde_json::Error> {
    #[derive(serde::Deserialize)]
    struct Metadata {
        name: String,
        #[serde(rename = "type")]
        data_type: String,
    }
    #[derive(serde::Deserialize)]
    struct Response {
        meta: Vec<Metadata>,
        data: Vec<serde_json::Map<String, serde_json::Value>>,
    }
    let response: Response = serde_json::from_str(body)?;
    let columns = response.meta.into_iter().map(|column| ColumnInfo {
        name: column.name,
        nullable: column.data_type.contains("Nullable("),
        data_type: column.data_type,
        is_primary_key: false, default_value: None, comment: None,
        character_maximum_length: None, numeric_precision: None, numeric_scale: None,
    }).collect();
    Ok(QueryResult { columns, row_count: response.data.len() as u64, rows: response.data, execution_time_ms: elapsed })
}

#[cfg(test)]
mod tests {
    use super::parse_query_result;

    #[test]
    fn explicit_formats_are_normalized_without_touching_literals() {
        for format in ["JSONEachRow", "CSV", "TabSeparated"] {
            let sql = super::grid_query(&format!("SELECT 'FORMAT CSV' AS value FORMAT {format}"));
            assert_eq!(sql, "SELECT 'FORMAT CSV' AS value FORMAT JSON");
        }
        assert_eq!(super::grid_query("SELECT 'FORMAT JSONEachRow' AS value"), "SELECT 'FORMAT JSONEachRow' AS value");
    }

    #[test]
    fn empty_results_preserve_server_metadata_order() {
        let result = parse_query_result(r#"{"meta":[{"name":"z","type":"Int32"},{"name":"a","type":"Nullable(String)"}],"data":[]}"#, 3).unwrap();
        assert_eq!(result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), ["z", "a"]);
        assert!(!result.columns[0].nullable);
        assert!(result.columns[1].nullable);
        assert_eq!(result.row_count, 0);
    }

    #[test]
    fn exact_decimal_text_is_not_coerced() {
        let result = parse_query_result(r#"{"meta":[{"name":"amount","type":"Decimal(38, 4)"}],"data":[{"amount":"12345678901234567890.1234"}]}"#, 0).unwrap();
        assert_eq!(result.rows[0]["amount"], "12345678901234567890.1234");
        assert_eq!(result.columns[0].data_type, "Decimal(38, 4)");
    }
}
