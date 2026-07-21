//! CrabHub Web Server — axum HTTP layer over the same core the desktop uses.
//!
//! Serves the built frontend (`dist/`) and exposes Tauri-equivalent commands
//! at `POST /api/invoke/{cmd}` with the SAME JSON argument shapes the frontend
//! already sends through `safeInvoke`, so the web UI needs only a transport
//! swap, not new API bindings.
//!
//! Auth: when `CRABHUB_WEB_PASSWORD` is set, `POST /api/login` exchanges the
//! password for a bearer token; every `/api/*` call must carry it. When unset,
//! the server refuses to bind non-loopback addresses.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::connection_store::Connection as StoredConnection;
use crate::connection_store::ConnectionStore;
use crate::db::manager::ConnectionManager;
use crate::db::types::{ConnectionConfig, WirePagedQueryResult, WireQueryResult, WhereCondition};

/// Metadata key under which the PBKDF2 password hash is persisted.
const PASSWORD_HASH_KEY: &str = "web_password_hash";
/// Session lifetime. Idle web tools shouldn't hold DB access forever.
const TOKEN_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60 * 24);
/// Consecutive failures before login starts backing off.
const LOCKOUT_THRESHOLD: u32 = 5;

pub struct ServerState {
    pub manager: Arc<ConnectionManager>,
    pub store: Arc<ConnectionStore>,
    /// Active session tokens with creation time (TTL-expired lazily).
    pub tokens: std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
    /// Brute-force guard for the login endpoint.
    pub login_guard: std::sync::Mutex<LoginGuard>,
}

#[derive(Default)]
pub struct LoginGuard {
    consecutive_failures: u32,
    locked_until: Option<std::time::Instant>,
}

impl LoginGuard {
    /// Seconds the caller must wait, or None if login may proceed.
    fn retry_after(&self) -> Option<u64> {
        self.locked_until
            .and_then(|t| t.checked_duration_since(std::time::Instant::now()))
            .map(|d| d.as_secs().max(1))
    }

    fn record_failure(&mut self) {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= LOCKOUT_THRESHOLD {
            // Exponential backoff: 2, 4, 8 ... capped at 300 s.
            let exp = (self.consecutive_failures - LOCKOUT_THRESHOLD).min(8);
            let secs = (1u64 << (exp + 1)).min(300);
            self.locked_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(secs));
        }
    }

    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.locked_until = None;
    }
}

// --- Password hashing (PBKDF2-HMAC-SHA256, reusing existing crypto deps) ---

const PBKDF2_ITERATIONS: u32 = 100_000;

pub fn hash_password(password: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut hash = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), &salt, PBKDF2_ITERATIONS, &mut hash);
    format!("pbkdf2${}${}${}", PBKDF2_ITERATIONS, STANDARD.encode(salt), STANDARD.encode(hash))
}

fn verify_password(password: &str, stored: &str) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else { return false };
    let (Ok(salt), Ok(expected)) = (STANDARD.decode(parts[2]), STANDARD.decode(parts[3])) else {
        return false;
    };
    let mut actual = vec![0u8; expected.len()];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), &salt, iterations, &mut actual);
    // Constant-time comparison: XOR-accumulate every byte so timing does not
    // leak the position of the first mismatch.
    if actual.len() != expected.len() {
        return false;
    }
    actual.iter().zip(expected.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

impl ServerState {
    fn password_hash(&self) -> Option<String> {
        self.store.get_metadata(PASSWORD_HASH_KEY).ok().flatten()
    }

    /// Whether login is required (a password has been configured).
    pub fn auth_required(&self) -> bool {
        self.password_hash().is_some()
    }

    fn issue_token(&self) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.tokens
            .lock()
            .unwrap()
            .insert(token.clone(), std::time::Instant::now());
        token
    }

    fn token_valid(&self, token: &str) -> bool {
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, created| created.elapsed() < TOKEN_TTL);
        tokens.contains_key(token)
    }
}

type AppState = Arc<ServerState>;

pub fn build_router(state: AppState, static_dir: Option<std::path::PathBuf>) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/check", get(auth_check))
        .route("/api/auth/setup", post(auth_setup))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/invoke/{cmd}", post(invoke))
        .with_state(state);

    if let Some(dir) = static_dir {
        let serve = tower_http::services::ServeDir::new(&dir)
            .fallback(tower_http::services::ServeFile::new(dir.join("index.html")));
        router = router.fallback_service(serve);
    }
    router
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

