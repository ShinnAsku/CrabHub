use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::mpsc;

use super::client::AIClient;
use super::safety::{SafetyAction, SafetyGate};
use super::tools::get_tools;
use super::types::Message;

/// Events emitted during agent execution (sent to frontend via Tauri events).
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

/// Callback trait for executing agent tools against a live database.
/// The caller (Tauri command) injects ConnectionManager through this.
pub trait ToolExecutor: Send + Sync {
    fn execute(
        &self,
        tool_name: &str,
        params: &serde_json::Value,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>>;
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
    pub fn check_safety(tool_name: &str, params: &serde_json::Value) -> SafetyAction {
        if tool_name == "execute_sql" {
            let sql = params["sql"].as_str().unwrap_or("");
            SafetyGate::default().evaluate(sql)
        } else {
            SafetyAction::Allow
        }
    }

    /// Run the agent loop: LLM ↔ tool execution, emitting events via `tx`.
    pub async fn run(
        client: &AIClient,
        system_prompt: &str,
        user_message: &str,
        tx: mpsc::Sender<AgentEvent>,
        max_rounds: usize,
        executor: &dyn ToolExecutor,
    ) -> Result<(), String> {
        let tools = Self::tools_for_llm();
        let mut messages: Vec<Message> = vec![
            Message { role: "system".into(), content: system_prompt.into() },
            Message { role: "user".into(), content: user_message.into() },
        ];

        for _round in 0..max_rounds {
            let request = serde_json::json!({
                "model": client.model(),
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
                "temperature": 0.3,
            });

            let response_text = client
                .chat_raw(&request)
                .await
                .map_err(|e| format!("LLM call failed: {}", e))?;

            let response: serde_json::Value = serde_json::from_str(&response_text)
                .map_err(|e| format!("Invalid LLM response: {}", e))?;

            let choice = response["choices"][0].clone();
            let msg = choice["message"].clone();

            if let Some(tool_calls) = msg["tool_calls"].as_array() {
                if tool_calls.is_empty() {
                    let content = msg["content"].as_str().unwrap_or("");
                    let _ = tx.send(AgentEvent::FinalAnswer { content: content.into() }).await;
                    return Ok(());
                }

                messages.push(Message {
                    role: "assistant".into(),
                    content: msg["content"].as_str().unwrap_or("").into(),
                });

                for tc in tool_calls {
                    let fn_call = &tc["function"];
                    let tool_name = fn_call["name"].as_str().unwrap_or("");
                    let params: serde_json::Value =
                        serde_json::from_str(fn_call["arguments"].as_str().unwrap_or("{}"))
                            .unwrap_or(serde_json::Value::Null);

                    let _ = tx.send(AgentEvent::ToolCall {
                        name: tool_name.into(),
                        params: params.clone(),
                    }).await;

                    let safety = Self::check_safety(tool_name, &params);
                    if matches!(safety, SafetyAction::Deny { .. }) {
                        let _ = tx.send(AgentEvent::Error {
                            message: format!("Tool '{}' was denied by safety gate", tool_name),
                        }).await;
                        return Ok(());
                    }

                    // Execute tool via the injected executor
                    match executor.execute(tool_name, &params).await {
                        Ok(result) => {
                            let _ = tx.send(AgentEvent::ToolResult {
                                name: tool_name.into(),
                                success: true,
                                summary: truncate(&result, 200),
                            }).await;
                            messages.push(Message {
                                role: "tool".into(),
                                content: result,
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(AgentEvent::ToolResult {
                                name: tool_name.into(),
                                success: false,
                                summary: e.clone(),
                            }).await;
                            messages.push(Message {
                                role: "tool".into(),
                                content: format!("Error: {}", e),
                            });
                        }
                    }
                }
            } else {
                let content = msg["content"].as_str().unwrap_or("");
                let _ = tx.send(AgentEvent::FinalAnswer { content: content.into() }).await;
                return Ok(());
            }
        }

        let _ = tx.send(AgentEvent::Error {
            message: format!("Agent exceeded maximum rounds ({})", max_rounds),
        }).await;
        Ok(())
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len { s.into() } else { format!("{}...", &s[..max_len]) }
}
