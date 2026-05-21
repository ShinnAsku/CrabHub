use async_trait::async_trait;

use super::dialect::DialectConfig;
use super::pg_compatible::PgCompatibleConnection;
use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

// ============================================================================
// GaussDB Connection — thin wrapper over PgCompatibleConnection
// ============================================================================

pub struct GaussDBConnection {
    inner: PgCompatibleConnection,
}

impl GaussDBConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let dialect = DialectConfig::gaussdb();
        let inner = PgCompatibleConnection::new(config, dialect).await?;
        Ok(Self { inner })
    }
}

#[async_trait]
impl DatabaseConnection for GaussDBConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        self.inner.execute_sql(sql).await
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        self.inner.query_sql(sql).await
    }

    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        self.inner.query_sql_paged(sql, limit, offset).await
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::GaussDB
    }

    async fn close(&self) {
        self.inner.close().await;
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        self.inner.get_tables().await
    }

    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        self.inner.get_columns(table, schema).await
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        self.inner.get_schemas().await
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        self.inner.export_table_sql(table, schema).await
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        self.inner.get_views(schema).await
    }

    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        self.inner.get_indexes(table, schema).await
    }

    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        self.inner.get_foreign_keys(table, schema).await
    }

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        self.inner.get_table_row_count(table, schema).await
    }

    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        self.inner
            .get_table_data(table, schema, page, page_size, order_by)
            .await
    }

    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        self.inner
            .update_table_rows(table, schema, updates, where_clause)
            .await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        self.inner
            .insert_table_row(table, schema, values)
            .await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        self.inner
            .delete_table_rows(table, schema, where_clause)
            .await
    }
}
