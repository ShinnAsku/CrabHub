use std::sync::Arc;
use tauri::State;

use super::manager::ConnectionManager;
use super::types::{
    ColumnInfo, ConnectResult, ConnectionConfig, ConnectionStatus, DatabaseType, ExecuteResult,
    PagedQueryResult, QueryResult, TableInfo,
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

/// Execute a SQL query (SELECT) and return results
#[tauri::command]
pub async fn execute_query(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
    sql: String,
) -> Result<QueryResult, String> {
    state
        .query(&id, &sql)
        .await
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
) -> Result<PagedQueryResult, String> {
    state
        .query_paged(&id, &sql, limit, offset)
        .await
        .map_err(|e| e.to_string())
}

/// Execute a SQL statement (INSERT, UPDATE, DELETE, DDL)
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

/// Get all databases for a connection (when no specific database is configured)
#[tauri::command]
pub async fn get_databases(
    state: State<'_, Arc<ConnectionManager>>,
    id: String,
) -> Result<Vec<String>, String> {
    let sql = match state.get_db_type(&id).await {
        Some(t) => match t {
            DatabaseType::MySQL => "SHOW DATABASES".to_string(),
            _ => "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname".to_string(),
        },
        None => "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname".to_string(),
    };
    let result = state.query(&id, &sql).await.map_err(|e| e.to_string())?;
    Ok(result.rows.iter()
        .filter_map(|row| row.values().next().and_then(|v| v.as_str().map(|s| s.to_string())))
        .collect())
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
    where_clause: String,
) -> Result<ExecuteResult, String> {
    state
        .update_table_rows(&id, &table, schema.as_deref(), &updates, &where_clause)
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
    where_clause: String,
) -> Result<ExecuteResult, String> {
    state
        .delete_table_rows(&id, &table, schema.as_deref(), &where_clause)
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
) -> Result<QueryResult, String> {
    state
        .get_table_data(&id, &table, schema.as_deref(), page, page_size, order_by.as_deref())
        .await
        .map_err(|e| e.to_string())
}
