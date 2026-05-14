use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u32,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u32,
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

type PendingCall = oneshot::Sender<Result<Value, JsonRpcError>>;

pub struct RpcClient {
    writer: Arc<Mutex<BufWriter<std::process::ChildStdin>>>,
    reader: Arc<Mutex<BufReader<std::process::ChildStdout>>>,
    request_id: Arc<Mutex<u32>>,
    pending: Arc<Mutex<HashMap<u32, PendingCall>>>,
}

impl RpcClient {
    pub async fn new(executable_path: &str) -> Result<Self, String> {
        let mut child = Command::new(executable_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to start plugin process: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

        let reader = Arc::new(Mutex::new(BufReader::new(stdout)));
        let writer = Arc::new(Mutex::new(BufWriter::new(stdin)));
        let request_id = Arc::new(Mutex::new(1u32));
        let pending: Arc<Mutex<HashMap<u32, PendingCall>>> = Arc::new(Mutex::new(HashMap::new()));

        let client = Self {
            writer,
            reader,
            request_id,
            pending,
        };

        // Spawn a task to read responses from the plugin
        let reader_clone = client.reader.clone();
        let pending_clone = client.pending.clone();
        tokio::spawn(async move {
            let mut reader = reader_clone.lock().await;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<JsonRpcResponse>(line) {
                            Ok(response) => {
                                let response_id = response.id;
                                let mut pending = pending_clone.lock().await;
                                if let Some(sender) = pending.remove(&response_id) {
                                    if let Some(error) = response.error {
                                        let _ = sender.send(Err(error));
                                    } else {
                                        let _ = sender.send(Ok(response.result.unwrap_or(Value::Null)));
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("Failed to parse plugin response: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from plugin: {}", e);
                        break;
                    }
                }
            }
        });

        Ok(client)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut id = self.request_id.lock().await;
            let current_id = *id;
            *id += 1;
            current_id
        };

        let (tx, mut rx) = oneshot::channel();

        // Register pending call before writing request
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        let request_json = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        let mut writer = self.writer.lock().await;
        writer.write_all(format!("{}\n", request_json).as_bytes())
            .map_err(|e| format!("Failed to write to plugin: {}", e))?;
        writer.flush()
            .map_err(|e| format!("Failed to flush writer: {}", e))?;

        // Wait for response via oneshot channel
        match tokio::time::timeout(std::time::Duration::from_secs(30), &mut rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(error))) => {
                // Clean up pending entry on error
                Err(format!("Plugin error: {} (code: {})", error.message, error.code))
            }
            Ok(Err(_)) => Err("Plugin closed the connection".to_string()),
            Err(_) => {
                // Clean up pending entry on timeout
                let mut pending = self.pending.lock().await;
                pending.remove(&id);
                Err("Request timed out".to_string())
            }
        }
    }

    pub async fn plugin_info(&self) -> Result<Value, String> {
        self.call("plugin_info", json!({})).await
    }

    pub async fn connect(&self, config: Value) -> Result<Value, String> {
        self.call("connect", config).await
    }

    pub async fn execute_query(&self, connection_id: &str, query: &str) -> Result<Value, String> {
        self.call("execute_query", json!({"connection_id": connection_id, "query": query})).await
    }

    pub async fn list_tables(&self, connection_id: &str) -> Result<Value, String> {
        self.call("list_tables", json!({"connection_id": connection_id})).await
    }

    pub async fn list_schemas(&self, connection_id: &str) -> Result<Value, String> {
        self.call("list_schemas", json!({"connection_id": connection_id})).await
    }

    pub async fn get_columns(&self, connection_id: &str, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_columns", json!({"connection_id": connection_id, "table": table, "schema": schema})).await
    }

    pub async fn get_views(&self, connection_id: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_views", json!({"connection_id": connection_id, "schema": schema})).await
    }

    pub async fn get_indexes(&self, connection_id: &str, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_indexes", json!({"connection_id": connection_id, "table": table, "schema": schema})).await
    }

    pub async fn get_foreign_keys(&self, connection_id: &str, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_foreign_keys", json!({"connection_id": connection_id, "table": table, "schema": schema})).await
    }

    pub async fn get_table_row_count(&self, connection_id: &str, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_table_row_count", json!({"connection_id": connection_id, "table": table, "schema": schema})).await
    }

    pub async fn get_table_data(&self, connection_id: &str, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<Value, String> {
        self.call("get_table_data", json!({
            "connection_id": connection_id,
            "table": table,
            "schema": schema,
            "page": page,
            "page_size": page_size,
            "order_by": order_by
        })).await
    }

    pub async fn export_table_sql(&self, connection_id: &str, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("export_table_sql", json!({"connection_id": connection_id, "table": table, "schema": schema})).await
    }

    pub async fn update_table_rows(&self, connection_id: &str, table: &str, schema: Option<&str>, updates: &[(String, Value)], where_clause: &str) -> Result<Value, String> {
        self.call("update_table_rows", json!({
            "connection_id": connection_id,
            "table": table,
            "schema": schema,
            "updates": updates,
            "where_clause": where_clause
        })).await
    }

    pub async fn insert_table_row(&self, connection_id: &str, table: &str, schema: Option<&str>, values: &[(String, Value)]) -> Result<Value, String> {
        self.call("insert_table_row", json!({
            "connection_id": connection_id,
            "table": table,
            "schema": schema,
            "values": values
        })).await
    }

    pub async fn delete_table_rows(&self, connection_id: &str, table: &str, schema: Option<&str>, where_clause: &str) -> Result<Value, String> {
        self.call("delete_table_rows", json!({
            "connection_id": connection_id,
            "table": table,
            "schema": schema,
            "where_clause": where_clause
        })).await
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<Value, String> {
        self.call("disconnect", json!({"connection_id": connection_id})).await
    }

    pub async fn get_server_version(&self, connection_id: &str) -> Result<Value, String> {
        self.call("get_server_version", json!({"connection_id": connection_id})).await
    }

    // ========================================================================
    // Tabularis-compatible RPC methods (stateless: params passed with each call)
    // These use the exact method names and param format that Tabularis plugins expect.
    // ========================================================================

    pub async fn tabularis_initialize(&self, settings: Value) -> Result<Value, String> {
        self.call("initialize", json!({ "settings": settings })).await
    }

    pub async fn tabularis_ping(&self, params: &Value) -> Result<Value, String> {
        self.call("ping", json!({ "params": params })).await
    }

    pub async fn tabularis_test_connection(&self, params: &Value) -> Result<Value, String> {
        self.call("test_connection", json!({ "params": params })).await
    }

    pub async fn tabularis_get_databases(&self, params: &Value) -> Result<Value, String> {
        self.call("get_databases", json!({ "params": params })).await
    }

    pub async fn tabularis_get_schemas(&self, params: &Value) -> Result<Value, String> {
        self.call("get_schemas", json!({ "params": params })).await
    }

    pub async fn tabularis_get_tables(&self, params: &Value, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_tables", json!({ "params": params, "schema": schema })).await
    }

    pub async fn tabularis_get_columns(&self, params: &Value, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_columns", json!({ "params": params, "table": table, "schema": schema })).await
    }

    pub async fn tabularis_get_views(&self, params: &Value, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_views", json!({ "params": params, "schema": schema })).await
    }

    pub async fn tabularis_get_indexes(&self, params: &Value, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_indexes", json!({ "params": params, "table": table, "schema": schema })).await
    }

    pub async fn tabularis_get_foreign_keys(&self, params: &Value, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_foreign_keys", json!({ "params": params, "table": table, "schema": schema })).await
    }

    pub async fn tabularis_execute_query(&self, params: &Value, query: &str, limit: Option<u64>, page: Option<u64>, schema: Option<&str>) -> Result<Value, String> {
        self.call("execute_query", json!({
            "params": params,
            "query": query,
            "limit": limit,
            "page": page,
            "schema": schema
        })).await
    }

    pub async fn tabularis_insert_record(&self, params: &Value, table: &str, data: &Value, schema: Option<&str>) -> Result<Value, String> {
        self.call("insert_record", json!({
            "params": params, "table": table, "data": data, "schema": schema,
            "max_blob_size": 65536
        })).await
    }

    pub async fn tabularis_update_record(&self, params: &Value, table: &str, pk_col: &str, pk_val: &Value, col_name: &str, new_val: &Value, schema: Option<&str>) -> Result<Value, String> {
        self.call("update_record", json!({
            "params": params, "table": table,
            "pk_col": pk_col, "pk_val": pk_val,
            "col_name": col_name, "new_val": new_val,
            "schema": schema, "max_blob_size": 65536
        })).await
    }

    pub async fn tabularis_delete_record(&self, params: &Value, table: &str, pk_col: &str, pk_val: &Value, schema: Option<&str>) -> Result<Value, String> {
        self.call("delete_record", json!({
            "params": params, "table": table,
            "pk_col": pk_col, "pk_val": pk_val,
            "schema": schema
        })).await
    }

    pub async fn tabularis_get_create_table_sql(&self, params: &Value, table: &str, schema: Option<&str>) -> Result<Value, String> {
        self.call("get_create_table_sql", json!({ "params": params, "table": table, "schema": schema })).await
    }

    pub async fn tabularis_get_server_version(&self, params: &Value) -> Result<Value, String> {
        self.call("get_server_version", json!({ "params": params })).await
    }
}
