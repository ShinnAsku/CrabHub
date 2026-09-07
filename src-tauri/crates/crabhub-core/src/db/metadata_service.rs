
use super::metadata_cache::CachedMeta;
use super::types::{
    ColumnInfo, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};


use super::manager::ConnectionManager;

pub(super) async fn get_databases(manager: &ConnectionManager, id: &str) -> Result<Vec<String>, DbError> {
    {
        let entry = manager.entry(id).await?;
        let connection = entry.connection.read().await;
        if let Some(names) = connection.database_names().await? { return Ok(names); }
    }
    const PG_SQL: &str = "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname";
    let sql = match manager.get_db_type(id).await {
        Some(DatabaseType::MySQL)
        | Some(DatabaseType::OceanBase | DatabaseType::TiDB | DatabaseType::TDSQL) => {
            "SHOW DATABASES".to_string()
        }
        Some(DatabaseType::SQLite) => return Ok(vec!["main".to_string()]),
        // NoSQL engines expose their database list via get_schemas
        Some(DatabaseType::Redis | DatabaseType::MongoDB) => {
            return manager.get_schemas(id).await;
        }
        Some(DatabaseType::ClickHouse) => {
            "SELECT name FROM system.databases ORDER BY name".to_string()
        }
        Some(DatabaseType::Oracle | DatabaseType::DaMeng | DatabaseType::GBase) => {
            "SELECT name FROM v$database".to_string()
        }
        Some(DatabaseType::SQLServer) => {
            "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name".to_string()
        }
        _ => PG_SQL.to_string(),
    };
    let result = manager.query_metadata(id, &sql).await?;
    Ok(result
        .rows
        .iter()
        .filter_map(|row| row.values().next().and_then(|v| v.as_str().map(|s| s.to_string())))
        .collect())
}

pub(super) async fn get_tables(manager: &ConnectionManager, id: &str) -> Result<Vec<TableInfo>, DbError> {
    let key = format!("{}\x00tables", id);
    if let Some(CachedMeta::Tables(t)) = manager.meta_get(&key).await {
        return Ok(t);
    }
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    let tables = connection.get_tables().await?;
    manager.meta_put(key, CachedMeta::Tables(tables.clone())).await;
    Ok(tables)
}

pub(super) async fn get_columns(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
) -> Result<Vec<ColumnInfo>, DbError> {
    let key = format!("{}\x00columns\x00{}\x00{}", id, schema.unwrap_or(""), table);
    if let Some(CachedMeta::Columns(c)) = manager.meta_get(&key).await {
        return Ok(c);
    }
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    let columns = connection.get_columns(table, schema).await?;
    manager.meta_put(key, CachedMeta::Columns(columns.clone())).await;
    Ok(columns)
}

pub(super) async fn get_schemas(manager: &ConnectionManager, id: &str) -> Result<Vec<String>, DbError> {
    let key = format!("{}\x00schemas", id);
    if let Some(CachedMeta::Schemas(s)) = manager.meta_get(&key).await {
        return Ok(s);
    }
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    let schemas = connection.get_schemas().await?;
    manager.meta_put(key, CachedMeta::Schemas(schemas.clone())).await;
    Ok(schemas)
}

pub(super) async fn export_table_sql(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
) -> Result<String, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection.export_table_sql(table, schema).await
}

pub(super) async fn export_database(
    manager: &ConnectionManager,
    id: &str,
    tables: Option<&[String]>,
) -> Result<String, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;

    let all_tables = connection.get_tables().await?;
    let tables_to_export: Vec<TableInfo> = match tables {
        Some(filter) => all_tables
            .into_iter()
            .filter(|t| filter.contains(&t.name))
            .collect(),
        None => all_tables,
    };

    let mut sql_parts = Vec::new();
    for table in &tables_to_export {
        let table_sql = connection
            .export_table_sql(&table.name, table.schema.as_deref())
            .await?;
        sql_parts.push(table_sql);
    }

    Ok(format!(
        "-- CrabHub Database Export\n-- Generated at: {}\n-- Tables: {}\n\n{}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
        tables_to_export.len(),
        sql_parts.join("\n")
    ))
}

pub(super) async fn get_views(
    manager: &ConnectionManager,
    id: &str,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection.get_views(schema).await
}

pub(super) async fn get_indexes(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
) -> Result<Vec<serde_json::Value>, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection.get_indexes(table, schema).await
}

pub(super) async fn get_foreign_keys(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
) -> Result<Vec<serde_json::Value>, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection.get_foreign_keys(table, schema).await
}

pub(super) async fn get_table_row_count(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
) -> Result<u64, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection.get_table_row_count(table, schema).await
}

pub(super) async fn update_table_rows(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
    updates: &[(String, serde_json::Value)],
    where_conditions: &[crate::db::types::WhereCondition],
) -> Result<ExecuteResult, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection
        .update_table_rows(table, schema, updates, where_conditions)
        .await
}

pub(super) async fn insert_table_row(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
    values: &[(String, serde_json::Value)],
) -> Result<ExecuteResult, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection
        .insert_table_row(table, schema, values)
        .await
}

pub(super) async fn delete_table_rows(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
    where_conditions: &[crate::db::types::WhereCondition],
) -> Result<ExecuteResult, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection
        .delete_table_rows(table, schema, where_conditions)
        .await
}

pub(super) async fn get_table_data(
    manager: &ConnectionManager,
    id: &str,
    table: &str,
    schema: Option<&str>,
    page: u32,
    page_size: u32,
    order_by: Option<&str>,
) -> Result<QueryResult, DbError> {
    let entry = manager.entry(id).await?;
    let connection = entry.connection.read().await;
    connection
        .get_table_data(table, schema, page, page_size, order_by)
        .await
}
