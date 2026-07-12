//! CrabHub Web Server binary — self-hosted / Docker deployment.
//!
//! Environment:
//!   CRABHUB_WEB_PORT       listen port (default 4224)
//!   CRABHUB_BIND           bind address (default 127.0.0.1; 0.0.0.0 requires password)
//!   CRABHUB_WEB_PASSWORD   login password; REQUIRED for non-loopback binds
//!   CRABHUB_MASTER_KEY     credential-encryption key (>=16 chars); required
//!                          on hosts without an OS keyring (containers)
//!   CRABHUB_DATA_DIR       data directory (default: OS app-data dir)
//!   CRABHUB_STATIC_DIR     built frontend to serve (default: ./dist)

use std::sync::Arc;

use crabhub_lib::connection_store::ConnectionStore;
use crabhub_lib::db::manager::ConnectionManager;
use crabhub_lib::server::{build_router, ServerState};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let port: u16 = std::env::var("CRABHUB_WEB_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4224);
    let bind = std::env::var("CRABHUB_BIND").unwrap_or_else(|_| "127.0.0.1".into());
    let env_password = std::env::var("CRABHUB_WEB_PASSWORD").ok().filter(|p| !p.is_empty());

    // Data directory
    let data_dir = std::env::var("CRABHUB_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("com.crabhub.app")
        });
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("error: cannot create data dir {:?}: {e}", data_dir);
        std::process::exit(1);
    }

    // Connection store (SQLite + AES-256-GCM; key from CRABHUB_MASTER_KEY or OS keyring)
    let db_path = data_dir.join("connections.db");
    let store = match ConnectionStore::new(db_path.to_str().unwrap_or(":memory:")) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!(
                "error: connection store init failed: {e}\n\
                 hint: on headless hosts set CRABHUB_MASTER_KEY (>=16 chars)"
            );
            std::process::exit(1);
        }
    };

    // Connection manager + plugins + heartbeat (same core as desktop)
    let manager = Arc::new(ConnectionManager::new());
    if let Ok(plugins_dir) = crabhub_lib::get_tabularis_plugins_dir() {
        let pm = Arc::new(crabhub_lib::plugins::manager::PluginManager::new(plugins_dir));
        let pm_clone = pm.clone();
        tokio::spawn(async move {
            if let Err(e) = pm_clone.load_plugins().await {
                log::warn!("plugin load failed: {e}");
            }
        });
        manager.set_plugin_manager(pm);
    }
    tokio::spawn(ConnectionManager::start_heartbeat(manager.clone()));

    // Static frontend
    let static_dir = std::env::var("CRABHUB_STATIC_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("dist"));
    let static_dir = static_dir.exists().then_some(static_dir);
    if static_dir.is_none() {
        log::warn!("static dir not found — serving API only (set CRABHUB_STATIC_DIR)");
    }

    let state = Arc::new(ServerState {
        manager,
        store,
        tokens: std::sync::Mutex::new(Default::default()),
        login_guard: std::sync::Mutex::new(Default::default()),
    });

    // CRABHUB_WEB_PASSWORD seeds the stored hash on first start; afterwards
    // the persisted hash wins (DBX-style). Setting the env var again on a
    // later start rotates the password.
    if let Some(pw) = env_password {
        if pw.len() < 8 {
            eprintln!("error: CRABHUB_WEB_PASSWORD must be at least 8 characters");
            std::process::exit(1);
        }
        let hash = crabhub_lib::server::hash_password(&pw);
        if let Err(e) = state.store.set_metadata("web_password_hash", &hash) {
            eprintln!("error: cannot persist web password: {e}");
            std::process::exit(1);
        }
        log::info!("web password set from CRABHUB_WEB_PASSWORD");
    }

    // Refuse to expose the server without auth. A database gateway reachable
    // from the network with no password is a breach waiting to happen.
    // (First-run setup via the UI is only allowed on loopback binds.)
    if bind != "127.0.0.1" && bind != "localhost" && !state.auth_required() {
        eprintln!("error: a web password is required when binding to {bind}; set CRABHUB_WEB_PASSWORD");
        std::process::exit(1);
    }

    let app = build_router(state, static_dir);

    let addr = format!("{bind}:{port}");
    log::info!("CrabHub web server listening on http://{addr}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
