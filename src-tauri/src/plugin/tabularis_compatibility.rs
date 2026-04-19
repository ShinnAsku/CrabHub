use serde::{Deserialize, Serialize};
use serde_json::{Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularisPluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub default_port: Option<u16>,
    pub executable: String,
    pub capabilities: TabularisPluginCapabilities,
    pub data_types: Vec<TabularisPluginDataType>,
    pub settings: Option<Vec<TabularisPluginSetting>>,
    pub ui_extensions: Option<Vec<TabularisPluginUIExtension>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularisPluginCapabilities {
    pub schemas: bool,
    pub views: bool,
    pub routines: bool,
    pub file_based: bool,
    pub identifier_quote: String,
    pub alter_primary_key: bool,
    pub alter_column: Option<bool>,
    pub create_foreign_keys: Option<bool>,
    pub folder_based: Option<bool>,
    pub no_connection_required: Option<bool>,
    pub connection_string: Option<bool>,
    pub connection_string_example: Option<String>,
    pub manage_tables: Option<bool>,
    pub readonly: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularisPluginDataType {
    pub name: String,
    pub category: String,
    pub requires_length: bool,
    pub requires_precision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularisPluginSetting {
    pub key: String,
    pub label: String,
    pub type_: String,
    pub required: Option<bool>,
    pub description: Option<String>,
    pub options: Option<Vec<String>>,
    pub default: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularisPluginUIExtension {
    pub slot: String,
    pub module: String,
    pub order: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TabularisPlugin {
    pub manifest: TabularisPluginManifest,
    pub path: String,
    pub enabled: bool,
    // We'll manage the process lifecycle separately
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionParams {
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u32,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u32,
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

pub struct TabularisPluginManager {
    plugins: Arc<Mutex<HashMap<String, TabularisPlugin>>>,
}

impl TabularisPluginManager {
    pub fn new() -> Self {
        Self {
            plugins: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn load_plugin(&self, plugin_path: &str) -> Result<TabularisPlugin, String> {
        // Load manifest.json
        let manifest_path = format!("{}/manifest.json", plugin_path);
        let manifest_content = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
        
        let manifest: TabularisPluginManifest = serde_json::from_str(&manifest_content)
            .map_err(|e| format!("Failed to parse manifest.json: {}", e))?;
        
        // Verify executable exists
        let executable_path = format!("{}/{}", plugin_path, manifest.executable);
        if !std::path::Path::new(&executable_path).exists() {
            return Err(format!("Executable not found: {}", executable_path));
        }
        
        let plugin = TabularisPlugin {
            manifest,
            path: plugin_path.to_string(),
            enabled: true,
        };
        
        let mut plugins = self.plugins.lock().await;
        plugins.insert(plugin.manifest.id.clone(), plugin.clone());
        
        Ok(plugin)
    }

    pub async fn list_plugins(&self) -> Vec<TabularisPlugin> {
        let plugins = self.plugins.lock().await;
        plugins.values().cloned().collect()
    }

    pub async fn enable_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self.plugins.lock().await;
        if let Some(plugin) = plugins.get_mut(plugin_id) {
            plugin.enabled = true;
            Ok(())
        } else {
            Err(format!("Plugin '{}' not found", plugin_id))
        }
    }

    pub async fn disable_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self.plugins.lock().await;
        if let Some(plugin) = plugins.get_mut(plugin_id) {
            plugin.enabled = false;
            Ok(())
        } else {
            Err(format!("Plugin '{}' not found", plugin_id))
        }
    }

    pub async fn remove_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self.plugins.lock().await;
        if plugins.remove(plugin_id).is_some() {
            Ok(())
        } else {
            Err(format!("Plugin '{}' not found", plugin_id))
        }
    }

    pub async fn get_plugin(&self, plugin_id: &str) -> Option<TabularisPlugin> {
        let plugins = self.plugins.lock().await;
        plugins.get(plugin_id).cloned()
    }

    pub async fn get_or_start_plugin_process(
        &self,
        plugin_id: &str
    ) -> Result<(BufReader<std::process::ChildStdout>, BufWriter<std::process::ChildStdin>), String> {
        // Start a new process for each request since we can't share stdin/stdout safely
        let plugin = self.get_plugin(plugin_id).await
            .ok_or(format!("Plugin '{}' not found", plugin_id))?;
        
        let executable_path = format!("{}/{}", plugin.path, plugin.manifest.executable);
        let mut child = Command::new(&executable_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to start plugin process: {}", e))?;
        
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        
        let reader = BufReader::new(stdout);
        let writer = BufWriter::new(stdin);
        
        Ok((reader, writer))
    }

    pub async fn execute_method(
        &self,
        plugin_id: &str,
        method: &str,
        params: Value
    ) -> Result<Value, String> {
        // Start the plugin process if it's not running
        let (mut reader, mut writer) = self.get_or_start_plugin_process(plugin_id).await?;
        
        // Create JSON-RPC request
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: method.to_string(),
            params,
        };
        
        // Send request
        let request_json = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;
        
        writer.write_all(format!("{}\n", request_json).as_bytes())
            .map_err(|e| format!("Failed to write to plugin: {}", e))?;
        writer.flush()
            .map_err(|e| format!("Failed to flush writer: {}", e))?;
        
        // Read response
        let mut line = String::new();
        reader.read_line(&mut line)
            .map_err(|e| format!("Failed to read from plugin: {}", e))?;
        
        let response: JsonRpcResponse = serde_json::from_str(&line)
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        
        if let Some(error) = response.error {
            return Err(format!("Plugin error: {} (code: {})", error.message, error.code));
        }
        
        if let Some(result) = response.result {
            Ok(result)
        } else {
            Err("No result in response".to_string())
        }
    }
}
