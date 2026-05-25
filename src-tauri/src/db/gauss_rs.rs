//! GaussDB connection via tokio-gaussdb (Huawei official Rust driver)
//! Uses Extended Query (binary protocol). Client is &self-based internally,
//! so concurrent queries execute in parallel without a Mutex bottleneck.

use async_trait::async_trait;
use tokio_gaussdb::{Client as GClient, Config as GConfig, NoTls, SimpleQueryMessage, config::SslMode};
use serde_json::Value as JsonValue;

use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult,
    QueryResult, TableInfo,
};

pub struct GaussAsyncConnection {
    client: GClient,
}

impl GaussAsyncConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(8000);
        let user = config.username.as_deref().unwrap_or("gaussdb");
        let pass = config.password.as_deref().unwrap_or("");
        let db = config.database.as_deref().unwrap_or("");

        log::info!("tokio-gaussdb connecting: host={}, port={}, user={}, db={}, pass_len={}",
            host, port, user, db, pass.len());

        // tokio-gaussdb exposes a single Client per connection (no built-in pool).
        // Loudly inform users that the pool_options they configured are ignored
        // for GaussDB so they don't silently expect tuning that isn't wired.
        if config.pool_options.is_some() {
            log::warn!(
                "[gauss_rs] pool_options provided for connection '{}' but the tokio-gaussdb driver \
                 does not support connection pooling; settings will be ignored. \
                 Consider using the PostgreSQL driver via pg_compatible if pooling is required.",
                config.name
            );
        }

        let mut gconfig = GConfig::new();
        gconfig
            .host(host)
            .port(port)
            .user(user)
            .password(pass)
            .dbname(db)
            .ssl_mode(SslMode::Disable);

        let (client, connection) = gconfig.connect(NoTls).await.map_err(|e| {
            log::error!("tokio-gaussdb connect error: {}", e);
            DbError::ConnectionError(format!("tokio-gaussdb: {}", e))
        })?;

        // Spawn the background connection task
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                log::error!("tokio-gaussdb connection error: {}", e);
            }
        });

        Ok(Self { client })
    }
}

