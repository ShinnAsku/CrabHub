use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

use super::rpc::RpcClient;
use crate::db::types::{ColumnInfo, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo};
use crate::db::trait_def::DatabaseConnection;

fn parse_columns(result: &Value) -> Result<Vec<ColumnInfo>, DbError> {
    result.get("columns").and_then(|v| v.as_array())
        .ok_or_else(|| DbError::QueryError("No columns returned".to_string()))?
        .iter()
        .map(|col| Ok(ColumnInfo {
            name: col.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            data_type: col.get("data_type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            nullable: col.get("nullable").and_then(|v| v.as_bool()).unwrap_or(false),
            is_primary_key: col.get("is_primary_key").and_then(|v| v.as_bool()).unwrap_or(false),
            default_value: col.get("default_value").and_then(|v| v.as_str()).map(|s| s.to_string()),
            comment: col.get("comment").and_then(|v| v.as_str()).map(|s| s.to_string()),
            character_maximum_length: col.get("character_maximum_length").and_then(|v| v.as_i64()),
            numeric_precision: col.get("numeric_precision").and_then(|v| v.as_i64()),
            numeric_scale: col.get("numeric_scale").and_then(|v| v.as_i64()),
        }))
        .collect()
}

fn parse_rows(result: &Value) -> Vec<serde_json::Map<String, Value>> {
    result.get("rows").and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(|row| {
            let mut map = serde_json::Map::new();
            if let Some(obj) = row.as_object() {
                for (key, value) in obj { map.insert(key.clone(), value.clone()); }
            }
            map
        }).collect())
        .unwrap_or_default()
}

