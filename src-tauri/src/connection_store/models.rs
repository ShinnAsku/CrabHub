use serde::{Deserialize, Serialize};

/// Connection configuration model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub db_type: DbType,
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

/// Database type enum
#[derive(Debug, Clone, PartialEq)]
pub enum DbType {
    PostgreSQL,
    MySql,
    SQLite,
    ClickHouse,
    GaussDB,
    Plugin(String),
}

impl Serialize for DbType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            DbType::Plugin(id) => serializer.serialize_str(&format!("plugin:{}", id)),
            other => serializer.serialize_str(other.as_str()),
        }
    }
}

impl<'de> Deserialize<'de> for DbType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        DbType::from_str(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown db type: {}", s)))
    }
}

impl DbType {
    pub fn as_str(&self) -> &str {
        match self {
            DbType::PostgreSQL => "postgresql",
            DbType::MySql => "mysql",
            DbType::SQLite => "sqlite",
            DbType::ClickHouse => "clickhouse",
            DbType::GaussDB => "gaussdb",
            DbType::Plugin(_) => "plugin",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "postgresql" => Some(DbType::PostgreSQL),
            "mysql" => Some(DbType::MySql),
            "sqlite" => Some(DbType::SQLite),
            "clickhouse" => Some(DbType::ClickHouse),
            "gaussdb" | "opengauss" => Some(DbType::GaussDB),
            other if other.starts_with("plugin:") => {
                Some(DbType::Plugin(other[7..].to_string()))
            }
            _ => None,
        }
    }
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
