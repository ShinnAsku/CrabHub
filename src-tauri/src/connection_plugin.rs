use crabhub_lib::connection_store::ConnectionStore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, State,
};

pub struct ConnectionStoreState(Arc<tokio::sync::Mutex<Option<ConnectionStore>>>);

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    db_type: String,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    database: Option<String>,
    #[serde(rename = "enableSsl", default)]
    enable_ssl: bool,
    #[serde(rename = "sslCaCert", skip_serializing_if = "Option::is_none")]
    ssl_ca_cert: Option<String>,
    #[serde(rename = "sslClientCert", skip_serializing_if = "Option::is_none")]
    ssl_client_cert: Option<String>,
    #[serde(rename = "sslClientKey", skip_serializing_if = "Option::is_none")]
    ssl_client_key: Option<String>,
    #[serde(rename = "keepaliveInterval", default = "default_keepalive")]
    keepalive_interval: u32,
    #[serde(rename = "autoReconnect", default = "default_true")]
    auto_reconnect: bool,
    #[serde(rename = "sshTunnel", skip_serializing_if = "Option::is_none")]
    ssh_tunnel: Option<SshTunnelDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SshTunnelDto {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    #[serde(rename = "privateKey", skip_serializing_if = "Option::is_none")]
    private_key: Option<String>,
}

fn default_keepalive() -> u32 {
    30
}

fn default_true() -> bool {
    true
}

// ===== Tauri Commands =====

#[tauri::command]
async fn init(state: State<'_, ConnectionStoreState>) -> Result<(), String> {
    let mut store = state.0.lock().await;
    
    if store.is_some() {
        return Ok(());
    }

    // Get app data directory
    let app_data_dir = dirs::data_local_dir()
        .ok_or("Failed to get app data directory")?
        .join("crabhub");

    // Create directory if it doesn't exist
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;

    let db_path = app_data_dir.join("connections.db");
    
    let connection_store = ConnectionStore::new(db_path.to_str().unwrap())?;
    *store = Some(connection_store);

    Ok(())
}

#[tauri::command]
async fn create_connection(
    state: State<'_, ConnectionStoreState>,
    connection: ConnectionDto,
) -> Result<(), String> {
    let store = state.0.lock().await;
    let store = store.as_ref().ok_or("Connection store not initialized")?;

    let conn = convert_dto_to_model(connection)?;
    store.create_connection(&conn)
}

#[tauri::command]
async fn get_all_connections(
    state: State<'_, ConnectionStoreState>,
) -> Result<Vec<ConnectionDto>, String> {
    let store = state.0.lock().await;
    let store = store.as_ref().ok_or("Connection store not initialized")?;

    let connections = store.get_all_connections()?;
    connections.into_iter().map(convert_model_to_dto).collect()
}

#[tauri::command]
async fn get_connection(
    state: State<'_, ConnectionStoreState>,
    id: String,
) -> Result<Option<ConnectionDto>, String> {
    let store = state.0.lock().await;
    let store = store.as_ref().ok_or("Connection store not initialized")?;

    match store.get_connection(&id)? {
        Some(conn) => Ok(Some(convert_model_to_dto(conn)?)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn update_connection(
    state: State<'_, ConnectionStoreState>,
    connection: ConnectionDto,
) -> Result<(), String> {
    let store = state.0.lock().await;
    let store = store.as_ref().ok_or("Connection store not initialized")?;

    let conn = convert_dto_to_model(connection)?;
    store.update_connection(&conn)
}

#[tauri::command]
async fn delete_connection(
    state: State<'_, ConnectionStoreState>,
    id: String,
) -> Result<(), String> {
    let store = state.0.lock().await;
    let store = store.as_ref().ok_or("Connection store not initialized")?;

    store.delete_connection(&id)
}

#[tauri::command]
async fn update_connection_stats(
    state: State<'_, ConnectionStoreState>,
    id: String,
) -> Result<(), String> {
    let store = state.0.lock().await;
    let store = store.as_ref().ok_or("Connection store not initialized")?;

    store.update_connection_stats(&id)
}

// ===== Helper Functions =====

fn convert_dto_to_model(dto: ConnectionDto) -> Result<crabhub_lib::connection_store::models::Connection, String> {
    use crabhub_lib::connection_store::models::DbType;

    let db_type = DbType::from_str(&dto.db_type)
        .ok_or(format!("Invalid database type: {}", dto.db_type))?;

    Ok(crabhub_lib::connection_store::models::Connection {
        id: dto.id,
        name: dto.name,
        db_type,
        host: dto.host,
        port: Some(dto.port.unwrap_or(0)),
        username: dto.username,
        password_encrypted: dto.password,
        database: dto.database,
        enable_ssl: dto.enable_ssl,
        ssl_ca_cert: dto.ssl_ca_cert,
        ssl_client_cert: dto.ssl_client_cert,
        ssl_client_key: dto.ssl_client_key,
        ssh_tunnel_enabled: dto.ssh_tunnel.is_some(),
        ssh_host: dto.ssh_tunnel.as_ref().and_then(|s| Some(s.host.clone())),
        ssh_port: dto.ssh_tunnel.as_ref().and_then(|s| Some(s.port)),
        ssh_username: dto.ssh_tunnel.as_ref().and_then(|s| Some(s.username.clone())),
        ssh_password_encrypted: dto.ssh_tunnel.and_then(|s| s.password),
        ssh_private_key: None,
        keepalive_interval: dto.keepalive_interval,
        auto_reconnect: dto.auto_reconnect,
        color_label: dto.color_label,
        tags: dto.tags.map(|t| serde_json::to_string(&t).unwrap_or_default()),
        created_at: None,
        updated_at: None,
        last_connected_at: None,
        connection_count: 0,
    })
}

fn convert_model_to_dto(
    model: crabhub_lib::connection_store::models::Connection,
) -> Result<ConnectionDto, String> {
    let ssh_tunnel = if model.ssh_tunnel_enabled {
        Some(SshTunnelDto {
            host: model.ssh_host.unwrap_or_default(),
            port: model.ssh_port.unwrap_or(22),
            username: model.ssh_username.unwrap_or_default(),
            password: model.ssh_password_encrypted,
            private_key: model.ssh_private_key,
        })
    } else {
        None
    };

    let tags: Option<Vec<String>> = model
        .tags
        .and_then(|t| serde_json::from_str(&t).ok());

    Ok(ConnectionDto {
        id: model.id,
        name: model.name,
        db_type: model.db_type.as_str().to_string(),
        host: model.host,
        port: model.port.filter(|&p| p > 0),
        username: model.username,
        password: model.password_encrypted,
        database: model.database,
        enable_ssl: model.enable_ssl,
        ssl_ca_cert: model.ssl_ca_cert,
        ssl_client_cert: model.ssl_client_cert,
        ssl_client_key: model.ssl_client_key,
        keepalive_interval: model.keepalive_interval,
        auto_reconnect: model.auto_reconnect,
        ssh_tunnel,
        tags,
        color_label: model.color_label,
    })
}

// ===== Plugin Builder =====

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("connection-store")
        .invoke_handler(tauri::generate_handler![
            init,
            create_connection,
            get_all_connections,
            get_connection,
            update_connection,
            delete_connection,
            update_connection_stats,
        ])
        .setup(|app, _api| {
            app.manage(ConnectionStoreState(Arc::new(tokio::sync::Mutex::new(
                None,
            ))));
            Ok(())
        })
        .build()
}
