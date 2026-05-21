use serde::Serialize;

use super::context::ContextBuilder;
use super::safety::{SafetyAction, SafetyGate};
use super::tools::get_tools;

/// Events emitted during agent execution (sent to frontend via Tauri events)
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
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
    /// Build a complete system prompt for the agent
    pub fn build_system_prompt(db_type: &str, schema_summary: &str) -> String {
        ContextBuilder::build_system_prompt(db_type, 0, schema_summary)
    }

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

    /// Check if a tool call needs user confirmation
    pub fn check_safety(tool_name: &str, params: &serde_json::Value) -> SafetyAction {
        if tool_name == "execute_sql" {
            let sql = params["sql"].as_str().unwrap_or("");
            SafetyGate::default().evaluate(sql)
        } else {
            SafetyAction::Allow
        }
    }
}
