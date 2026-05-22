//! GaussDB connection via gaussdb-rs (our pure Rust PG wire protocol driver)

use async_trait::async_trait;
use tokio::sync::Mutex;
use gaussdb_rs::{Client, Config as GConfig, QueryResult as GQueryResult, SslMode};
use serde_json::Value as JsonValue;

use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult,
    QueryResult, TableInfo,
};

pub struct GaussRsConnection {
    client: Mutex<Client>,
}

impl GaussRsConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let gconfig = GConfig::new()
            .host(config.host.as_deref().unwrap_or("localhost"))
            .port(config.port.unwrap_or(8000))
            .user(config.username.as_deref().unwrap_or("gaussdb"))
            .password(config.password.as_deref().unwrap_or(""))
            .dbname(config.database.as_deref().unwrap_or(""))
            .ssl_mode(SslMode::Disable);

        let client = Client::connect(&gconfig)
            .await
            .map_err(|e| DbError::ConnectionError(format!("gaussdb-rs: {}", e)))?;

        Ok(Self { client: Mutex::new(client) })
    }
}

#[async_trait]
impl DatabaseConnection for GaussRsConnection {
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let mut client = self.client.lock().await;
        let gr = client.query(sql).await.map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(convert_query_result(gr))
    }

    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let mut client = self.client.lock().await;
        let er = client.execute(sql).await.map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(ExecuteResult { rows_affected: er.rows_affected, execution_time_ms: 0 })
    }

    fn db_type(&self) -> DatabaseType { DatabaseType::GaussDB }

    async fn close(&self) {
        if let Ok(mut c) = self.client.try_lock() { let _ = c.close().await; }
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let result = self.query_sql(
            "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name"
        ).await?;
        Ok(result.rows.iter().map(|r| TableInfo {
            name: r.get("table_name").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            schema: r.get("table_schema").and_then(|v| v.as_str().map(String::from)),
            table_type: r.get("table_type").and_then(|v| v.as_str()).unwrap_or("TABLE").to_string(),
            row_count: None, comment: None, oid: None, owner: None, acl: None, primary_key: None,
            partition_of: None, has_indexes: None, has_triggers: None,
            engine: None, data_length: None, create_time: None, update_time: None, collation: None,
        }).collect())
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let s = schema.unwrap_or("public");
        let result = self.query_sql(&format!(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='{}' AND table_name='{}' ORDER BY ordinal_position", s, table
        )).await?;
        Ok(result.rows.iter().map(|r| ColumnInfo {
            name: r.get("column_name").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            data_type: r.get("data_type").and_then(|v| v.as_str().map(String::from)).unwrap_or("text".into()),
            nullable: r.get("is_nullable").and_then(|v| v.as_str()).unwrap_or("YES") == "YES",
            is_primary_key: false,
            default_value: r.get("column_default").and_then(|v| v.as_str().map(String::from)),
            comment: None,
            character_maximum_length: None, numeric_precision: None, numeric_scale: None,
        }).collect())
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let result = self.query_sql("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name").await?;
        Ok(result.rows.iter().filter_map(|r| r.get("schema_name").and_then(|v| v.as_str().map(String::from))).collect())
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let filter = schema.map(|s| format!("AND table_schema='{}'", s)).unwrap_or_default();
        let result = self.query_sql(&format!(
            "SELECT table_schema, table_name FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog','information_schema') {} ORDER BY table_schema, table_name", filter
        )).await?;
        Ok(result.rows.iter().map(|r| TableInfo {
            name: r.get("table_name").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            schema: r.get("table_schema").and_then(|v| v.as_str().map(String::from)),
            table_type: "VIEW".into(),
            row_count: None, comment: None, oid: None, owner: None, acl: None, primary_key: None,
            partition_of: None, has_indexes: None, has_triggers: None,
            engine: None, data_length: None, create_time: None, update_time: None, collation: None,
        }).collect())
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<JsonValue>, DbError> {
        let s = schema.unwrap_or("public");
        let result = self.query_sql(&format!(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='{}' AND tablename='{}'", s, table
        )).await?;
        Ok(result.rows.iter().map(|r| serde_json::json!({
            "index_name": r.get("indexname"),
            "index_def": r.get("indexdef"),
        })).collect())
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<JsonValue>, DbError> {
        let s = schema.unwrap_or("public");
        let result = self.query_sql(&format!(
            "SELECT tc.constraint_name, kcu.column_name, ccu.table_schema AS ft_schema, ccu.table_name AS ft_table, ccu.column_name AS ft_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='{}' AND tc.table_name='{}'", s, table
        )).await?;
        Ok(result.rows.iter().map(|r| serde_json::json!({
            "constraint_name": r.get("constraint_name"),
            "column_name": r.get("column_name"),
            "foreign_schema": r.get("ft_schema"),
            "foreign_table": r.get("ft_table"),
            "foreign_column": r.get("ft_column"),
        })).collect())
    }

    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        let s = schema.unwrap_or("public");
        let result = self.query_sql(&format!("SELECT COUNT(*) as cnt FROM \"{}\".\"{}\"", s, table)).await?;
        Ok(result.rows.first().and_then(|r| r.get("cnt").and_then(|v| v.as_u64())).unwrap_or(0))
    }

    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        let s = schema.unwrap_or("public");
        let offset = (page.saturating_sub(1) as u64) * (page_size as u64);
        let order = order_by.unwrap_or("1");
        self.query_sql(&format!("SELECT * FROM \"{}\".\"{}\" ORDER BY {} LIMIT {} OFFSET {}", s, table, order, page_size, offset)).await
    }

    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, JsonValue)], where_clause: &str) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("public");
        let set: Vec<String> = updates.iter().map(|(col, val)| format!("\"{}\"={}", col, to_sql(val))).collect();
        self.execute_sql(&format!("UPDATE \"{}\".\"{}\" SET {} WHERE {}", s, table, set.join(","), where_clause)).await
    }

    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, JsonValue)]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("public");
        let cols: Vec<_> = values.iter().map(|(c,_)| format!("\"{}\"", c)).collect();
        let vals: Vec<_> = values.iter().map(|(_,v)| to_sql(v)).collect();
        self.execute_sql(&format!("INSERT INTO \"{}\".\"{}\" ({}) VALUES ({})", s, table, cols.join(","), vals.join(","))).await
    }

    async fn delete_table_rows(&self, table: &str, schema: Option<&str>, where_clause: &str) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("public");
        self.execute_sql(&format!("DELETE FROM \"{}\".\"{}\" WHERE {}", s, table, where_clause)).await
    }

    async fn query_sql_paged(&self, sql: &str, limit: u64, offset: u64) -> Result<(QueryResult, bool), DbError> {
        let paged = format!("{} LIMIT {} OFFSET {}", sql, limit + 1, offset);
        let mut r = self.query_sql(&paged).await?;
        let has_more = r.rows.len() as u64 > limit;
        if has_more { r.rows.truncate(limit as usize); }
        Ok((r, has_more))
    }

    async fn export_table_sql(&self, _table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        Ok(String::new())
    }
}

fn convert_query_result(gr: GQueryResult) -> QueryResult {
    let columns: Vec<ColumnInfo> = gr.columns.iter().map(|c| ColumnInfo {
        name: c.clone(), data_type: "text".into(), nullable: true, is_primary_key: false,
        default_value: None, comment: None,
        character_maximum_length: None, numeric_precision: None, numeric_scale: None,
    }).collect();
    let rows: Vec<serde_json::Map<String, JsonValue>> = gr.rows.into_iter()
        .map(|r| r.into_iter().collect())
        .collect();
    QueryResult { columns, rows, row_count: gr.row_count, execution_time_ms: 0 }
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
