use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};

use super::installer::PluginInstaller;
use super::manager::PluginManager;
use super::registry::PluginRegistry;

#[tauri::command]
pub async fn list_plugins(
    plugin_manager: State<'_, Arc<PluginManager>>,
) -> Result<serde_json::Value, String> {
    let plugins = plugin_manager.get_all_plugins().await;
    // Add enabled status to each plugin
    let mut plugins_with_status = Vec::new();
    for plugin in plugins {
        let mut plugin_value = serde_json::to_value(plugin).unwrap();
        if let Some(plugin_obj) = plugin_value.as_object_mut() {
            let plugin_id = plugin_obj.get("id").unwrap().as_str().unwrap();
            let enabled = plugin_manager.is_plugin_enabled(plugin_id).await;
            plugin_obj.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
        }
        plugins_with_status.push(plugin_value);
    }
    Ok(serde_json::Value::Array(plugins_with_status))
}

#[tauri::command]
pub async fn fetch_plugin_registry(
    plugin_manager: State<'_, Arc<PluginManager>>,
) -> Result<Vec<super::registry::PluginInfoWithStatus>, String> {
    let registry = PluginRegistry::fetch().await?;
    let installed_plugins = plugin_manager.get_all_plugins().await;
    let enabled_plugins = plugin_manager.get_enabled_plugins().await;
    let plugins_with_status = registry.to_plugins_with_status(&installed_plugins, &enabled_plugins);
    Ok(plugins_with_status)
}

#[tauri::command]
pub async fn install_plugin(
    app: AppHandle,
    plugin_manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
    version: String,
) -> Result<(), String> {
    let plugins_dir = plugin_manager.plugins_dir().await;
    let installer = PluginInstaller::new(plugins_dir);
    installer.install_plugin(&plugin_id, &version).await?;
    
    // Reload plugins
    plugin_manager.load_plugins().await?;
    
    Ok(())
}

#[tauri::command]
pub async fn remove_plugin(
    plugin_manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
) -> Result<(), String> {
    plugin_manager.remove_plugin(&plugin_id).await
}

#[tauri::command]
pub async fn reload_plugins(
    plugin_manager: State<'_, Arc<PluginManager>>,
) -> Result<serde_json::Value, String> {
    let plugins = plugin_manager.load_plugins().await?;
    // Add enabled status to each plugin
    let mut plugins_with_status = Vec::new();
    for plugin in plugins {
        let mut plugin_value = serde_json::to_value(plugin).unwrap();
        if let Some(plugin_obj) = plugin_value.as_object_mut() {
            let plugin_id = plugin_obj.get("id").unwrap().as_str().unwrap();
            let enabled = plugin_manager.is_plugin_enabled(plugin_id).await;
            plugin_obj.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
        }
        plugins_with_status.push(plugin_value);
    }
    Ok(serde_json::Value::Array(plugins_with_status))
}

#[tauri::command]
pub async fn enable_plugin(
    plugin_manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
) -> Result<(), String> {
    plugin_manager.enable_plugin(&plugin_id).await
}

#[tauri::command]
pub async fn disable_plugin(
    plugin_manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
) -> Result<(), String> {
    plugin_manager.disable_plugin(&plugin_id).await
}
