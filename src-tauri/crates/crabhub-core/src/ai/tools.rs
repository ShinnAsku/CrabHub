use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub enum DangerLevel {
    Safe,
    ReadOnly,
    Destructive,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value, // JSON Schema for function calling
    pub danger_level: DangerLevel,
}

/// Central registry of all tools the AI agent can use
pub fn get_tools() -> Vec<AgentToolDef> {
    vec![
        AgentToolDef {
            name: "get_schema_summary".into(),
            description: "获取数据库所有表名和类型列表".into(),
            parameters: serde_json::json!({"type":"object","properties":{},"required":[]}),
            danger_level: DangerLevel::Safe,
        },
        AgentToolDef {
            name: "get_table_info".into(),
            description: "获取指定表的列信息、数据类型、索引和外键".into(),
            parameters: serde_json::json!({
                "type":"object",
                "properties":{"table_name":{"type":"string","description":"表名"}},
                "required":["table_name"]
            }),
            danger_level: DangerLevel::Safe,
        },
        AgentToolDef {
            name: "execute_select".into(),
            description: "执行只读SELECT查询，自动添加LIMIT 500。用于查看数据。".into(),
            parameters: serde_json::json!({
                "type":"object",
                "properties":{"sql":{"type":"string","description":"SELECT查询语句"}},
                "required":["sql"]
            }),
            danger_level: DangerLevel::ReadOnly,
        },
        AgentToolDef {
            name: "explain_query".into(),
            description: "分析SQL执行计划，用于查询性能优化".into(),
            parameters: serde_json::json!({
                "type":"object",
                "properties":{"sql":{"type":"string","description":"要分析的SQL"}},
                "required":["sql"]
            }),
            danger_level: DangerLevel::Safe,
        },
        AgentToolDef {
            name: "execute_sql".into(),
            description: "执行DDL/DML语句（CREATE/ALTER/DROP/INSERT/UPDATE/DELETE）。执行前会征求用户确认。".into(),
            parameters: serde_json::json!({
                "type":"object",
                "properties":{
                    "sql":{"type":"string","description":"要执行的SQL"},
                    "reason":{"type":"string","description":"执行原因，向用户解释为什么需要执行"}
                },
                "required":["sql","reason"]
            }),
            danger_level: DangerLevel::Destructive,
        },
    ]
}
