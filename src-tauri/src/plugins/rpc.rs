use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
use tokio::time::{sleep, Duration};

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

pub struct RpcClient {
    writer: Arc<Mutex<BufWriter<std::process::ChildStdin>>>,
    reader: Arc<Mutex<BufReader<std::process::ChildStdout>>>,
    request_id: Arc<Mutex<u32>>,
    response_tx: Arc<mpsc::Sender<Result<Value, JsonRpcError>>>,
    response_rx: Arc<Mutex<mpsc::Receiver<Result<Value, JsonRpcError>>>>,
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

        let (response_tx, response_rx) = mpsc::channel(100);
        let response_tx = Arc::new(response_tx);
        let response_rx = Arc::new(Mutex::new(response_rx));

        let client = Self {
            writer,
            reader,
            request_id,
            response_tx,
            response_rx,
        };

        // Spawn a task to read responses from the plugin
        let reader_clone = client.reader.clone();
        let response_tx_clone = client.response_tx.clone();
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
                                if let Some(error) = response.error {
                                    let _ = response_tx_clone.send(Err(error)).await;
                                } else if let Some(result) = response.result {
                                    let _ = response_tx_clone.send(Ok(result)).await;
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

        // Wait for response
        let mut response_rx = self.response_rx.lock().await;
        match tokio::time::timeout(Duration::from_secs(30), response_rx.recv()).await {
            Ok(Some(Ok(result))) => Ok(result),
            Ok(Some(Err(error))) => Err(format!("Plugin error: {} (code: {})", error.message, error.code)),
            Ok(None) => Err("Plugin closed the connection".to_string()),
            Err(_) => Err("Request timed out".to_string()),
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
}
