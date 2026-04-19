use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

use super::rpc::RpcClient;
use crate::db::types::{ColumnInfo, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo};
use crate::db::trait_def::DatabaseConnection;

pub struct PluginDriver {
    client: Arc<RpcClient>,
    plugin_id: String,
    connection_id: String,
}

impl PluginDriver {
    pub fn new(client: Arc<RpcClient>, plugin_id: String, connection_id: String) -> Self {
        Self {
            client,
            plugin_id,
            connection_id,
        }
    }
}

#[async_trait]
impl DatabaseConnection for PluginDriver {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let result = self.client
            .execute_query(&self.connection_id, sql)
            .await
            .map_err(|e| DbError::QueryError(e))?;

        let rows_affected = result.get("rows_affected").and_then(|v| v.as_u64()).unwrap_or(0);
        let execution_time_ms = result.get("execution_time_ms").and_then(|v| v.as_u64()).unwrap_or(0);

        Ok(ExecuteResult {
            rows_affected,
            execution_time_ms,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let result = self.client
            .execute_query(&self.connection_id, sql)
            .await
            .map_err(|e| DbError::QueryError(e))?;

        let columns = result.get("columns").and_then(|v| v.as_array())
            .ok_or_else(|| DbError::QueryError("No columns returned".to_string()))?
            .iter()
            .map(|col| {
                ColumnInfo {
                    name: col.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    data_type: col.get("data_type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    nullable: col.get("nullable").and_then(|v| v.as_bool()).unwrap_or(false),
                    is_primary_key: col.get("is_primary_key").and_then(|v| v.as_bool()).unwrap_or(false),
                    default_value: col.get("default_value").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    comment: col.get("comment").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    character_maximum_length: col.get("character_maximum_length").and_then(|v| v.as_i64()),
                    numeric_precision: col.get("numeric_precision").and_then(|v| v.as_i64()),
                    numeric_scale: col.get("numeric_scale").and_then(|v| v.as_i64()),
                }
            })
            .collect();

        let rows: Vec<serde_json::Map<String, Value>> = result.get("rows").and_then(|v| v.as_array())
            .ok_or_else(|| DbError::QueryError("No rows returned".to_string()))?
            .iter()
            .map(|row| {
                let mut map = serde_json::Map::new();
                if let Some(obj) = row.as_object() {
                    for (key, value) in obj {
                        map.insert(key.clone(), value.clone());
                    }
                }
                map
            })
            .collect();

        let row_count = rows.len() as u64;
        let execution_time_ms = result.get("execution_time_ms").and_then(|v| v.as_u64()).unwrap_or(0);

        Ok(QueryResult {
            columns,
            rows,
            row_count,
            execution_time_ms,
        })
    }

    fn db_type(&self) -> DatabaseType {
        // For plugin drivers, we return a generic type
        DatabaseType::PostgreSQL
    }

    async fn close(&self) {
        // Plugin connections are managed by the plugin itself
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let result = self.client
            .list_tables(&self.connection_id)
            .await
            .map_err(|e| DbError::QueryError(e))?;

        let tables = result.get("tables").and_then(|v| v.as_array())
            .ok_or_else(|| DbError::QueryError("No tables returned".to_string()))?
            .iter()
            .map(|table| {
                TableInfo {
                    name: table.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    schema: table.get("schema").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    row_count: table.get("row_count").and_then(|v| v.as_u64()),
                    comment: table.get("comment").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    table_type: table.get("table_type").and_then(|v| v.as_str()).unwrap_or("TABLE").to_string(),
                    oid: table.get("oid").and_then(|v| v.as_i64()),
                    owner: table.get("owner").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    acl: table.get("acl").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    primary_key: table.get("primary_key").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    partition_of: table.get("partition_of").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    has_indexes: table.get("has_indexes").and_then(|v| v.as_bool()),
                    has_triggers: table.get("has_triggers").and_then(|v| v.as_bool()),
                    engine: table.get("engine").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    data_length: table.get("data_length").and_then(|v| v.as_i64()),
                    create_time: table.get("create_time").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    update_time: table.get("update_time").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    collation: table.get("collation").and_then(|v| v.as_str()).map(|s| s.to_string()),
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        // This would be implemented by calling a plugin method to get columns
        Ok(Vec::new())
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let result = self.client
            .list_schemas(&self.connection_id)
            .await
            .map_err(|e| DbError::QueryError(e))?;

        let schemas = result.get("schemas").and_then(|v| v.as_array())
            .ok_or_else(|| DbError::QueryError("No schemas returned".to_string()))?
            .iter()
            .filter_map(|s| s.as_str().map(|s| s.to_string()))
            .collect();

        Ok(schemas)
    }

    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        // This would be implemented by calling a plugin method to export table SQL
        Ok(format!("-- Export SQL for table {}", table))
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        // This would be implemented by calling a plugin method to get views
        Ok(Vec::new())
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> {
        // This would be implemented by calling a plugin method to get indexes
        Ok(Vec::new())
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> {
        // This would be implemented by calling a plugin method to get foreign keys
        Ok(Vec::new())
    }

    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        // This would be implemented by calling a plugin method to get row count
        Ok(0)
    }

    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        // This would be implemented by calling a plugin method to get table data
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            execution_time_ms: 0,
        })
    }

    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, Value)], where_clause: &str) -> Result<ExecuteResult, DbError> {
        // This would be implemented by calling a plugin method to update rows
        Ok(ExecuteResult {
            rows_affected: 0,
            execution_time_ms: 0,
        })
    }

    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, Value)]) -> Result<ExecuteResult, DbError> {
        // This would be implemented by calling a plugin method to insert row
        Ok(ExecuteResult {
            rows_affected: 0,
            execution_time_ms: 0,
        })
    }

    async fn delete_table_rows(&self, table: &str, schema: Option<&str>, where_clause: &str) -> Result<ExecuteResult, DbError> {
        // This would be implemented by calling a plugin method to delete rows
        Ok(ExecuteResult {
            rows_affected: 0,
            execution_time_ms: 0,
        })
    }
}
