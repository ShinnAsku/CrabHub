use jsonrpsee::{core::RpcResult, proc_macros::rpc};
use serde_json;
use std::sync::Arc;

use crate::db::manager::ConnectionManager;
use crate::db::types::{ConnectionConfig, DatabaseType, DbError};
use crate::rpc::types::{PluginInfo, ConnectionResult};

fn rpc_error(error: DbError) -> jsonrpsee::types::ErrorObjectOwned {
    jsonrpsee::types::ErrorObjectOwned::owned(-32000, error.to_string(), Some(serde_json::json!({ "code": error.code() })))
}

fn rpc_value(value: impl serde::Serialize) -> RpcResult<serde_json::Value> {
    serde_json::to_value(value).map_err(|_| jsonrpsee::types::ErrorObjectOwned::owned(-32603, "Result serialization failed", None::<()>))
}

fn rpc_values(values: Vec<impl serde::Serialize>) -> RpcResult<Vec<serde_json::Value>> {
    values.into_iter().map(rpc_value).collect()
}

#[rpc(server)]
pub trait PluginRpc {
    #[method(name = "plugin_info")]
    async fn plugin_info(&self) -> RpcResult<PluginInfo>;
    #[method(name = "list_connections")]
    async fn list_connections(&self) -> RpcResult<Vec<serde_json::Value>>;
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
            driver_types: DatabaseType::BUILTIN.iter().map(|database| database.as_str().to_string()).collect(),
        })
    }

    async fn connect(&self, config: serde_json::Value) -> RpcResult<ConnectionResult> {
        let cfg: ConnectionConfig = serde_json::from_value(config).map_err(|e| jsonrpsee::types::error::ErrorObject::owned(-1, "Invalid config", Some(e.to_string())))?;
        match self.db_manager.connect(cfg).await {
            Ok(r) => Ok(ConnectionResult { success: true, connection_id: r.connection_id, message: None }),
            Err(error) => Err(rpc_error(error)),
        }
    }

    async fn list_connections(&self) -> RpcResult<Vec<serde_json::Value>> {
        Ok(self.db_manager.list_connections().await)
    }

    async fn disconnect(&self, id: String) -> RpcResult<bool> {
        self.db_manager.disconnect(&id).await.map(|()| true).map_err(rpc_error)
    }

    async fn execute_query(&self, cid: String, query: String) -> RpcResult<serde_json::Value> {
        rpc_value(self.db_manager.query(&cid, &query).await.map_err(rpc_error)?)
    }

    async fn execute_sql(&self, cid: String, sql: String) -> RpcResult<serde_json::Value> {
        rpc_value(self.db_manager.execute(&cid, &sql).await.map_err(rpc_error)?)
    }

    async fn list_tables(&self, cid: String) -> RpcResult<Vec<serde_json::Value>> {
        rpc_values(self.db_manager.get_tables(&cid).await.map_err(rpc_error)?)
    }

    async fn list_schemas(&self, cid: String) -> RpcResult<Vec<String>> {
        self.db_manager.get_schemas(&cid).await.map_err(rpc_error)
    }

    async fn get_columns(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        rpc_values(self.db_manager.get_columns(&cid, &table, schema.as_deref()).await.map_err(rpc_error)?)
    }

    async fn get_views(&self, cid: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        rpc_values(self.db_manager.get_views(&cid, schema.as_deref()).await.map_err(rpc_error)?)
    }

    async fn get_indexes(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        self.db_manager.get_indexes(&cid, &table, schema.as_deref()).await.map_err(rpc_error)
    }

    async fn get_foreign_keys(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<Vec<serde_json::Value>> {
        self.db_manager.get_foreign_keys(&cid, &table, schema.as_deref()).await.map_err(rpc_error)
    }

    async fn get_table_data(&self, cid: String, table: String, schema: Option<String>, page: u32, page_size: u32) -> RpcResult<serde_json::Value> {
        rpc_value(self.db_manager.get_table_data(&cid, &table, schema.as_deref(), page, page_size, None).await.map_err(rpc_error)?)
    }

    async fn export_table_sql(&self, cid: String, table: String, schema: Option<String>) -> RpcResult<String> {
        self.db_manager.export_table_sql(&cid, &table, schema.as_deref()).await.map_err(rpc_error)
    }
}

pub async fn start_rpc_server(db_manager: Arc<ConnectionManager>) -> anyhow::Result<()> {
    // `into_rpc()` registers every #[method] on the module. The previous
    // `RpcModule::new(server)` created an EMPTY module — the server ran but
    // exposed zero methods, so every call returned "method not found".
    let module = PluginRpcServerImpl::new(db_manager).into_rpc();
    let addr = "127.0.0.1:3030";
    let server = jsonrpsee::server::ServerBuilder::default().build(addr).await?;
    let handle = server.start(module);
    log::info!("RPC server started on {}", addr);
    handle.stopped().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rpc_failures_are_protocol_errors_instead_of_success_payloads() {
        let server = PluginRpcServerImpl::new(Arc::new(ConnectionManager::new()));
        let error = server.execute_query("missing".into(), "SELECT 1".into()).await.unwrap_err();
        assert_eq!(error.code(), -32000);
        assert!(server.list_schemas("missing".into()).await.is_err());
        assert!(server.list_tables("missing".into()).await.is_err());
        assert!(server.export_table_sql("missing".into(), "records".into(), None).await.is_err());
        assert!(server.disconnect("missing".into()).await.is_err());
        let info = server.plugin_info().await.unwrap();
        assert_eq!(info.driver_types.len(), 17);
        for database in ["oracle", "sqlserver", "dameng", "gbase"] {
            assert!(info.driver_types.iter().any(|driver| driver == database));
        }
    }
}
