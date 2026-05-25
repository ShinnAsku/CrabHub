use serde::Serialize;

use super::safety::{SafetyAction, SafetyGate};
use super::tools::get_tools;

/// Events emitted during agent execution (sent to frontend via Tauri events).
///
/// NOTE: Only `tools_for_llm` is currently wired into a Tauri command
/// (`ai::commands::get_agent_tools`). The richer agent runtime (event-emitting
/// tool dispatch + safety gating) is partially built — the helpers below stay
/// behind `#[allow(dead_code)]` until the frontend agent loop is implemented.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
#[allow(dead_code)]
pub enum AgentEvent {
    Thinking { content: String },
    ToolCall { name: String, params: serde_json::Value },
    ToolResult { name: String, success: bool, summary: String },
    NeedsConfirmation { sql: String, reason: String },
    FinalAnswer { content: String },
    Error { message: String },
}

pub struct AgentRuntime;

impl AgentRuntime {
    /// Convert tool definitions to OpenAI-compatible function calling format
    pub fn tools_for_llm() -> Vec<serde_json::Value> {
        get_tools()
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    }
                })
            })
            .collect()
    }

    /// Check if a tool call needs user confirmation.
    ///
    /// Reserved for the in-progress agent dispatch loop; presently unused.
    #[allow(dead_code)]
    pub fn check_safety(tool_name: &str, params: &serde_json::Value) -> SafetyAction {
        if tool_name == "execute_sql" {
            let sql = params["sql"].as_str().unwrap_or("");
            SafetyGate::default().evaluate(sql)
        } else {
            SafetyAction::Allow
        }
    }
}
