use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tiberius::{AuthMethod, Client, Config, QueryItem};
use futures_util::StreamExt;

use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

type TClient = Client<Compat<TcpStream>>;

pub struct SqlServerConnection {
    client: Arc<Mutex<TClient>>,
}

impl SqlServerConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(1433);
        let username = config.username.as_deref().unwrap_or("sa");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("master");
        let mut tc = Config::new();
        tc.host(host); tc.port(port); tc.database(database);
        tc.authentication(AuthMethod::sql_server(username, password));
        tc.trust_cert();
        let addr = format!("{}:{}", host, port);
        let tcp = TcpStream::connect(&addr).await
            .map_err(|e| DbError::ConnectionError(format!("SQLServer: {}", e)))?;
        tcp.set_nodelay(true).ok();
        let client = Client::connect(tc, tcp.compat_write()).await
            .map_err(|e| DbError::ConnectionError(format!("SQLServer: {}", e)))?;
        log::info!("SQLServer connected to {}", addr);
        Ok(Self { client: Arc::new(Mutex::new(client)) })
    }

    async fn run_query(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = std::time::Instant::now();
        let mut client = self.client.lock().await;
        let mut stream = client.simple_query(sql).await
            .map_err(|e| DbError::QueryError(format!("SQLServer: {}", e)))?;
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut col_names: Vec<String> = Vec::new();
        let mut rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
        while let Some(item) = stream.next().await {
            match item.map_err(|e| DbError::QueryError(format!("SQLServer: {}", e)))? {
                QueryItem::Metadata(cols) => {
                    let cs = cols.columns();
                    columns = cs.iter().map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        data_type: format!("{:?}", c.column_type()).to_lowercase(),
                        nullable: true, is_primary_key: false,
                        default_value: None, comment: None,
                        character_maximum_length: None, numeric_precision: None, numeric_scale: None,
                    }).collect();
                    col_names = cs.iter().map(|c| c.name().to_string()).collect();
                }
                QueryItem::Row(row) => {
                    let mut map = serde_json::Map::new();
                    for name in &col_names {
                        let val: serde_json::Value = row.try_get::<&str, _>(name.as_str()).ok().flatten()
                            .map(|s: &str| serde_json::Value::String(s.to_string()))
                            .or_else(|| row.try_get::<i32, _>(name.as_str()).ok().flatten()
                                .map(|v| serde_json::Value::Number(serde_json::Number::from(v))))
                            .or_else(|| row.try_get::<i64, _>(name.as_str()).ok().flatten()
                                .map(|v| serde_json::Value::Number(serde_json::Number::from(v))))
                            .or_else(|| row.try_get::<f64, _>(name.as_str()).ok().flatten()
                                .and_then(|v| serde_json::Number::from_f64(v))
                                .map(serde_json::Value::Number))
                            .or_else(|| row.try_get::<bool, _>(name.as_str()).ok().flatten()
                                .map(serde_json::Value::Bool))
                            .unwrap_or(serde_json::Value::Null);
                        map.insert(name.clone(), val);
                    }
                    rows.push(map);
                }
            }
        }
        Ok(QueryResult { columns, rows: rows.clone(), row_count: rows.len() as u64, execution_time_ms: start.elapsed().as_millis() as u64 })
    }

    async fn query_strings(&self, sql: &str) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, DbError> {
        Ok(self.run_query(sql).await?.rows)
    }
}

