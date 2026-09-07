use std::sync::Arc;
use tauri::State;

use super::manager::ConnectionManager;
use super::types::{
    ColumnInfo, ConnectResult, ConnectionCapabilities, ConnectionConfig, ConnectionStatus,
    ExecuteResult, TableInfo, WirePagedQueryResult, WireQueryResult,
};

// Re-export for use in command signatures
use serde_json;

/// Connect to a database
#[tauri::command]
pub async fn connect_to_database(
    state: State<'_, Arc<ConnectionManager>>,
    config: ConnectionConfig,
) -> Result<ConnectResult, String> {
    state
        .connect(config)
        .await
        .map_err(|e| e.to_string())
}

/// Disconnect from a database
#[tauri::command]
pub async fn disconnect_database(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<(), String> {
    state
        .disconnect(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Switch the active database for a MySQL/ClickHouse connection
#[tauri::command]
pub async fn switch_database(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    database: String,
) -> Result<(), String> {
    state
        .switch_database(&id, &database)
        .await
        .map_err(|e| e.to_string())
}

/// Execute a SQL query (SELECT) and return results
#[tauri::command]
pub async fn execute_query(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    sql: String,
) -> Result<WireQueryResult, String> {
    state
        .query(&id, &sql)
        .await
        .map(WireQueryResult::from)
        .map_err(|e| e.to_string())
}

/// Execute a paged SQL query with auto-LIMIT injection
#[tauri::command]
pub async fn execute_query_paged(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    sql: String,
    limit: u64,
    offset: u64,
) -> Result<WirePagedQueryResult, String> {
    state
        .query_paged(&id, &sql, limit, offset)
        .await
        .map(WirePagedQueryResult::from)
        .map_err(|e| e.to_string())
}

/// Execute a batch of SQL statements in a single IPC call.
/// Statements execute sequentially on the same connection; results preserve order.
#[tauri::command]
pub async fn execute_batch(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    statements: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    state.execute_batch_json(&id, &statements).await
}

/// Execute a SQL statement (INSERT, UPDATE, DELETE, DDL)
#[tauri::command]
pub async fn execute_script(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    execution_id: String,
    statements: Vec<String>,
    options: super::execution::ScriptOptions,
) -> Result<super::execution::ScriptOutcome, String> {
    state.execute_script(&format!("desktop:{}", window.label()), &execution_id, &id, &statements, &options)
        .await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn supports_script_sessions(state: State<'_, Arc<ConnectionManager>>, id: String) -> Result<bool, String> {
    state.supports_script_sessions(&id).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn transaction_request(window: tauri::WebviewWindow, state: State<'_, Arc<ConnectionManager>>, request: super::transactions::TransactionRequest) -> Result<super::transactions::TransactionResult, String> {
    state.transaction(&format!("desktop:{}", window.label()), request).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn insert_rows_bulk(window: tauri::WebviewWindow, state: State<'_, Arc<ConnectionManager>>, request: super::bulk::BulkRequest) -> Result<super::bulk::BulkOutcome, String> {
    state.insert_rows_bulk(&format!("desktop:{}", window.label()), &request).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_execution(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ConnectionManager>>,
    execution_id: String,
) -> bool {
    state.cancel_execution(&format!("desktop:{}", window.label()), &execution_id)
}

#[tauri::command]
pub fn acknowledge_execution(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ConnectionManager>>,
    execution_id: String,
    sequence: usize,
) -> bool {
    state.acknowledge_execution(&format!("desktop:{}", window.label()), &execution_id, sequence)
}

#[tauri::command]
pub async fn execute_script_stream(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ConnectionManager>>,
    request: super::execution::ScriptRequest,
    on_event: tauri::ipc::Channel<super::execution::ExecutionUpdate>,
) -> Result<super::execution::ScriptOutcome, String> {
    let owner = format!("desktop:{}", window.label());
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<super::execution::ExecutionDelivery>(1);
    let manager = state.inner();
    let execute = async {
        let outcome = manager.execute_script_progress(&owner, &request, Some(&sender)).await;
        drop(sender);
        outcome
    };
    let forward = async {
        let mut sequence = 0;
        while let Some(delivery) = receiver.recv().await {
            if !manager.expect_execution_ack(&owner, &request.execution_id, sequence, delivery.acknowledged)
                || on_event.send(delivery.update).is_err() {
                manager.cancel_execution(&owner, &request.execution_id);
                break;
            }
            sequence += 1;
        }
    };
    let (outcome, ()) = tokio::join!(execute, forward);
    outcome.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn execute_sql(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    sql: String,
) -> Result<ExecuteResult, String> {
    state
        .execute(&id, &sql)
        .await
        .map_err(|e| e.to_string())
}

/// Get all tables for a database connection
#[tauri::command]
pub async fn get_tables(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<Vec<TableInfo>, String> {
    state
        .get_tables(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Get columns for a specific table
#[tauri::command]
pub async fn get_columns(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
) -> Result<Vec<ColumnInfo>, String> {
    state
        .get_columns(&id, &table, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Get all schemas for a database connection
#[tauri::command]
pub async fn get_schemas(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<Vec<String>, String> {
    state
        .get_schemas(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Get schemas for a specific database (creates sub-connection to target database)
#[tauri::command]
pub async fn get_schemas_for_database(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    database_name: String,
) -> Result<Vec<String>, String> {
    state
        .get_schemas_for_database(&id, &database_name)
        .await
        .map_err(|e| e.to_string())
}

/// Get all databases for a connection (when no specific database is configured)
#[tauri::command]
pub async fn get_databases(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<Vec<String>, String> {
    state.get_databases(&id).await.map_err(|e| e.to_string())
}

/// Test a database connection
#[tauri::command]
pub async fn test_connection_cmd(
    state: State<'_, Arc<ConnectionManager>>,
    config: ConnectionConfig,
) -> Result<bool, String> {
    state
        .test_connection(config)
        .await
        .map_err(|e| e.to_string())
}

/// Export a single table as SQL
#[tauri::command]
pub async fn export_table_sql(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
) -> Result<String, String> {
    state
        .export_table_sql(&id, &table, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Export entire database as SQL script
#[tauri::command]
pub async fn export_database(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    tables: Option<Vec<String>>,
) -> Result<String, String> {
    state
        .export_database(&id, tables.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Get connection health status
#[tauri::command]
pub async fn get_connection_status(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<ConnectionStatus, String> {
    state
        .get_connection_status(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Get views for a connection
#[tauri::command]
pub async fn get_views(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    schema: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    state
        .get_views(&id, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Get indexes for a table
#[tauri::command]
pub async fn get_indexes(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    state
        .get_indexes(&id, &table, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Get foreign keys for a table
#[tauri::command]
pub async fn get_foreign_keys(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    state
        .get_foreign_keys(&id, &table, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Get table row count
#[tauri::command]
pub async fn get_table_row_count(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
) -> Result<u64, String> {
    state
        .get_table_row_count(&id, &table, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Update rows in a table
#[tauri::command]
pub async fn update_table_rows(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
    updates: Vec<(String, serde_json::Value)>,
    where_conditions: Vec<crate::db::types::WhereCondition>,
) -> Result<ExecuteResult, String> {
    state
        .update_table_rows(&id, &table, schema.as_deref(), &updates, &where_conditions)
        .await
        .map_err(|e| e.to_string())
}

/// Insert a row into a table
#[tauri::command]
pub async fn insert_table_row(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
    values: Vec<(String, serde_json::Value)>,
) -> Result<ExecuteResult, String> {
    state
        .insert_table_row(&id, &table, schema.as_deref(), &values)
        .await
        .map_err(|e| e.to_string())
}

/// Delete rows from a table
#[tauri::command]
pub async fn delete_table_rows(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
    where_conditions: Vec<crate::db::types::WhereCondition>,
) -> Result<ExecuteResult, String> {
    state
        .delete_table_rows(&id, &table, schema.as_deref(), &where_conditions)
        .await
        .map_err(|e| e.to_string())
}

/// Get table data with pagination
#[tauri::command]
pub async fn get_table_data(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    table: String,
    schema: Option<String>,
    page: u32,
    page_size: u32,
    order_by: Option<String>,
) -> Result<WireQueryResult, String> {
    state
        .get_table_data(&id, &table, schema.as_deref(), page, page_size, order_by.as_deref())
        .await
        .map(WireQueryResult::from)
        .map_err(|e| e.to_string())
}

/// Cancel a running query on the given connection
#[tauri::command]
pub async fn cancel_query(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<bool, String> {
    Ok(state.cancel_query(&id).await)
}

/// Drop cached schema metadata for a connection (sidebar refresh)
#[tauri::command]
pub async fn invalidate_metadata_cache(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<(), String> {
    state.invalidate_metadata(&id).await;
    Ok(())
}

/// Get driver capabilities for a connection
#[tauri::command]
pub async fn get_driver_capabilities(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<ConnectionCapabilities, String> {
    state.connection_capabilities(&id).await.map_err(|error| error.to_string())
}
