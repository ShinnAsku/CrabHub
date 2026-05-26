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

// ===== AI Settings =====

#[tauri::command]
pub async fn save_ai_settings(
    state: State<'_, Arc<ConnectionStore>>,
    settings_json: String,
) -> Result<(), String> {
    state.save_ai_settings(&settings_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_ai_settings(
    state: State<'_, Arc<ConnectionStore>>,
) -> Result<Option<String>, String> {
    state.load_ai_settings().map_err(|e| e.to_string())
}

// ===== Chat History =====

#[tauri::command]
pub async fn save_chat_message(
    state: State<'_, Arc<ConnectionStore>>,
    session_id: String,
    role: String,
    content: String,
) -> Result<i64, String> {
    state.save_chat_message(&session_id, &role, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_chat_history(
    state: State<'_, Arc<ConnectionStore>>,
    session_id: String,
) -> Result<Vec<(String, String, String)>, String> {
    state.load_chat_history(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_chat_history(
    state: State<'_, Arc<ConnectionStore>>,
    session_id: String,
) -> Result<(), String> {
    state.clear_chat_history(&session_id).map_err(|e| e.to_string())
}
