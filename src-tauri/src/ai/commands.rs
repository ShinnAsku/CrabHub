use crate::ai::agent::AgentRuntime;
use crate::ai::client::AIClient;
use crate::ai::optimizer::SQLOptimizer;
use crate::ai::safety::SafetyGate;
use crate::ai::types::Message;

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

/// Format SQL query
#[tauri::command]
pub async fn format_sql(sql: String) -> Result<String, String> {
    // Simple formatting - can be enhanced with sqlformat crate
    let formatted = sql
        .lines()
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join("\n");
    
    Ok(formatted)
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
    const ALLOWED: &[&str] = &["deepseek", "qwen", "ollama", "openai"];
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
