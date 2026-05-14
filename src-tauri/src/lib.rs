mod ai;
mod commands;
mod connection_store;
mod db;
mod plugins;
mod rpc;
mod ssh;

use connection_store::ConnectionStore;
use db::manager::ConnectionManager;
use std::sync::Arc;
use std::path::PathBuf;
use tauri::Manager;
use tauri::menu::{MenuBuilder, SubmenuBuilder};

fn get_tabularis_plugins_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Use Tabularis-compatible plugin directory
    #[cfg(target_os = "macos")]
    {
        // macOS: ~/Library/Application Support/com.crabhub.app/plugins/
        if let Some(home) = dirs::home_dir() {
            let path = home.join("Library").join("Application Support").join("com.crabhub.app").join("plugins");
            std::fs::create_dir_all(&path)?;
            return Ok(path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: ~/.local/share/crabhub/plugins/
        if let Some(home) = dirs::home_dir() {
            let path = home.join(".local").join("share").join("crabhub").join("plugins");
            std::fs::create_dir_all(&path)?;
            return Ok(path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: %APPDATA%\com.crabhub.app\plugins\
        if let Ok(app_data) = std::env::var("APPDATA") {
            let path = PathBuf::from(app_data).join("com.crabhub.app").join("plugins");
            std::fs::create_dir_all(&path)?;
            return Ok(path);
        }
    }

    // Fallback to app data dir if specific app directory
    if let Some(app_dir) = dirs::config_dir() {
        let path = app_dir.join("crabhub").join("plugins");
        std::fs::create_dir_all(&path)?;
        Ok(path)
    } else {
        Err("Could not determine home directory".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let manager = Arc::new(ConnectionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_secure_storage::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(manager.clone())
        .invoke_handler(tauri::generate_handler![
            // Connection store commands (SQLite persistence)
            connection_store::get_connections,
            connection_store::add_connection,
            connection_store::update_connection,
            connection_store::delete_connection,
            // Database commands
            db::commands::connect_to_database,
            db::commands::disconnect_database,
            db::commands::execute_query,
            db::commands::execute_query_paged,
            db::commands::execute_sql,
            db::commands::get_tables,
            db::commands::get_columns,
            db::commands::get_schemas,
            db::commands::get_databases,
            db::commands::test_connection_cmd,
            db::commands::export_table_sql,
            db::commands::export_database,
            db::commands::get_connection_status,
            // New metadata commands
            db::commands::get_views,
            db::commands::get_indexes,
            db::commands::get_foreign_keys,
            db::commands::get_table_row_count,
            // New data editing commands
            db::commands::update_table_rows,
            db::commands::insert_table_row,
            db::commands::delete_table_rows,
            db::commands::get_table_data,
            // AI commands
            ai::commands::ai_chat,
            ai::commands::analyze_sql,
            ai::commands::format_sql,
            // Plugin commands
            plugins::commands::list_plugins,
            plugins::commands::fetch_plugin_registry,
            plugins::commands::install_plugin,
            plugins::commands::remove_plugin,
            plugins::commands::reload_plugins,
            plugins::commands::enable_plugin,
            plugins::commands::disable_plugin,
            plugins::commands::get_available_drivers,
        ])
        .setup(move |app| {
            // Build native Edit menu for macOS keyboard shortcuts (Cmd+Z/C/V/X/A)
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&edit_menu)
                .build()?;

            app.set_menu(menu)?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize ConnectionStore with SQLite
            let app_dir = app.path().app_data_dir().unwrap_or_default();
            std::fs::create_dir_all(&app_dir).ok();
            let db_path = app_dir.join("connections.db");
            let store = Arc::new(ConnectionStore::new(db_path.to_str().unwrap()).unwrap());
            app.manage(store);

            // Initialize PluginManager - use Tabularis-compatible plugin directory
            match get_tabularis_plugins_dir() {
                Ok(plugins_dir) => {
                    let plugin_manager = Arc::new(plugins::manager::PluginManager::new(plugins_dir));
                    manager.set_plugin_manager(plugin_manager.clone());
                    app.manage(plugin_manager);
                }
                Err(e) => {
                    // Log error but continue app startup
                    eprintln!("Failed to initialize plugin directory: {}", e);
                }
            }

            // Start the background heartbeat task
            let manager_clone = manager.clone();
            tauri::async_runtime::spawn(async move {
                ConnectionManager::start_heartbeat(manager_clone).await;
            });

            // Start RPC server for plugin communication
            let manager_clone = manager.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = rpc::server::start_rpc_server(manager_clone).await {
                    log::error!("Failed to start RPC server: {}", e);
                }
            });

            // Start MCP server for AI tool integration (TODO: Fix rmcp dependency)
            // tauri::async_runtime::spawn(async move {
            //     use rmcp::Server;
            //     use rmcp::tool::ToolCollection;
            //     
            //     let tools = ToolCollection::default();
            //     let server = Server::new(tools);
            //     
            //     if let Err(e) = server.serve("127.0.0.1:3031").await {
            //         log::error!("Failed to start MCP server: {}", e);
            //     }
            // });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CrabHub application");
}
