use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use reqwest;
use dirs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRegistry {
    pub schema_version: u32,
    pub plugins: Vec<PluginInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub homepage: String,
    pub latest_version: String,
    pub releases: Vec<PluginRelease>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRelease {
    pub version: String,
    pub min_tabularis_version: String,
    pub assets: HashMap<String, String>,
}

// Enhanced plugin info with status for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfoWithStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub homepage: String,
    pub latest_version: String,
    pub releases: Vec<PluginReleaseWithStatus>,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub platform_supported: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginReleaseWithStatus {
    pub version: String,
    pub min_tabularis_version: String,
    pub platform_supported: bool,
}

impl PluginRegistry {
    pub async fn fetch() -> Result<Self, String> {
        // Use cached registry if available and not too old
        if let Ok(cached) = Self::load_cached() {
            return Ok(cached);
        }

        let url = "https://raw.githubusercontent.com/debba/tabularis/main/plugins/registry.json";
        let response = reqwest::get(url)
            .await
            .map_err(|e| format!("Failed to fetch registry: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Failed to fetch registry: {}", response.status()));
        }

        let registry: Self = response.json()
            .await
            .map_err(|e| format!("Failed to parse registry: {}", e))?;

        // Cache the registry for faster future loads
        let _ = registry.save_cached();

        Ok(registry)
    }

    fn load_cached() -> Result<Self, String> {
        let cache_path = dirs::cache_dir()
            .ok_or_else(|| "Failed to get cache directory".to_string())?
            .join("opendb")
            .join("plugin_registry.json");

        if !cache_path.exists() {
            return Err("Cache not found".to_string());
        }

        let cache_content = std::fs::read_to_string(&cache_path)
            .map_err(|e| format!("Failed to read cache: {}", e))?;

        let registry: Self = serde_json::from_str(&cache_content)
            .map_err(|e| format!("Failed to parse cached registry: {}", e))?;

        Ok(registry)
    }

    fn save_cached(&self) -> Result<(), String> {
        let cache_dir = dirs::cache_dir()
            .ok_or_else(|| "Failed to get cache directory".to_string())?
            .join("opendb");

        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;

        let cache_path = cache_dir.join("plugin_registry.json");

        let cache_content = serde_json::to_string(self)
            .map_err(|e| format!("Failed to serialize registry: {}", e))?;

        std::fs::write(&cache_path, cache_content)
            .map_err(|e| format!("Failed to write cache: {}", e))?;

        Ok(())
    }

    // Convert to enhanced plugin info with status
    pub fn to_plugins_with_status(&self, installed_plugins: &[crate::plugins::manager::PluginInfo], enabled_plugins: &[String]) -> Vec<PluginInfoWithStatus> {
        self.plugins.iter().map(|plugin| {
            let installed_plugin = installed_plugins.iter().find(|p| p.id == plugin.id);
            let installed_version = installed_plugin.map(|p| p.version.clone());
            let update_available = match (&installed_version, &plugin.latest_version) {
                (Some(installed), latest) => installed != latest,
                _ => false,
            };
            let enabled = enabled_plugins.contains(&plugin.id);

            let releases_with_status = plugin.releases.iter().map(|release| PluginReleaseWithStatus {
                version: release.version.clone(),
                min_tabularis_version: release.min_tabularis_version.clone(),
                platform_supported: true, // Assuming all platforms are supported for now
            }).collect();

            PluginInfoWithStatus {
                id: plugin.id.clone(),
                name: plugin.name.clone(),
                description: plugin.description.clone(),
                author: plugin.author.clone(),
                homepage: plugin.homepage.clone(),
                latest_version: plugin.latest_version.clone(),
                releases: releases_with_status,
                installed_version,
                update_available,
                platform_supported: true, // Assuming all platforms are supported for now
                enabled,
            }
        }).collect()
    }
}
