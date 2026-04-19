use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use super::driver::PluginDriver;
use super::rpc::RpcClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub default_port: Option<u16>,
    pub executable: String,
    pub capabilities: PluginCapabilities,
    pub data_types: Vec<PluginDataType>,
    pub settings: Option<Vec<PluginSetting>>,
    pub ui_extensions: Option<Vec<PluginUIExtension>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCapabilities {
    pub schemas: bool,
    pub views: bool,
    pub routines: bool,
    pub file_based: bool,
    pub folder_based: Option<bool>,
    pub no_connection_required: Option<bool>,
    pub connection_string: Option<bool>,
    pub connection_string_example: Option<String>,
    pub identifier_quote: String,
    pub alter_primary_key: bool,
    pub manage_tables: Option<bool>,
    pub readonly: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDataType {
    pub name: String,
    pub category: String,
    pub requires_length: bool,
    pub requires_precision: bool,
    pub default_length: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSetting {
    pub key: String,
    pub label: String,
    pub type_: String,
    pub required: Option<bool>,
    pub description: Option<String>,
    pub options: Option<Vec<String>>,
    pub default: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUIExtension {
    pub slot: String,
    pub module: String,
    pub order: Option<u32>,
    pub driver: Option<String>,
}

pub struct PluginManager {
    plugins: Arc<RwLock<HashMap<String, PluginInfo>>>,
    plugin_clients: Arc<RwLock<HashMap<String, Arc<RpcClient>>>>,
    plugins_dir: PathBuf,
    enabled_plugins: Arc<RwLock<HashSet<String>>>,
}

impl PluginManager {
    pub fn new(plugins_dir: PathBuf) -> Self {
        Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
            plugin_clients: Arc::new(RwLock::new(HashMap::new())),
            plugins_dir,
            enabled_plugins: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub async fn load_plugins(&self) -> Result<Vec<PluginInfo>, String> {
        let mut plugins = self.plugins.write().await;
        let mut enabled = self.enabled_plugins.write().await;
        plugins.clear();

        // Create plugins directory if it doesn't exist
        if !self.plugins_dir.exists() {
            fs::create_dir_all(&self.plugins_dir)
                .map_err(|e| format!("Failed to create plugins directory: {}", e))?;
        }

        // Read all plugin directories
        let entries = fs::read_dir(&self.plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        let mut loaded_plugins = Vec::new();

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                if let Ok(plugin) = self.load_plugin(&path).await {
                    plugins.insert(plugin.id.clone(), plugin.clone());
                    // Enable plugin by default if not explicitly disabled
                    if !enabled.contains(&plugin.id) {
                        enabled.insert(plugin.id.clone());
                    }
                    loaded_plugins.push(plugin);
                }
            }
        }

        Ok(loaded_plugins)
    }

    pub async fn load_plugin(&self, plugin_path: &Path) -> Result<PluginInfo, String> {
        // Load manifest.json
        let manifest_path = plugin_path.join("manifest.json");
        let manifest_content = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;

        let plugin: PluginInfo = serde_json::from_str(&manifest_content)
            .map_err(|e| format!("Failed to parse manifest.json: {}", e))?;

        // Verify executable exists
        let executable_path = plugin_path.join(&plugin.executable);
        if !executable_path.exists() {
            return Err(format!("Executable not found: {}", executable_path.display()));
        }

        Ok(plugin)
    }

    pub async fn get_plugin(&self, plugin_id: &str) -> Option<PluginInfo> {
        let plugins = self.plugins.read().await;
        plugins.get(plugin_id).cloned()
    }

    pub async fn get_all_plugins(&self) -> Vec<PluginInfo> {
        let plugins = self.plugins.read().await;
        plugins.values().cloned().collect()
    }

    pub async fn get_plugin_client(&self, plugin_id: &str) -> Result<Arc<RpcClient>, String> {
        let mut clients = self.plugin_clients.write().await;

        if let Some(client) = clients.get(plugin_id) {
            return Ok(client.clone());
        }

        let plugin = self.get_plugin(plugin_id).await
            .ok_or_else(|| format!("Plugin '{}' not found", plugin_id))?;

        let executable_path = self.plugins_dir.join(plugin_id).join(&plugin.executable);
        let client = Arc::new(RpcClient::new(executable_path.to_str().unwrap()).await?);

        clients.insert(plugin_id.to_string(), client.clone());
        Ok(client)
    }

    pub async fn remove_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut plugins = self.plugins.write().await;
        let mut clients = self.plugin_clients.write().await;
        let mut enabled = self.enabled_plugins.write().await;

        if plugins.remove(plugin_id).is_some() {
            clients.remove(plugin_id);
            enabled.remove(plugin_id);

            // Remove plugin directory
            let plugin_path = self.plugins_dir.join(plugin_id);
            if plugin_path.exists() {
                fs::remove_dir_all(&plugin_path)
                    .map_err(|e| format!("Failed to remove plugin directory: {}", e))?;
            }

            Ok(())
        } else {
            Err(format!("Plugin '{}' not found", plugin_id))
        }
    }

    pub async fn enable_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut enabled = self.enabled_plugins.write().await;
        enabled.insert(plugin_id.to_string());
        Ok(())
    }

    pub async fn disable_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut enabled = self.enabled_plugins.write().await;
        enabled.remove(plugin_id);
        Ok(())
    }

    pub async fn is_plugin_enabled(&self, plugin_id: &str) -> bool {
        let enabled = self.enabled_plugins.read().await;
        enabled.contains(plugin_id)
    }

    pub async fn get_enabled_plugins(&self) -> Vec<String> {
        let enabled = self.enabled_plugins.read().await;
        enabled.iter().cloned().collect()
    }

    pub async fn get_enabled_plugins_info(&self) -> Vec<PluginInfo> {
        let plugins = self.plugins.read().await;
        let enabled = self.enabled_plugins.read().await;
        
        plugins.values()
            .filter(|plugin| enabled.contains(&plugin.id))
            .cloned()
            .collect()
    }

    pub async fn plugins_dir(&self) -> PathBuf {
        self.plugins_dir.clone()
    }
}
