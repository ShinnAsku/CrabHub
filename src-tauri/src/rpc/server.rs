use jsonrpsee::{core::RpcResult, proc_macros::rpc, RpcModule};
use serde_json;
use std::sync::Arc;

use crate::db::manager::ConnectionManager;
use crate::rpc::types::{PluginInfo, ConnectionResult};

#[rpc(server)]
pub trait PluginRpc {
    #[method(name = "plugin_info")]
    async fn plugin_info(&self) -> RpcResult<PluginInfo>;
    
    #[method(name = "connect")]
    async fn connect(&self, config: serde_json::Value) -> RpcResult<ConnectionResult>;
    
    #[method(name = "execute_query")]
    async fn execute_query(&self, connection_id: String, query: String) -> RpcResult<serde_json::Value>;
    
    #[method(name = "list_tables")]
    async fn list_tables(&self, connection_id: String) -> RpcResult<Vec<serde_json::Value>>;
    
    #[method(name = "list_schemas")]
    async fn list_schemas(&self, connection_id: String) -> RpcResult<Vec<String>>;
}

pub struct PluginRpcServerImpl {
    db_manager: Arc<ConnectionManager>,
}

impl PluginRpcServerImpl {
    pub fn new(db_manager: Arc<ConnectionManager>) -> Self {
        Self {
            db_manager,
        }
    }
}

#[async_trait::async_trait]
impl PluginRpcServer for PluginRpcServerImpl {
    async fn plugin_info(&self) -> RpcResult<PluginInfo> {
        Ok(PluginInfo {
            name: "opendb-core".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            description: "OpenDB core plugin".to_string(),
            driver_types: vec![
                "postgres".to_string(),
                "mysql".to_string(),
                "sqlite".to_string(),
                "mssql".to_string(),
                "gaussdb".to_string(),
                "clickhouse".to_string(),
            ],
        })
    }

    async fn connect(&self, _config: serde_json::Value) -> RpcResult<ConnectionResult> {
        Ok(ConnectionResult {
            success: true,
            connection_id: "test-connection".to_string(),
            message: None,
        })
    }

    async fn execute_query(&self, _connection_id: String, query: String) -> RpcResult<serde_json::Value> {
        Ok(serde_json::json!({
            "success": true,
            "query": query,
            "rows": []
        }))
    }

    async fn list_tables(&self, _connection_id: String) -> RpcResult<Vec<serde_json::Value>> {
        Ok(vec![])
    }

    async fn list_schemas(&self, _connection_id: String) -> RpcResult<Vec<String>> {
        Ok(vec![])
    }
}

pub async fn start_rpc_server(db_manager: Arc<ConnectionManager>) -> anyhow::Result<()> {
    let server = PluginRpcServerImpl::new(db_manager);
    let module = RpcModule::new(server);
    
    let addr = "127.0.0.1:3030";
    let server = jsonrpsee::server::ServerBuilder::default()
        .build(addr).await?;
    
    let handle = server.start(module);
    log::info!("RPC server started on {}", addr);
    
    handle.stopped().await;
    Ok(())
}
