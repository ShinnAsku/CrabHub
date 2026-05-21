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
