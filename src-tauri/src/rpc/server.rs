use jsonrpsee::{core::RpcResult, proc_macros::rpc, RpcModule};
use serde_json;
use std::sync::Arc;

use crate::db::manager::ConnectionManager;
use crate::db::types::ConnectionConfig;
use crate::rpc::types::{PluginInfo, ConnectionResult};

#[rpc(server)]
pub trait PluginRpc {
    #[method(name = "plugin_info")]
    async fn plugin_info(&self) -> RpcResult<PluginInfo>;
    #[method(name = "connect")]
    async fn connect(&self, config: serde_json::Value) -> RpcResult<ConnectionResult>;
    #[method(name = "disconnect")]
    async fn disconnect(&self, connection_id: String) -> RpcResult<bool>;
    #[method(name = "execute_query")]
    async fn execute_query(&self, connection_id: String, query: String) -> RpcResult<serde_json::Value>;
    #[method(name = "execute_sql")]
    async fn execute_sql(&self, connection_id: String, sql: String) -> RpcResult<serde_json::Value>;
    #[method(name = "list_tables")]
    async fn list_tables(&self, connection_id: String) -> RpcResult<Vec<serde_json::Value>>;
    #[method(name = "list_schemas")]
    async fn list_schemas(&self, connection_id: String) -> RpcResult<Vec<String>>;
    #[method(name = "get_columns")]
    async fn get_columns(&self, connection_id: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>>;
    #[method(name = "get_views")]
    async fn get_views(&self, connection_id: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>>;
    #[method(name = "get_indexes")]
    async fn get_indexes(&self, connection_id: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>>;
    #[method(name = "get_foreign_keys")]
    async fn get_foreign_keys(&self, connection_id: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>>;
    #[method(name = "get_table_data")]
    async fn get_table_data(&self, connection_id: String, table: String, schema: Option<String>, page: u32, page_size: u32) -> RpcResult<serde_json::Value>;
    #[method(name = "export_table_sql")]
    async fn export_table_sql(&self, connection_id: String, table: String, schema: Option<String>) -> RpcResult<String>;
}

pub struct PluginRpcServerImpl {
    db_manager: Arc<ConnectionManager>,
}

impl PluginRpcServerImpl {
    pub fn new(db_manager: Arc<ConnectionManager>) -> Self { Self { db_manager } }
}

#[async_trait::async_trait]
impl PluginRpcServer for PluginRpcServerImpl {
    async fn plugin_info(&self) -> RpcResult<PluginInfo> {
        Ok(PluginInfo {
            name: "crabhub-core".into(), version: env!("CARGO_PKG_VERSION").into(),
            description: "CrabHub core".into(),
            driver_types: vec!["postgres".into(),"mysql".into(),"sqlite".into(),"gaussdb".into(),"clickhouse".into(),"kingbase".into(),"vastbase".into(),"yashandb".into(),"oceanbase".into(),"tidb".into(),"tdsql".into()],
        })
    }

    async fn connect(&self, config: serde_json::Value) -> RpcResult<ConnectionResult> {
        let cfg: ConnectionConfig = serde_json::from_value(config).map_err(|e| jsonrpsee::types::error::ErrorObject::owned(-1, "Invalid config", Some(e.to_string())))?;
        match self.db_manager.connect(cfg).await {
            Ok(r) => Ok(ConnectionResult { success: true, connection_id: r.connection_id, message: None }),
            Err(e) => Ok(ConnectionResult { success: false, connection_id: String::new(), message: Some(e.to_string()) }),
        }
    }

    async fn disconnect(&self, id: String) -> RpcResult<bool> {
        Ok(self.db_manager.disconnect(&id).await.is_ok())
    }

    async fn execute_query(&self, cid: String, query: String) -> RpcResult<serde_json::Value> {
        match self.db_manager.query(&cid, &query).await {
            Ok(r) => Ok(serde_json::to_value(r).unwrap_or(serde_json::json!({"error":"serialization"}))),
            Err(e) => Ok(serde_json::json!({"success":false,"error":e.to_string()})),
        }
    }

    async fn execute_sql(&self, cid: String, sql: String) -> RpcResult<serde_json::Value> {
        match self.db_manager.execute(&cid, &sql).await {
            Ok(r) => Ok(serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Ok(serde_json::json!({"success":false,"error":e.to_string()})),
        }
    }

    async fn list_tables(&self, cid: String) -> RpcResult<Vec<serde_json::Value>> {
        match self.db_manager.get_tables(&cid).await {
            Ok(t) => Ok(t.into_iter().map(|v| serde_json::to_value(v).unwrap_or_default()).collect()),
            Err(e) => Ok(vec![serde_json::json!({"error":e.to_string()})]),
        }
    }

    async fn list_schemas(&self, cid: String) -> RpcResult<Vec<String>> {
        match self.db_manager.get_schemas(&cid).await {
            Ok(s) => Ok(s),
            Err(e) => Ok(vec![format!("error:{}",e)]),
        }
    }

    async fn get_columns(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        match self.db_manager.get_columns(&cid, &table, schema.as_deref()).await {
            Ok(c) => Ok(c.into_iter().map(|v| serde_json::to_value(v).unwrap_or_default()).collect()),
            Err(e) => Ok(vec![serde_json::json!({"error":e.to_string()})]),
        }
    }

    async fn get_views(&self, cid: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        match self.db_manager.get_views(&cid, schema.as_deref()).await {
            Ok(v) => Ok(v.into_iter().map(|x| serde_json::to_value(x).unwrap_or_default()).collect()),
            Err(e) => Ok(vec![serde_json::json!({"error":e.to_string()})]),
        }
    }

    async fn get_indexes(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        match self.db_manager.get_indexes(&cid, &table, schema.as_deref()).await {
            Ok(i) => Ok(i),
            Err(e) => Ok(vec![serde_json::json!({"error":e.to_string()})]),
        }
    }

    async fn get_foreign_keys(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        match self.db_manager.get_foreign_keys(&cid, &table, schema.as_deref()).await {
            Ok(f) => Ok(f),
            Err(e) => Ok(vec![serde_json::json!({"error":e.to_string()})]),
        }
    }

    async fn get_table_data(&self, cid: String, table: String, schema: Option<String>, page: u32, page_size: u32) -> RpcResult<serde_json::Value> {
        match self.db_manager.get_table_data(&cid, &table, schema.as_deref(), page, page_size, None).await {
            Ok(d) => Ok(serde_json::to_value(d).unwrap_or_default()),
            Err(e) => Ok(serde_json::json!({"error":e.to_string()})),
        }
    }

    async fn export_table_sql(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<String> {
        match self.db_manager.export_table_sql(&cid, &table, schema.as_deref()).await {
            Ok(sql) => Ok(sql),
            Err(e) => Ok(format!("-- error: {}", e)),
        }
    }
}

pub async fn start_rpc_server(db_manager: Arc<ConnectionManager>) -> anyhow::Result<()> {
    let server = PluginRpcServerImpl::new(db_manager);
    let module = RpcModule::new(server);
    let addr = "127.0.0.1:3030";
    let server = jsonrpsee::server::ServerBuilder::default().build(addr).await?;
    let handle = server.start(module);
    log::info!("RPC server started on {}", addr);
    handle.stopped().await;
    Ok(())
}