// --- Auth endpoints (DBX-style: check → setup/login → bearer sessions) ---

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|auth| auth.strip_prefix("Bearer "))
}

/// Auth state probe driving the frontend's login/setup screens.
async fn auth_check(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let required = state.auth_required();
    let authenticated = if required {
        bearer_token(&headers).is_some_and(|t| state.token_valid(t))
    } else {
        true
    };
    Json(json!({
        "required": required,
        "authenticated": authenticated,
        "setupRequired": !required,
    }))
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

/// First-run password setup. Rejected once a password exists — changing it
/// afterwards requires CRABHUB_WEB_PASSWORD + restart (deliberate friction).
async fn auth_setup(State(state): State<AppState>, Json(body): Json<PasswordBody>) -> Response {
    if state.auth_required() {
        return (StatusCode::CONFLICT, Json(json!({ "error": "password already configured" }))).into_response();
    }
    if body.password.len() < 8 {
        return err("password must be at least 8 characters");
    }
    if let Err(e) = state.store.set_metadata(PASSWORD_HASH_KEY, &hash_password(&body.password)) {
        return err(e);
    }
    log::info!("[auth] web password configured via first-run setup");
    Json(json!({ "token": state.issue_token() })).into_response()
}

async fn auth_login(State(state): State<AppState>, Json(body): Json<PasswordBody>) -> Response {
    let Some(stored) = state.password_hash() else {
        // No password configured — nothing to log into.
        return Json(json!({ "token": "" })).into_response();
    };

    if let Some(secs) = state.login_guard.lock().unwrap().retry_after() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": format!("too many failed attempts; retry in {}s", secs) })),
        )
            .into_response();
    }

    if verify_password(&body.password, &stored) {
        state.login_guard.lock().unwrap().record_success();
        Json(json!({ "token": state.issue_token() })).into_response()
    } else {
        let mut guard = state.login_guard.lock().unwrap();
        guard.record_failure();
        log::warn!("[auth] failed login attempt ({} consecutive)", guard.consecutive_failures);
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid password" }))).into_response()
    }
}

async fn auth_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = bearer_token(&headers) {
        state.tokens.lock().unwrap().remove(token);
    }
    Json(json!({ "ok": true })).into_response()
}

fn check_auth(state: &ServerState, headers: &HeaderMap) -> bool {
    if !state.auth_required() {
        return true; // no password configured (loopback-only enforced at bind time)
    }
    bearer_token(headers).is_some_and(|t| state.token_valid(t))
}

/// Map an application error string to an HTTP 400 JSON body the frontend's
/// fetch transport rejects with — mirroring how Tauri invoke rejects.
fn err(msg: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg.into() }))).into_response()
}

fn ok<T: serde::Serialize>(value: T) -> Response {
    Json(serde_json::to_value(value).unwrap_or(Value::Null)).into_response()
}