#[async_trait]
impl DatabaseConnection for GaussAsyncConnection {
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        log::info!("[gauss_rs] query_sql: {}", &sql[..std::cmp::min(sql.len(), 200)]);
        let messages = self.client.simple_query(sql).await.map_err(|e| DbError::QueryError(e.to_string()))?;
        log::info!("[gauss_rs] query_sql: got {} messages", messages.len());
        for (i, msg) in messages.iter().enumerate() {
            match msg {
                tokio_gaussdb::SimpleQueryMessage::Row(_) => log::info!("[gauss_rs]   msg[{}]: Row", i),
                tokio_gaussdb::SimpleQueryMessage::CommandComplete(n) => log::info!("[gauss_rs]   msg[{}]: CommandComplete({})", i, n),
                tokio_gaussdb::SimpleQueryMessage::RowDescription(cols) => log::info!("[gauss_rs]   msg[{}]: RowDescription({} cols)", i, cols.len()),
                _ => log::info!("[gauss_rs]   msg[{}]: other", i),
            }
        }
        simple_query_to_result(messages)
    }

    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let affected = self.client.execute(sql, &[]).await.map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(ExecuteResult { rows_affected: affected, execution_time_ms: 0 })
    }

    fn db_type(&self) -> DatabaseType { DatabaseType::GaussDB }

    async fn close(&self) { /* connection task handles cleanup */ }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        self.query_sql("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name").await.map(|r| {
            r.rows.iter().map(|row| TableInfo {
                name: row.get("table_name").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
                schema: row.get("table_schema").and_then(|v| v.as_str().map(String::from)),
                table_type: row.get("table_type").and_then(|v| v.as_str()).unwrap_or("TABLE").to_string(),
                row_count: None, comment: None, oid: None, owner: None, acl: None, primary_key: None,
                partition_of: None, has_indexes: None, has_triggers: None,
                engine: None, data_length: None, create_time: None, update_time: None, collation: None,
            }).collect()
        })
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let s = schema.unwrap_or("public");
        let s_escaped = s.replace('\'', "''");
        let t_escaped = table.replace('\'', "''");
        self.query_sql(&format!("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='{}' AND table_name='{}' ORDER BY ordinal_position", s_escaped, t_escaped)).await.map(|r| {
            r.rows.iter().map(|row| ColumnInfo {
                name: row.get("column_name").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
                data_type: row.get("data_type").and_then(|v| v.as_str().map(String::from)).unwrap_or("text".into()),
                nullable: row.get("is_nullable").and_then(|v| v.as_str()).unwrap_or("YES") == "YES",
                is_primary_key: false,
                default_value: row.get("column_default").and_then(|v| v.as_str().map(String::from)),
                comment: None, character_maximum_length: None, numeric_precision: None, numeric_scale: None,
            }).collect()
        })
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema' ORDER BY nspname";
        let result = self.query_sql(sql).await?;
        let schemas: Vec<String> = result.rows.iter().filter_map(|row| {
            row.get("nspname").and_then(|v| v.as_str().map(String::from))
        }).collect();
        log::info!("[gauss_rs] get_schemas: {} schemas", schemas.len());
        Ok(schemas)
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let f = schema.map(|s| format!("AND table_schema='{}'", s.replace('\'', "''"))).unwrap_or_default();
        self.query_sql(&format!("SELECT table_schema, table_name FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog','information_schema') {} ORDER BY table_schema, table_name", f)).await.map(|r| {
            r.rows.iter().map(|row| TableInfo {
                name: row.get("table_name").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
                schema: row.get("table_schema").and_then(|v| v.as_str().map(String::from)),
                table_type: "VIEW".into(),
                row_count: None, comment: None, oid: None, owner: None, acl: None, primary_key: None,
                partition_of: None, has_indexes: None, has_triggers: None,
                engine: None, data_length: None, create_time: None, update_time: None, collation: None,
            }).collect()
        })
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<JsonValue>, DbError> {
        let s = schema.unwrap_or("public");
        let s_escaped = s.replace('\'', "''");
        let t_escaped = table.replace('\'', "''");
        self.query_sql(&format!("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='{}' AND tablename='{}'", s_escaped, t_escaped)).await.map(|r| {
            r.rows.iter().map(|row| serde_json::json!({"index_name": row.get("indexname"), "index_def": row.get("indexdef")})).collect()
        })
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<JsonValue>, DbError> {
        let s = schema.unwrap_or("public");
        let s_escaped = s.replace('\'', "''");
        let t_escaped = table.replace('\'', "''");
        self.query_sql(&format!("SELECT tc.constraint_name, kcu.column_name, ccu.table_schema AS ft_schema, ccu.table_name AS ft_table, ccu.column_name AS ft_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='{}' AND tc.table_name='{}'", s_escaped, t_escaped)).await.map(|r| {
            r.rows.iter().map(|row| serde_json::json!({"constraint_name": row.get("constraint_name"), "column_name": row.get("column_name"), "foreign_schema": row.get("ft_schema"), "foreign_table": row.get("ft_table"), "foreign_column": row.get("ft_column")})).collect()
        })
    }

    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        let s = schema.unwrap_or("public");
        self.query_sql(&format!("SELECT COUNT(*) as cnt FROM \"{}\".\"{}\"", s, table)).await.map(|r| {
            r.rows.first().and_then(|row| row.get("cnt").and_then(|v| v.as_u64())).unwrap_or(0)
        })
    }

    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        let s = schema.unwrap_or("public");
        let offset = (page.saturating_sub(1) as u64) * (page_size as u64);
        let order = order_by.unwrap_or("1");
        crate::db::trait_def::sanitize_order_by(order)?;
        self.query_sql(&format!("SELECT * FROM \"{}\".\"{}\" ORDER BY {} LIMIT {} OFFSET {}", s, table, order, page_size, offset)).await
    }

    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, JsonValue)], where_conditions: &[crate::db::types::WhereCondition]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("public");
        let set: Vec<String> = updates.iter().map(|(col, val)| format!("\"{}\"={}", col, to_sql(val))).collect();
        let where_sql = crate::db::trait_def::build_where_sql(
            where_conditions,
            &|c| format!("\"{}\"", c.replace('"', "\"\"")),
        )?;
        self.execute_sql(&format!("UPDATE \"{}\".\"{}\" SET {} WHERE {}", s, table, set.join(","), where_sql)).await
    }

    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, JsonValue)]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("public");
        let cols: Vec<_> = values.iter().map(|(c,_)| format!("\"{}\"", c)).collect();
        let vals: Vec<_> = values.iter().map(|(_,v)| to_sql(v)).collect();
        self.execute_sql(&format!("INSERT INTO \"{}\".\"{}\" ({}) VALUES ({})", s, table, cols.join(","), vals.join(","))).await
    }

    async fn delete_table_rows(&self, table: &str, schema: Option<&str>, where_conditions: &[crate::db::types::WhereCondition]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("public");
        let where_sql = crate::db::trait_def::build_where_sql(
            where_conditions,
            &|c| format!("\"{}\"", c.replace('"', "\"\"")),
        )?;
        self.execute_sql(&format!("DELETE FROM \"{}\".\"{}\" WHERE {}", s, table, where_sql)).await
    }

    async fn query_sql_paged(&self, sql: &str, limit: u64, _offset: u64) -> Result<(QueryResult, bool), DbError> {
        // SQL already has LIMIT limit+1 injected by sql_limiter::inject_limit_offset
        let mut r = self.query_sql(sql).await?;
        let has_more = r.rows.len() as u64 > limit;
        if has_more { r.rows.truncate(limit as usize); }
        Ok((r, has_more))
    }

    async fn export_table_sql(&self, _table: &str, _schema: Option<&str>) -> Result<String, DbError> { Ok(String::new()) }
}

