use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use reqwest::Client;
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
            .timeout(Duration::from_secs(30))
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
        let platform = Self::get_platform()
            .ok_or_else(|| "Unsupported platform".to_string())?;

        // Get download URL for platform
        let download_url = release.assets.get(&platform)
            .ok_or_else(|| format!("No download available for platform '{}'", platform))?;

        // Download plugin
        let response = self.client.get(download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download plugin: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Failed to download plugin: {}", response.status()));
        }

        // Read response body
        let body = response.bytes()
            .await
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        // Create temporary file
        let temp_dir = tempfile::tempdir()
            .map_err(|e| format!("Failed to create temporary directory: {}", e))?;
        let temp_zip = temp_dir.path().join("plugin.zip");

        fs::write(&temp_zip, body)
            .map_err(|e| format!("Failed to write temporary file: {}", e))?;

        // Extract zip
        let file = fs::File::open(&temp_zip)
            .map_err(|e| format!("Failed to open zip file: {}", e))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|e| format!("Failed to open zip archive: {}", e))?;

        // Create plugin directory
        let plugin_dir = self.plugins_dir.join(plugin_id);
        if plugin_dir.exists() {
            fs::remove_dir_all(&plugin_dir)
                .map_err(|e| format!("Failed to remove existing plugin directory: {}", e))?;
        }
        fs::create_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to create plugin directory: {}", e))?;

        // Extract all files
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)
                .map_err(|e| format!("Failed to get file from archive: {}", e))?;
            let outpath = plugin_dir.join(file.name());

            if (*file.name()).ends_with('/') {
                fs::create_dir_all(&outpath)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            } else {
                if let Some(p) = outpath.parent() {
                    if !p.exists() {
                        fs::create_dir_all(p)
                            .map_err(|e| format!("Failed to create directory: {}", e))?;
                    }
                }
                let mut outfile = fs::File::create(&outpath)
                    .map_err(|e| format!("Failed to create file: {}", e))?;
                std::io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("Failed to copy file: {}", e))?;
            }
        }

        Ok(())
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