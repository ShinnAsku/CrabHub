use crate::ai::agent::{AgentEvent, AgentRuntime};
use crate::ai::client::AIClient;
use crate::ai::context::ContextBuilder;
use crate::ai::optimizer::SQLOptimizer;
use crate::ai::safety::SafetyGate;
use crate::ai::types::Message;
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
pub struct ChatResponse {
    content: String,
}

#[derive(Clone, serde::Serialize)]
pub struct OptimizationResult {
    suggestions: Vec<crate::ai::types::OptimizationSuggestion>,
    index_suggestions: Vec<crate::ai::types::IndexSuggestion>,
    rewritten_query: Option<String>,
}

/// Test AI provider connection by sending a minimal ping message.
#[tauri::command]
pub async fn test_ai_connection(
    provider: String,
    endpoint: String,
    api_key: String,
    model: String,
) -> Result<String, String> {
    let client = AIClient::new(&provider, &endpoint, &api_key, &model)
        .map_err(|e| format!("Failed to create AI client: {}", e))?;
    let messages = vec![Message {
        role: "user".to_string(),
        content: "ping".to_string(),
    }];
    let content = client.chat(&messages).await
        .map_err(|e| format!("Connection failed: {}", e))?;
    Ok(content)
}

/// Chat with AI assistant (non-streaming)
#[tauri::command]
pub async fn ai_chat(
    provider: String,
    endpoint: String,
    api_key: String,
    model: String,
    messages: Vec<Message>,
) -> Result<ChatResponse, String> {
    let client = AIClient::new(&provider, &endpoint, &api_key, &model)
        .map_err(|e| format!("Failed to create AI client: {}", e))?;

    let content = client
        .chat(&messages)
        .await
        .map_err(|e| format!("AI chat failed: {}", e))?;

    Ok(ChatResponse { content })
}

/// Analyze SQL query for optimization opportunities
#[tauri::command]
pub async fn analyze_sql(
    sql: String,
    table_name: Option<String>,
) -> Result<OptimizationResult, String> {
    let suggestions = SQLOptimizer::analyze(&sql);
    let index_suggestions = SQLOptimizer::suggest_indexes(&sql, table_name.as_deref());
    let rewritten_query = SQLOptimizer::rewrite_query(&sql).ok();

    Ok(OptimizationResult {
        suggestions,
        index_suggestions,
        rewritten_query,
    })
}

/// Format SQL query using sqlformat crate.
#[tauri::command]
pub async fn format_sql(sql: String) -> Result<String, String> {
    Ok(sqlformat::format(&sql, &sqlformat::QueryParams::default(), &sqlformat::FormatOptions::default()))
}

/// Get the agent tools definitions (for frontend to configure LLM function calling)
#[tauri::command]
pub async fn get_agent_tools() -> Result<Vec<serde_json::Value>, String> {
    Ok(AgentRuntime::tools_for_llm())
}

/// Check if a SQL operation needs user confirmation
#[tauri::command]
pub async fn check_sql_safety(sql: String) -> Result<serde_json::Value, String> {
    let action = SafetyGate::default().evaluate(&sql);
    serde_json::to_value(action).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// AI API-key storage (system keyring)
// ---------------------------------------------------------------------------
//
// Keys are persisted in the OS keyring (libsecret / Keychain / Credential Manager)
// under service `crabhub` and account `ai-<provider>`. Providers are validated
// against a fixed allow-list so a malicious caller cannot use the command to
// probe / overwrite arbitrary keyring entries.

fn ai_keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    const ALLOWED: &[&str] = &["deepseek", "qwen", "ollama", "openai", "custom"];
    if !ALLOWED.contains(&provider) {
        return Err(format!("Unsupported AI provider: {}", provider));
    }
    keyring::Entry::new("crabhub", &format!("ai-{}", provider)).map_err(|e| e.to_string())
}

/// Store an AI provider API key in the system keyring.
/// Pass an empty string to delete the entry.
#[tauri::command]
pub async fn set_ai_api_key(provider: String, key: String) -> Result<(), String> {
    let entry = ai_keyring_entry(&provider)?;
    if key.is_empty() {
        // Best-effort delete; ignore "not found" errors.
        let _ = entry.delete_password();
        Ok(())
    } else {
        entry.set_password(&key).map_err(|e| e.to_string())
    }
}

