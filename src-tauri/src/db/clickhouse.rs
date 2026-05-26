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
        let query_url = format!("{}/?database={}", self.url, self.database);
        let resp = self
            .build_request(reqwest::Method::POST, &query_url)
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| DbError::QueryError(format!("{} execute transport failed: {}", self.ctx(), e)))?;

        let elapsed = start.elapsed().as_millis() as u64;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::QueryError(format!(
                "{} execute error ({}): {}",
                self.ctx(), status, body
            )));
        }

        let body = resp.text().await.unwrap_or_default();
        // ClickHouse HTTP response: "Ok.\nN rows in set. ..." or X-ClickHouse-Summary header
        let rows_affected = if body.contains("Ok.") {
            body.lines()
                .find(|l| l.contains("rows in set") || l.contains("row in set"))
                .and_then(|line| line.split_whitespace().next())
                .and_then(|n| n.parse::<u64>().ok())
                .unwrap_or(0)
        } else {
            0
        };

        Ok(ExecuteResult {
            rows_affected,
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = std::time::Instant::now();

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
            .map_err(|e| DbError::QueryError(format!("{} query transport failed: {}", self.ctx(), e)))?;

        let elapsed = start.elapsed().as_millis() as u64;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(DbError::QueryError(format!(
                "{} query error ({}): {}",
                self.ctx(), status, body
            )));
        }

        // Defensive: ClickHouse honours the `FORMAT JSONEachRow` clause we add to
        // every read query, but a misconfigured server / proxy could rewrite the
        // response to e.g. text/html (error page) or text/tab-separated-values.
        // If the content-type signals anything other than JSON variants, log a
        // warning so support can spot silent format negotiation failures.
        if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
            let ct_str = ct.to_str().unwrap_or("");
            if !ct_str.is_empty() && !ct_str.contains("json") && !ct_str.contains("x-ndjson") {
                log::warn!(
                    "{} unexpected Content-Type '{}' (expected JSONEachRow); rows may be dropped",
                    self.ctx(), ct_str
                );
            }
        }

        let body = resp
            .text()
            .await
            .map_err(|e| DbError::QueryError(format!("{} failed to read response body: {}", self.ctx(), e)))?;

        if body.trim().is_empty() {
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                execution_time_ms: elapsed,
            });
        }

        let mut result_rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
        let mut columns: Vec<ColumnInfo> = Vec::new();

        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).map_err(|e| {
                    DbError::QueryError(format!("{} failed to parse JSONEachRow line: {}", self.ctx(), e))
                })?;

            if columns.is_empty() {
                for (key, value) in &map {
                    columns.push(ColumnInfo {
                        name: key.clone(),
                        data_type: infer_clickhouse_type(value),
                        nullable: true,
                        is_primary_key: false,
                        default_value: None,
                        comment: None,
                        character_maximum_length: None,
                        numeric_precision: None,
                        numeric_scale: None,
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
