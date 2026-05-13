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
    #[serde(alias = "min_tabularis_version")]
    pub min_crabhub_version: String,
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
    pub min_crabhub_version: String,
    pub platform_supported: bool,
}

impl PluginRegistry {
    pub async fn fetch() -> Result<Self, String> {
        // 0. Load local bundled registry FIRST (always available)
        let mut merged_plugins: Vec<PluginInfo> = Vec::new();
        let mut seen_ids = std::collections::HashSet::new();

        match Self::load_local() {
            Ok(local) => {
                log::info!("Loaded {} plugins from local registry.json", local.plugins.len());
                for p in local.plugins {
                    seen_ids.insert(p.id.clone());
                    merged_plugins.push(p);
                }
            }
            Err(e) => log::warn!("Local registry not found: {}", e),
        }

        // 1. Try cached registry
        if let Ok(cached) = Self::load_cached() {
            let cache_path = Self::cache_path();
            let cache_fresh = std::fs::metadata(&cache_path)
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().map(|e| e.as_secs() < 86400).unwrap_or(false))
                .unwrap_or(false);
            if cache_fresh {
                for p in cached.plugins {
                    if !seen_ids.contains(&p.id) {
                        seen_ids.insert(p.id.clone());
                        merged_plugins.push(p);
                    }
                }
                log::info!("Using fresh cache ({} total plugins)", merged_plugins.len());
                return Ok(Self { schema_version: 1, plugins: merged_plugins });
            }
        }

        // 2. Supplement with remote registries (non-blocking, best-effort)
        let crabhub_url = std::env::var("OPENDB_REGISTRY_URL")
            .unwrap_or_else(|_| "https://raw.githubusercontent.com/crabhub/crabhub-plugins/main/registry.json".to_string());
        if let Ok(registry) = Self::fetch_url(&crabhub_url).await {
            for p in registry.plugins {
                if !seen_ids.contains(&p.id) {
                    seen_ids.insert(p.id.clone());
                    merged_plugins.push(p);
                }
            }
            log::info!("CrabHub registry: added plugins");
        }

        let tabularis_url = "https://raw.githubusercontent.com/TabularisDB/tabularis/main/plugins/registry.json";
        if let Ok(registry) = Self::fetch_url(tabularis_url).await {
            for p in registry.plugins {
                if !seen_ids.contains(&p.id) {
                    seen_ids.insert(p.id.clone());
                    merged_plugins.push(p);
                }
            }
            log::info!("Tabularis registry: added plugins");
        }

        if merged_plugins.is_empty() {
            return Err("No plugin registry available".to_string());
        }

        let registry = Self { schema_version: 1, plugins: merged_plugins };
        let _ = registry.save_cached();
        log::info!("Registry ready: {} plugins", registry.plugins.len());
        Ok(registry)
    }

    async fn fetch_url(url: &str) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Client build error: {}", e))?;
        let response = client.get(url).send().await
            .map_err(|e| format!("Request failed: {}", e))?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        response.json().await
            .map_err(|e| format!("Parse error: {}", e))
    }

    fn cache_path() -> std::path::PathBuf {
        dirs::cache_dir()
            .unwrap_or_default()
            .join("crabhub")
            .join("plugin_registry.json")
    }

    fn load_local() -> Result<Self, String> {
        // Try the bundled registry.json next to the executable
        if let Ok(exe) = std::env::current_exe() {
            let local = exe.parent().unwrap_or(std::path::Path::new("."))
                .join("..").join("..").join("..").join("plugins").join("registry.json");
            if local.exists() {
                let content = std::fs::read_to_string(&local)
                    .map_err(|e| format!("Read error: {}", e))?;
                return serde_json::from_str(&content)
                    .map_err(|e| format!("Parse error: {}", e));
            }
        }
        // Fallback: look relative to CWD (dev mode)
        let cwd_path = std::path::Path::new("plugins").join("registry.json");
        if cwd_path.exists() {
            let content = std::fs::read_to_string(&cwd_path)
                .map_err(|e| format!("Read error: {}", e))?;
            return serde_json::from_str(&content)
                .map_err(|e| format!("Parse error: {}", e));
        }
        Err("Local registry not found".to_string())
    }

    fn load_cached() -> Result<Self, String> {
        let cache_path = Self::cache_path();
        if !cache_path.exists() {
            return Err("Cache not found".to_string());
        }
        let cache_content = std::fs::read_to_string(&cache_path)
            .map_err(|e| format!("Failed to read cache: {}", e))?;
        serde_json::from_str(&cache_content)
            .map_err(|e| format!("Failed to parse cached registry: {}", e))
    }

    fn save_cached(&self) -> Result<(), String> {
        let cache_path = Self::cache_path();
        if let Some(parent) = cache_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create cache directory: {}", e))?;
        }
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
                min_crabhub_version: release.min_crabhub_version.clone(),
                platform_supported: true,
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