#[async_trait]
impl DatabaseConnection for SqlServerConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        let mut client = self.client.lock().await;
        client.simple_query(sql).await
            .map_err(|e| DbError::QueryError(format!("SQLServer: {}", e)))?;
        // tiberius 0.12 simple_query does not expose rows_affected.
        // Upgrade to tiberius 1.x for proper execute() with affected row count.
        Ok(ExecuteResult { rows_affected: 0, execution_time_ms: start.elapsed().as_millis() as u64 })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> { self.run_query(sql).await }
    fn db_type(&self) -> DatabaseType { DatabaseType::SQLServer }
    async fn close(&self) {}

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let rows = self.query_strings("SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME").await?;
        Ok(rows.iter().map(|row| TableInfo {
            name: row.get("TABLE_NAME").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            schema: row.get("TABLE_SCHEMA").and_then(|v| v.as_str().map(String::from)),
            table_type: row.get("TABLE_TYPE").and_then(|v| v.as_str()).unwrap_or("TABLE").to_string(),
            row_count: None, comment: None, oid: None, owner: None, acl: None, primary_key: None,
            partition_of: None, has_indexes: None, has_triggers: None,
            engine: None, data_length: None, create_time: None, update_time: None, collation: None,
        }).collect())
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let s = schema.unwrap_or("dbo");
        let rows = self.query_strings(&format!(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='{}' AND TABLE_NAME='{}' ORDER BY ORDINAL_POSITION",
            s.replace('\'', "''"), table.replace('\'', "''")
        )).await?;
        Ok(rows.iter().map(|row| ColumnInfo {
            name: row.get("COLUMN_NAME").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            data_type: row.get("DATA_TYPE").and_then(|v| v.as_str().map(String::from)).unwrap_or("nvarchar".into()),
            nullable: row.get("IS_NULLABLE").and_then(|v| v.as_str()).unwrap_or("YES") == "YES",
            is_primary_key: false, default_value: None, comment: None,
            character_maximum_length: None, numeric_precision: None, numeric_scale: None,
        }).collect())
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let rows = self.query_strings("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME").await?;
        Ok(rows.iter().filter_map(|r| r.get("SCHEMA_NAME").and_then(|v| v.as_str().map(String::from))).collect())
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let f = schema.map(|s| format!("AND TABLE_SCHEMA='{}'", s.replace('\'', "''"))).unwrap_or_default();
        let rows = self.query_strings(&format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE 1=1 {} ORDER BY TABLE_SCHEMA, TABLE_NAME", f
        )).await?;
        Ok(rows.iter().map(|row| TableInfo {
            name: row.get("TABLE_NAME").and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            schema: row.get("TABLE_SCHEMA").and_then(|v| v.as_str().map(String::from)),
            table_type: "VIEW".into(),
            row_count: None, comment: None, oid: None, owner: None, acl: None, primary_key: None,
            partition_of: None, has_indexes: None, has_triggers: None,
            engine: None, data_length: None, create_time: None, update_time: None, collation: None,
        }).collect())
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<serde_json::Value>, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_esc = s.replace('\'', "''");
        let t_esc = table.replace('\'', "''");
        self.query_strings(&format!(
            "SELECT i.name AS idx, i.is_unique, i.is_primary_key, STRING_AGG(c.name,',') AS cols \
             FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id \
             JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id \
             JOIN sys.tables t ON i.object_id=t.object_id \
             JOIN sys.schemas sc ON t.schema_id=sc.schema_id \
             WHERE sc.name='{s_esc}' AND t.name='{t_esc}' GROUP BY i.name,i.is_unique,i.is_primary_key"
        )).await.map(|r| r.into_iter().map(|row| serde_json::json!({
            "index_name": row.get("idx"), "columns": row.get("cols"),
            "is_unique": row.get("is_unique"), "is_primary_key": row.get("is_primary_key"),
        })).collect())
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<serde_json::Value>, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_esc = s.replace('\'', "''");
        let t_esc = table.replace('\'', "''");
        self.query_strings(&format!(
            "SELECT fk.name AS cn, c1.name AS col, sc2.name AS fs, t2.name AS ft, c2.name AS fc \
             FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fk.object_id=fkc.constraint_object_id \
             JOIN sys.tables t1 ON fkc.parent_object_id=t1.object_id \
             JOIN sys.schemas sc1 ON t1.schema_id=sc1.schema_id \
             JOIN sys.columns c1 ON fkc.parent_object_id=c1.object_id AND fkc.parent_column_id=c1.column_id \
             JOIN sys.tables t2 ON fkc.referenced_object_id=t2.object_id \
             JOIN sys.schemas sc2 ON t2.schema_id=sc2.schema_id \
             JOIN sys.columns c2 ON fkc.referenced_object_id=c2.object_id AND fkc.referenced_column_id=c2.column_id \
             WHERE sc1.name='{s_esc}' AND t1.name='{t_esc}'"
        )).await.map(|r| r.into_iter().map(|row| serde_json::json!({
            "constraint_name": row.get("cn"), "column_name": row.get("col"),
            "foreign_schema": row.get("fs"), "foreign_table": row.get("ft"),
            "foreign_column": row.get("fc"),
        })).collect())
    }

    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_safe = s.replace(']', "]]");
        let t_safe = table.replace(']', "]]");
        let rows = self.query_strings(&format!("SELECT COUNT(*) AS cnt FROM [{s_safe}].[{t_safe}]")).await?;
        Ok(rows.first().and_then(|r| r.get("cnt")).and_then(|v| v.as_u64()).unwrap_or(0))
    }

    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_safe = s.replace(']', "]]");
        let t_safe = table.replace(']', "]]");
        let order = order_by.unwrap_or("1");
        if let Some(ob) = order_by { crate::db::trait_def::sanitize_order_by(ob)?; }
        let offset = (page.saturating_sub(1) as u64) * (page_size as u64);
        self.run_query(&format!("SELECT * FROM [{s_safe}].[{t_safe}] ORDER BY {order} OFFSET {offset} ROWS FETCH NEXT {page_size} ROWS ONLY")).await
    }

    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, serde_json::Value)], where_conditions: &[crate::db::types::WhereCondition]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_safe = s.replace(']', "]]");
        let t_safe = table.replace(']', "]]");
        let set: Vec<String> = updates.iter().map(|(col, val)|
            format!("[{}] = {}", col.replace(']', "]]"), crate::db::trait_def::json_value_to_sql(val))
        ).collect();
        let where_sql = crate::db::trait_def::build_where_sql(where_conditions, &|c| format!("[{}]", c.replace(']', "]]")))?;
        self.execute_sql(&format!("UPDATE [{s_safe}].[{t_safe}] SET {} WHERE {}", set.join(", "), where_sql)).await
    }

    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, serde_json::Value)]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_safe = s.replace(']', "]]");
        let t_safe = table.replace(']', "]]");
        let cols: Vec<_> = values.iter().map(|(c, _)| format!("[{}]", c.replace(']', "]]"))).collect();
        let vals: Vec<_> = values.iter().map(|(_, v)| crate::db::trait_def::json_value_to_sql(v)).collect();
        self.execute_sql(&format!("INSERT INTO [{s_safe}].[{t_safe}] ({}) VALUES ({})", cols.join(", "), vals.join(", "))).await
    }

    async fn delete_table_rows(&self, table: &str, schema: Option<&str>, where_conditions: &[crate::db::types::WhereCondition]) -> Result<ExecuteResult, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_safe = s.replace(']', "]]");
        let t_safe = table.replace(']', "]]");
        let where_sql = crate::db::trait_def::build_where_sql(where_conditions, &|c| format!("[{}]", c.replace(']', "]]")))?;
        self.execute_sql(&format!("DELETE FROM [{s_safe}].[{t_safe}] WHERE {}", where_sql)).await
    }

    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        let s = schema.unwrap_or("dbo");
        let s_esc = s.replace('\'', "''");
        let t_esc = table.replace('\'', "''");
        let result = self.run_query(&format!(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='{s_esc}' AND TABLE_NAME='{t_esc}' ORDER BY ORDINAL_POSITION"
        )).await?;
        let col_defs: Vec<String> = result.rows.iter().map(|row| {
            let name = row.get("COLUMN_NAME").and_then(|v| v.as_str()).unwrap_or("unknown");
            let dtype = row.get("DATA_TYPE").and_then(|v| v.as_str()).unwrap_or("nvarchar(255)");
            let null = row.get("IS_NULLABLE").and_then(|v| v.as_str()).unwrap_or("YES") == "YES";
            let def = row.get("COLUMN_DEFAULT").and_then(|v| v.as_str());
            format!("    [{}] {}{}{}", name, dtype, if null { " NULL" } else { " NOT NULL" },
                def.map(|d| format!(" DEFAULT {}", d)).unwrap_or_default())
        }).collect();
        Ok(format!("-- Table: [{s}].[{table}]\nCREATE TABLE [{s}].[{table}] (\n{}\n);\n", col_defs.join(",\n")))
    }
}