/// Convert tokio-gaussdb simple_query results to CrabHub QueryResult.
///
/// Defensively prefer the explicit `RowDescription` message for column metadata
/// when present -- it carries the canonical column names from the server. We
/// fall back to inferring columns from the first `Row` only when no description
/// was sent (older GaussDB releases may omit it for trivial result sets).
fn simple_query_to_result(messages: Vec<SimpleQueryMessage>) -> Result<QueryResult, DbError> {
    let mut columns: Vec<ColumnInfo> = Vec::new();
    let mut rows: Vec<serde_json::Map<String, JsonValue>> = Vec::new();

    // Pre-scan for RowDescription so we seed columns from the server's
    // canonical metadata, regardless of the message order.
    for msg in &messages {
        if let SimpleQueryMessage::RowDescription(cols) = msg {
            columns = cols.iter().map(|c| ColumnInfo {
                name: c.name().to_string(),
                data_type: "text".into(),
                nullable: true, is_primary_key: false,
                default_value: None, comment: None,
                character_maximum_length: None, numeric_precision: None, numeric_scale: None,
            }).collect();
            break;
        }
    }

    for msg in messages {
        match msg {
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        data_type: "text".into(),
                        nullable: true, is_primary_key: false,
                        default_value: None, comment: None,
                        character_maximum_length: None, numeric_precision: None, numeric_scale: None,
                    }).collect();
                }
                let mut map = serde_json::Map::new();
                for (i, col) in row.columns().iter().enumerate() {
                    let val: JsonValue = match row.try_get::<usize>(i) {
                        Ok(Some(s)) => JsonValue::String(s.to_string()),
                        _ => JsonValue::Null,
                    };
                    map.insert(col.name().to_string(), val);
                }
                rows.push(map);
            }
            SimpleQueryMessage::CommandComplete(_) => {}
            _ => {}
        }
    }

    Ok(QueryResult { columns, rows: rows.clone(), row_count: rows.len() as u64, execution_time_ms: 0 })
}

fn to_sql(val: &JsonValue) -> String {
    match val {
        JsonValue::Null => "NULL".into(),
        JsonValue::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => format!("'{}'", s.replace('\'', "''")),
        _ => format!("'{}'", val.to_string().replace('\'', "''")),
    }
}
