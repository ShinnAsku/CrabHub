use super::models::Connection;
use super::ConnectionStore;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_connections(
    state: State<'_, Arc<ConnectionStore>>,
) -> Result<Vec<Connection>, String> {
    log::debug!("[ConnectionStore] get_connections");
    let result = state.get_all_connections();
    match &result {
        Ok(conns) => log::debug!("[ConnectionStore] get_connections: {} entries", conns.len()),
        Err(e) => log::warn!("[ConnectionStore] get_connections failed: {}", e),
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_connection(
    state: State<'_, Arc<ConnectionStore>>,
    connection: Connection,
) -> Result<(), String> {
    log::debug!("[ConnectionStore] add_connection: id={}", connection.id);
    let result = state.create_connection(&connection);
    if let Err(e) = &result {
        log::warn!("[ConnectionStore] add_connection failed: {}", e);
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_connection(
    state: State<'_, Arc<ConnectionStore>>,
    connection: Connection,
) -> Result<(), String> {
    log::debug!("[ConnectionStore] update_connection: id={}", connection.id);
    let result = state.update_connection(&connection);
    if let Err(e) = &result {
        log::warn!("[ConnectionStore] update_connection failed: {}", e);
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_connection(
    state: State<'_, Arc<ConnectionStore>>,
    id: String,
) -> Result<(), String> {
    log::debug!("[ConnectionStore] delete_connection: id={}", id);
    let result = state.delete_connection(&id);
    if let Err(e) = &result {
        log::warn!("[ConnectionStore] delete_connection failed: {}", e);
    }
    result.map_err(|e| e.to_string())
}
