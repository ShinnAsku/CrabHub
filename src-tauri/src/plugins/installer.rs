use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use reqwest::{Client, redirect};
use tempfile;
use zip::ZipArchive;

use super::registry::PluginRegistry;

pub struct PluginInstaller {
    client: Client,
    plugins_dir: PathBuf,
}

impl PluginInstaller {
    pub fn new(plugins_dir: PathBuf) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .redirect(redirect::Policy::limited(5))
            .build()
            .unwrap();

        Self {
            client,
            plugins_dir,
        }
    }

    pub async fn install_plugin(&self, plugin_id: &str, version: &str) -> Result<(), String> {
        // Fetch registry
        let registry = PluginRegistry::fetch().await
            .map_err(|e| format!("Failed to fetch plugin registry: {}", e))?;

        // Find plugin in registry
        let plugin = registry.plugins
            .iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{}' not found in registry", plugin_id))?;

        // Find version
        let release = plugin.releases
            .iter()
            .find(|r| r.version == version)
            .ok_or_else(|| format!("Version '{}' not found for plugin '{}'", version, plugin_id))?;

        // Determine platform
        let platform = Self::get_platform().unwrap_or_else(|| "universal".to_string());

        // Get download URL — try platform-specific first, then universal
        let download_url = release.assets.get(&platform)
            .or_else(|| release.assets.get("universal"))
            .ok_or_else(|| format!("No download available for platform '{}'", platform))?;

        log::info!("Downloading plugin '{}' from: {}", plugin_id, download_url);

        // Download with retry
        let body = match self.download_with_retry(download_url, 2).await {
            Ok(b) => b,
            Err(e) => {
                log::warn!("Download failed for '{}': {}. Creating placeholder manifest.", plugin_id, e);
                // Create minimal manifest so plugin shows as "manual install needed"
                let plugin_dir = self.plugins_dir.join(plugin_id);
                fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
                let manifest = serde_json::json!({
                    "id": plugin_id,
                    "name": plugin.name,
                    "version": version,
                    "description": format!("{} (manual install needed)", plugin.description),
                    "executable": format!("{}-plugin", plugin_id),
                    "capabilities": { "schemas": false, "views": false, "routines": false, "file_based": false },
                    "data_types": []
                });
                fs::write(
                    plugin_dir.join("manifest.json"),
                    serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
                ).map_err(|e| e.to_string())?;
                log::info!("Created placeholder manifest for '{}'. Download manually: {}", plugin_id, download_url);
                return Err(format!("Download failed. Please download manually from: {}", download_url));
            }
        };

        // Extract zip
        let temp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let temp_zip = temp_dir.path().join("plugin.zip");
        fs::write(&temp_zip, body).map_err(|e| e.to_string())?;

        let file = fs::File::open(&temp_zip).map_err(|e| e.to_string())?;
        let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

        let plugin_dir = self.plugins_dir.join(plugin_id);
        if plugin_dir.exists() {
            fs::remove_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let outpath = plugin_dir.join(file.name());
            if (*file.name()).ends_with('/') {
                fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            } else {
                if let Some(p) = outpath.parent() {
                    if !p.exists() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
                }
                let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
            }
        }

        Ok(())
    }

    async fn download_with_retry(&self, url: &str, retries: u32) -> Result<Vec<u8>, String> {
        let mut last_err = String::new();
        for attempt in 0..=retries {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            match self.client.get(url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    return resp.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("Read error: {}", e));
                }
                Ok(resp) => last_err = format!("HTTP {}", resp.status()),
                Err(e) => last_err = format!("Network error: {}", e),
            }
        }
        Err(last_err)
    }

    fn get_platform() -> Option<String> {
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;

        match (os, arch) {
            ("linux", "x86_64") => Some("linux-x64".to_string()),
            ("macos", "aarch64") => Some("darwin-arm64".to_string()),
            ("macos", "x86_64") => Some("darwin-x64".to_string()),
            ("windows", "x86_64") => Some("win-x64".to_string()),
            _ => None,
        }
    }
}