/// Fetch an AI provider API key from the system keyring.
/// Returns an empty string when no entry exists (so callers don't have to
/// distinguish "missing" from "error" for first-run setup).
#[tauri::command]
pub async fn get_ai_api_key(provider: String) -> Result<String, String> {
    let entry = ai_keyring_entry(&provider)?;
    match entry.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove an AI provider API key from the system keyring.
#[tauri::command]
pub async fn delete_ai_api_key(provider: String) -> Result<(), String> {
    let entry = ai_keyring_entry(&provider)?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Run the AI agent asynchronously, emitting AgentEvents via Tauri events.
/// The frontend listens for `agent-event` to receive streaming progress.
#[tauri::command]
pub async fn agent_chat(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::db::manager::ConnectionManager>>,
    provider: String,
    endpoint: String,
    api_key: String,
    model: String,
    db_type: String,
    connection_id: Option<String>,
    schema_summary: String,
    user_message: String,
) -> Result<(), String> {
    let client = AIClient::new(&provider, &endpoint, &api_key, &model)
        .map_err(|e| format!("Failed to create AI client: {}", e))?;

    let system_prompt = ContextBuilder::build_system_prompt(&db_type, 0, &schema_summary);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(32);

    // Build tool executor from ConnectionManager
    let manager = state.inner().clone();
    let executor = AgentToolExecutor {
        manager,
        connection_id: connection_id.unwrap_or_default(),
    };

    // Spawn the agent loop
    let handle = app_handle.clone();
    let agent_task = tokio::spawn(async move {
        if let Err(e) = AgentRuntime::run(&client, &system_prompt, &user_message, tx, 10, &executor).await {
            let _ = handle.emit("agent-event", AgentEvent::Error { message: e });
        }
    });

    // Forward events from the agent to the frontend
    while let Some(event) = rx.recv().await {
        app_handle.emit("agent-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    // Check for agent panic
    if let Err(e) = agent_task.await {
        log::error!("Agent task panicked: {:?}", e);
    }

    Ok(())
}

/// Implements ToolExecutor by delegating to ConnectionManager.
struct AgentToolExecutor {
    manager: std::sync::Arc<crate::db::manager::ConnectionManager>,
    connection_id: String,
}

impl crate::ai::agent::ToolExecutor for AgentToolExecutor {
    fn execute(
        &self,
        tool_name: &str,
        params: &serde_json::Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>> {
        let mgr = self.manager.clone();
        let cid = self.connection_id.clone();
        let name = tool_name.to_string();
        let p = params.clone();
        Box::pin(async move {
            match name.as_str() {
                "get_schema_summary" => {
                    let tables = mgr.get_tables(&cid).await.map_err(|e| e.to_string())?;
                    let schemas = mgr.get_schemas(&cid).await.map_err(|e| e.to_string())?;
                    Ok(format!("Schemas: {:?}\nTables ({}): {:?}", schemas, tables.len(),
                        tables.iter().map(|t| format!("{}.{} ({})", t.schema.as_deref().unwrap_or(""), t.name, t.table_type))
                            .collect::<Vec<_>>()))
                }
                "get_table_info" => {
                    let table = p["table_name"].as_str().unwrap_or("");
                    let schema = p["schema"].as_str();
                    let cols = mgr.get_columns(&cid, table, schema).await.map_err(|e| e.to_string())?;
                    let indexes = mgr.get_indexes(&cid, table, schema).await.map_err(|e| e.to_string())?;
                    let fks = mgr.get_foreign_keys(&cid, table, schema).await.map_err(|e| e.to_string())?;
                    let count = mgr.get_table_row_count(&cid, table, schema).await.unwrap_or(0);
                    Ok(format!("Table: {}\nRow count: {}\nColumns: {:?}\nIndexes: {:?}\nForeign keys: {:?}",
                        table, count, cols, indexes, fks))
                }
                "execute_select" => {
                    let sql = p["sql"].as_str().unwrap_or("");
                    let safe_sql = if crate::db::sql_limiter::has_user_limit(sql) {
                        sql.to_string()
                    } else {
                        format!("{} LIMIT 500", sql)
                    };
                    let result = mgr.query(&cid, &safe_sql).await.map_err(|e| e.to_string())?;
                    Ok(format!("{} rows returned\nColumns: {:?}\nFirst rows: {:?}",
                        result.row_count,
                        result.columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
                        &result.rows[..std::cmp::min(result.rows.len(), 10)]))
                }
                "explain_query" => {
                    let sql = p["sql"].as_str().unwrap_or("");
                    // GaussDB with explain_perf_mode=on requires FORMAT TEXT.
                    // PostgreSQL and PG-compatible databases accept it universally.
                    let explain_prefix = match mgr.get_db_type(&cid).await {
                        Some(crate::db::types::DatabaseType::GaussDB) => "EXPLAIN (FORMAT TEXT)",
                        _ => "EXPLAIN",
                    };
                    let explain_sql = format!("{} {}", explain_prefix, sql);
                    let result = mgr.query(&cid, &explain_sql).await.map_err(|e| e.to_string())?;
                    Ok(format!("{}", result.rows.iter()
                        .map(|r| format!("{:?}", r))
                        .collect::<Vec<_>>()
                        .join("\n")))
                }
                "execute_sql" => {
                    let sql = p["sql"].as_str().unwrap_or("");
                    let result = mgr.execute(&cid, sql).await.map_err(|e| e.to_string())?;
                    Ok(format!("{} rows affected", result.rows_affected))
                }
                _ => Err(format!("Unknown tool: {}", name)),
            }
        })
    }
}
