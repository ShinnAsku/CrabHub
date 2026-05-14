use serde::{Deserialize, Serialize};
use crate::db::types::DatabaseType;

/// Connection configuration model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_encrypted: Option<String>,
    pub database: Option<String>,
    #[serde(default)]
    pub enable_ssl: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_ca_cert: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_client_cert: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_client_key: Option<String>,
    #[serde(default)]
    pub ssh_tunnel_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_password_encrypted: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_private_key: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive_interval: u32,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<String>, // JSON array
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_connected_at: Option<String>,
    #[serde(default)]
    pub connection_count: u64,
}

fn default_keepalive() -> u32 {
    30
}

fn default_true() -> bool {
    true
}

/// Connection group model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub created_at: Option<String>,
}

/// Connection-Group mapping
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionGroupMapping {
    pub connection_id: String,
    pub group_id: String,
}

/// Metadata key-value pair
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metadata {
    pub key: String,
    pub value: String,
    pub created_at: Option<String>,
}