// --- Argument shapes (match the camelCase JSON the frontend already sends) ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchDbArgs {
    id: String,
    database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlArgs {
    id: String,
    sql: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PagedArgs {
    id: String,
    sql: String,
    limit: u64,
    offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchArgs {
    id: String,
    statements: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableArgs {
    id: String,
    table: String,
    #[serde(default)]
    schema: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaOnlyArgs {
    id: String,
    #[serde(default)]
    schema: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseNameArgs {
    id: String,
    database_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableDataArgs {
    id: String,
    table: String,
    #[serde(default)]
    schema: Option<String>,
    page: u32,
    page_size: u32,
    #[serde(default)]
    order_by: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRowsArgs {
    id: String,
    table: String,
    #[serde(default)]
    schema: Option<String>,
    updates: Vec<(String, Value)>,
    where_conditions: Vec<WhereCondition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InsertRowArgs {
    id: String,
    table: String,
    #[serde(default)]
    schema: Option<String>,
    values: Vec<(String, Value)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRowsArgs {
    id: String,
    table: String,
    #[serde(default)]
    schema: Option<String>,
    where_conditions: Vec<WhereCondition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigArgs {
    config: ConnectionConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportDbArgs {
    id: String,
    #[serde(default)]
    tables: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ConnectionArg {
    connection: StoredConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsJsonArgs {
    settings_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSaveArgs {
    session_id: String,
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionArgs {
    session_id: String,
}

#[allow(clippy::result_large_err)] // Err is the ready-to-send 400 Response; built once per bad request
fn parse<T: serde::de::DeserializeOwned>(body: &Value) -> Result<T, Response> {
    serde_json::from_value(body.clone()).map_err(|e| err(format!("invalid arguments: {}", e)))
}

macro_rules! args {
    ($body:expr) => {
        match parse(&$body) {
            Ok(v) => v,
            Err(resp) => return resp,
        }
    };
}

async fn invoke(
    State(state): State<AppState>,
    Path(cmd): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !check_auth(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let m = &state.manager;

    match cmd.as_str() {
        // --- Connection lifecycle ---
        "connect_to_database" => {
            let a: ConfigArgs = args!(body);
            match m.connect(a.config).await {
                Ok(r) => ok(r),
                Err(e) => err(e.to_string()),
            }
        }
        "disconnect_database" => {
            let a: IdArgs = args!(body);
            match m.disconnect(&a.id).await {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e.to_string()),
            }
        }
        "switch_database" => {
            let a: SwitchDbArgs = args!(body);
            match m.switch_database(&a.id, &a.database).await {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e.to_string()),
            }
        }
        "test_connection_cmd" => {
            let a: ConfigArgs = args!(body);
            match m.test_connection(a.config).await {
                Ok(b) => ok(b),
                Err(e) => err(e.to_string()),
            }
        }
        "get_connection_status" => {
            let a: IdArgs = args!(body);
            match m.get_connection_status(&a.id).await {
                Ok(s) => ok(s),
                Err(e) => err(e.to_string()),
            }
        }
        "cancel_query" => {
            let a: IdArgs = args!(body);
            ok(m.cancel_query(&a.id).await)
        }
        "invalidate_metadata_cache" => {
            let a: IdArgs = args!(body);
            m.invalidate_metadata(&a.id).await;
            ok(Value::Null)
        }

        // --- Query execution ---
        "execute_query" => {
            let a: SqlArgs = args!(body);
            match m.query(&a.id, &a.sql).await {
                Ok(r) => ok(WireQueryResult::from(r)),
                Err(e) => err(e.to_string()),
            }
        }
        "execute_query_paged" => {
            let a: PagedArgs = args!(body);
            match m.query_paged(&a.id, &a.sql, a.limit, a.offset).await {
                Ok(r) => ok(WirePagedQueryResult::from(r)),
                Err(e) => err(e.to_string()),
            }
        }
        "execute_batch" => {
            let a: BatchArgs = args!(body);
            match m.execute_batch_json(&a.id, &a.statements).await {
                Ok(r) => ok(r),
                Err(e) => err(e),
            }
        }
        "execute_sql" => {
            let a: SqlArgs = args!(body);
            match m.execute(&a.id, &a.sql).await {
                Ok(r) => ok(r),
                Err(e) => err(e.to_string()),
            }
        }

        // --- Metadata ---
        "get_tables" => {
            let a: IdArgs = args!(body);
            match m.get_tables(&a.id).await {
                Ok(t) => ok(t),
                Err(e) => err(e.to_string()),
            }
        }
        "get_columns" => {
            let a: TableArgs = args!(body);
            match m.get_columns(&a.id, &a.table, a.schema.as_deref()).await {
                Ok(c) => ok(c),
                Err(e) => err(e.to_string()),
            }
        }
        "get_schemas" => {
            let a: IdArgs = args!(body);
            match m.get_schemas(&a.id).await {
                Ok(s) => ok(s),
                Err(e) => err(e.to_string()),
            }
        }
        "get_schemas_for_database" => {
            let a: DatabaseNameArgs = args!(body);
            match m.get_schemas_for_database(&a.id, &a.database_name).await {
                Ok(s) => ok(s),
                Err(e) => err(e.to_string()),
            }
        }
        "get_databases" => {
            let a: IdArgs = args!(body);
            match m.get_databases(&a.id).await {
                Ok(d) => ok(d),
                Err(e) => err(e.to_string()),
            }
        }
        "get_views" => {
            let a: SchemaOnlyArgs = args!(body);
            match m.get_views(&a.id, a.schema.as_deref()).await {
                Ok(v) => ok(v),
                Err(e) => err(e.to_string()),
            }
        }
        "get_indexes" => {
            let a: TableArgs = args!(body);
            match m.get_indexes(&a.id, &a.table, a.schema.as_deref()).await {
                Ok(i) => ok(i),
                Err(e) => err(e.to_string()),
            }
        }
        "get_foreign_keys" => {
            let a: TableArgs = args!(body);
            match m.get_foreign_keys(&a.id, &a.table, a.schema.as_deref()).await {
                Ok(f) => ok(f),
                Err(e) => err(e.to_string()),
            }
        }
        "get_table_row_count" => {
            let a: TableArgs = args!(body);
            match m.get_table_row_count(&a.id, &a.table, a.schema.as_deref()).await {
                Ok(c) => ok(c),
                Err(e) => err(e.to_string()),
            }
        }
        "get_table_data" => {
            let a: TableDataArgs = args!(body);
            match m
                .get_table_data(&a.id, &a.table, a.schema.as_deref(), a.page, a.page_size, a.order_by.as_deref())
                .await
            {
                Ok(r) => ok(WireQueryResult::from(r)),
                Err(e) => err(e.to_string()),
            }
        }
        "export_table_sql" => {
            let a: TableArgs = args!(body);
            match m.export_table_sql(&a.id, &a.table, a.schema.as_deref()).await {
                Ok(s) => ok(s),
                Err(e) => err(e.to_string()),
            }
        }
        "export_database" => {
            let a: ExportDbArgs = args!(body);
            match m.export_database(&a.id, a.tables.as_deref()).await {
                Ok(s) => ok(s),
                Err(e) => err(e.to_string()),
            }
        }

        // --- Row editing ---
        "update_table_rows" => {
            let a: UpdateRowsArgs = args!(body);
            match m
                .update_table_rows(&a.id, &a.table, a.schema.as_deref(), &a.updates, &a.where_conditions)
                .await
            {
                Ok(r) => ok(r),
                Err(e) => err(e.to_string()),
            }
        }
        "insert_table_row" => {
            let a: InsertRowArgs = args!(body);
            match m.insert_table_row(&a.id, &a.table, a.schema.as_deref(), &a.values).await {
                Ok(r) => ok(r),
                Err(e) => err(e.to_string()),
            }
        }
        "delete_table_rows" => {
            let a: DeleteRowsArgs = args!(body);
            match m
                .delete_table_rows(&a.id, &a.table, a.schema.as_deref(), &a.where_conditions)
                .await
            {
                Ok(r) => ok(r),
                Err(e) => err(e.to_string()),
            }
        }

        // --- Connection store (persisted profiles) ---
        "get_connections" => match state.store.get_all_connections() {
            Ok(c) => ok(c),
            Err(e) => err(e),
        },
        "add_connection" => {
            let a: ConnectionArg = args!(body);
            match state.store.create_connection(&a.connection) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e),
            }
        }
        "update_connection" => {
            let a: ConnectionArg = args!(body);
            match state.store.update_connection(&a.connection) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e),
            }
        }
        "delete_connection" => {
            let a: IdArgs = args!(body);
            match state.store.delete_connection(&a.id) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e),
            }
        }

        // --- AI settings & chat history (storage only; agent streaming is Phase 2) ---
        "save_ai_settings" => {
            let a: SettingsJsonArgs = args!(body);
            match state.store.save_ai_settings(&a.settings_json) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e),
            }
        }
        "load_ai_settings" => match state.store.load_ai_settings() {
            Ok(s) => ok(s),
            Err(e) => err(e),
        },
        "save_chat_message" => {
            let a: ChatSaveArgs = args!(body);
            match state.store.save_chat_message(&a.session_id, &a.role, &a.content) {
                Ok(id) => ok(id),
                Err(e) => err(e),
            }
        }
        "load_chat_history" => {
            let a: SessionArgs = args!(body);
            match state.store.load_chat_history(&a.session_id) {
                Ok(h) => ok(h),
                Err(e) => err(e),
            }
        }
        "clear_chat_history" => {
            let a: SessionArgs = args!(body);
            match state.store.clear_chat_history(&a.session_id) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e),
            }
        }

        other => err(format!("command '{}' is not available in web mode", other)),
    }
}
