mod db;

use db::manager::ConnectionManager;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let manager = Arc::new(ConnectionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(manager.clone())
        .invoke_handler(tauri::generate_handler![
            db::commands::connect_to_database,
            db::commands::disconnect_database,
            db::commands::execute_query,
            db::commands::execute_sql,
            db::commands::get_tables,
            db::commands::get_columns,
            db::commands::get_schemas,
            db::commands::test_connection_cmd,
            db::commands::export_table_sql,
            db::commands::export_database,
            db::commands::get_connection_status,
        ])
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Start the background heartbeat task
            let manager_clone = manager.clone();
            tauri::async_runtime::spawn(async move {
                ConnectionManager::start_heartbeat(manager_clone).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running openDB application");
}