fn parse_tables(result: &Value) -> Result<Vec<TableInfo>, DbError> {
    let arr = result.get("tables")
        .or_else(|| result.get("views"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| DbError::QueryError("No tables/views returned".to_string()))?;
    arr.iter()
        .map(|table| Ok(TableInfo {
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
        }))
        .collect()
}

/// PluginDriver bridges the DatabaseConnection trait to an external plugin process.
/// Uses Tabularis-compatible JSON-RPC protocol (stateless: params passed with each call).
/// Falls back to CrabHub-native protocol when Tabularis calls fail.
pub struct PluginDriver {
    client: Arc<RpcClient>,
    plugin_id: String,
    /// Serialized ConnectionConfig to pass as params to the plugin
    params: Value,
    /// Whether the plugin uses Tabularis protocol (detected via initialize)
    is_tabularis: bool,
}

impl PluginDriver {
    pub async fn new(
        client: Arc<RpcClient>,
        plugin_id: String,
        params: Value,
    ) -> Self {
        // Try Tabularis protocol first (initialize)
        let is_tabularis = client.tabularis_initialize(json!({}))
            .await
            .is_ok();

        Self { client, plugin_id, params, is_tabularis }
    }

    /// Try Tabularis protocol first, fall back to CrabHub native
    async fn call_both<F, G, R>(
        &self,
        tabularis_fn: F,
        native_fn: G,
        label: &str,
    ) -> Result<R, DbError>
    where
        F: std::future::Future<Output = Result<Value, String>>,
        G: std::future::Future<Output = Result<Value, String>>,
        R: serde::de::DeserializeOwned,
    {
        if self.is_tabularis {
            match tabularis_fn.await {
                Ok(v) => return serde_json::from_value(v)
                    .map_err(|e| DbError::QueryError(format!("{} parse error: {}", label, e))),
                Err(_) => { /* fall through to native */ }
            }
        }
        // Fallback: CrabHub native protocol
        match native_fn.await {
            Ok(v) => serde_json::from_value(v)
                .map_err(|e| DbError::QueryError(format!("{} parse error: {}", label, e))),
            Err(e) => Err(DbError::QueryError(format!("{} failed: {}", label, e))),
        }
    }
}

#[async_trait]
impl DatabaseConnection for PluginDriver {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_execute_query(&self.params, sql, None, None, None).await
        } else {
            self.client.execute_query("default", sql).await
        }.map_err(|e| DbError::QueryError(e))?;

        Ok(ExecuteResult {
            rows_affected: result.get("rows_affected").and_then(|v| v.as_u64())
                .or_else(|| result.get("affected_rows").and_then(|v| v.as_u64()))
                .unwrap_or(0),
            execution_time_ms: result.get("execution_time_ms").and_then(|v| v.as_u64()).unwrap_or(0),
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_execute_query(&self.params, sql, None, None, None).await
        } else {
            self.client.execute_query("default", sql).await
        }.map_err(|e| DbError::QueryError(e))?;

        let rows = parse_rows(&result);
        Ok(QueryResult {
            columns: parse_columns(&result)?,
            row_count: result.get("row_count").and_then(|v| v.as_u64()).unwrap_or(rows.len() as u64),
            rows,
            execution_time_ms: result.get("execution_time_ms").and_then(|v| v.as_u64()).unwrap_or(0),
        })
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::Plugin(self.plugin_id.clone())
    }

    async fn close(&self) {
        let _ = self.client.disconnect("default").await;
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_tables(&self.params, None).await
        } else {
            self.client.list_tables("default").await
        }.map_err(|e| DbError::QueryError(e))?;
        parse_tables(&result)
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_columns(&self.params, table, schema).await
        } else {
            self.client.get_columns("default", table, schema).await
        }.map_err(|e| DbError::QueryError(e))?;
        parse_columns(&result)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_schemas(&self.params).await
        } else {
            self.client.list_schemas("default").await
        }.map_err(|e| DbError::QueryError(e))?;

        Ok(result.get("schemas").and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default())
    }

    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_create_table_sql(&self.params, table, schema).await
        } else {
            self.client.export_table_sql("default", table, schema).await
        }.map_err(|e| DbError::QueryError(e))?;

        Ok(result.get("sql").and_then(|v| v.as_str()).unwrap_or("-- No DDL returned").to_string())
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_views(&self.params, schema).await
        } else {
            self.client.get_views("default", schema).await
        }.map_err(|e| DbError::QueryError(e))?;
        parse_tables(&result)
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_indexes(&self.params, table, schema).await
        } else {
            self.client.get_indexes("default", table, schema).await
        }.map_err(|e| DbError::QueryError(e))?;
        Ok(result.get("indexes").and_then(|v| v.as_array()).cloned().unwrap_or_default())
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> {
        let result = if self.is_tabularis {
            self.client.tabularis_get_foreign_keys(&self.params, table, schema).await
        } else {
            self.client.get_foreign_keys("default", table, schema).await
        }.map_err(|e| DbError::QueryError(e))?;
        Ok(result.get("foreign_keys").and_then(|v| v.as_array()).cloned().unwrap_or_default())
    }

    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        // Tabularis doesn't have a dedicated row count RPC; use execute_query
        let sql = format!("SELECT COUNT(*) AS count FROM \"{}\"", table);
        let result = if self.is_tabularis {
            self.client.tabularis_execute_query(&self.params, &sql, None, None, schema).await
        } else {
            self.client.get_table_row_count("default", table, schema).await
        };
        match result {
            Ok(v) => {
                if self.is_tabularis {
                    let rows = v.get("rows").and_then(|r| r.as_array());
                    Ok(rows.and_then(|r| r.first())
                        .and_then(|row| row.get("count").or_else(|| row.get("COUNT")))
                        .and_then(|c| c.as_u64()).unwrap_or(0))
                } else {
                    Ok(v.get("count").and_then(|c| c.as_u64()).unwrap_or(0))
                }
            }
            Err(_) => Ok(0),
        }
    }

    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        let sql = if let Some(order) = order_by {
            format!("SELECT * FROM \"{}\" ORDER BY {} LIMIT {} OFFSET {}", table, order, page_size, (page - 1) * page_size)
        } else {
            format!("SELECT * FROM \"{}\" LIMIT {} OFFSET {}", table, page_size, (page - 1) * page_size)
        };
        let result = if self.is_tabularis {
            self.client.tabularis_execute_query(&self.params, &sql, Some(page_size as u64), Some(page as u64), schema).await
        } else {
            self.client.get_table_data("default", table, schema, page, page_size, order_by).await
        }.map_err(|e| DbError::QueryError(e))?;

        let rows = parse_rows(&result);
        Ok(QueryResult {
            columns: parse_columns(&result)?,
            row_count: result.get("row_count").and_then(|v| v.as_u64()).unwrap_or(rows.len() as u64),
            rows,
            execution_time_ms: result.get("execution_time_ms").and_then(|v| v.as_u64()).unwrap_or(0),
        })
    }

    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, Value)], where_clause: &str) -> Result<ExecuteResult, DbError> {
        // For Tabularis, we use raw SQL since update_record requires pk
        let set_clause = updates.iter()
            .map(|(col, val)| format!("{} = {}", col, crate::db::trait_def::json_value_to_sql(val)))
            .collect::<Vec<_>>().join(", ");
        let sql = format!("UPDATE \"{}\" SET {} WHERE {}", table, set_clause, where_clause);
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, Value)]) -> Result<ExecuteResult, DbError> {
        if self.is_tabularis {
            let data: Value = serde_json::to_value(
                values.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<serde_json::Map<String, Value>>()
            ).unwrap_or(json!({}));
            let result = self.client.tabularis_insert_record(&self.params, table, &data, schema).await
                .map_err(|e| DbError::QueryError(e))?;
            return Ok(ExecuteResult {
                rows_affected: result.get("rows_affected").and_then(|v| v.as_u64()).unwrap_or(1),
                execution_time_ms: 0,
            });
        }
        let cols = values.iter().map(|(k, _)| format!("\"{}\"", k)).collect::<Vec<_>>().join(", ");
        let vals = values.iter().map(|(_, v)| crate::db::trait_def::json_value_to_sql(v)).collect::<Vec<_>>().join(", ");
        let sql = format!("INSERT INTO \"{}\" ({}) VALUES ({})", table, cols, vals);
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(&self, table: &str, _schema: Option<&str>, where_clause: &str) -> Result<ExecuteResult, DbError> {
        let sql = format!("DELETE FROM \"{}\" WHERE {}", table, where_clause);
        self.execute_sql(&sql).await
    }
}
