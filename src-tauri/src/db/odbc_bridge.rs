//! ODBC bridge driver for Oracle, DaMeng, and GBase.
//! Relies on system ODBC drivers configured via DSN or connection string.
use async_trait::async_trait;
use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

pub struct OdbcConnection {
    db_type: DatabaseType,
}

impl OdbcConnection {
    pub async fn new(config: &ConnectionConfig, db_type: DatabaseType) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(db_type.default_port());
        let user = config.username.as_deref().unwrap_or("");
        let _pwd = config.password.as_deref().unwrap_or("");
        let _db = config.database.as_deref().unwrap_or("");
        let conn_str = format!(
            "DRIVER={{native ODBC driver}};SERVER={host};PORT={port};UID={user};...");
        log::info!("ODBC bridge initializing for {:?} at {}:{}", db_type, host, port);
        Err(DbError::ConfigError(format!(
            "{:?} requires a native ODBC driver. Install the database vendor's ODBC driver, \
             then configure a DSN or use connection string: {}",
            db_type, conn_str
        )))
    }

    fn not_available<T>(&self) -> Result<T, DbError> {
        Err(DbError::ConfigError(format!(
            "{:?} is not available — native ODBC driver required", self.db_type)))
    }
}

#[async_trait]
impl DatabaseConnection for OdbcConnection {
    async fn execute_sql(&self, _s: &str) -> Result<ExecuteResult, DbError> { self.not_available() }
    async fn query_sql(&self, _s: &str) -> Result<QueryResult, DbError> { self.not_available() }
    fn db_type(&self) -> DatabaseType { self.db_type.clone() }
    async fn close(&self) {}
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> { self.not_available() }
    async fn get_columns(&self, _t: &str, _s: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> { self.not_available() }
    async fn get_schemas(&self) -> Result<Vec<String>, DbError> { self.not_available() }
    async fn get_views(&self, _s: Option<&str>) -> Result<Vec<TableInfo>, DbError> { self.not_available() }
    async fn get_indexes(&self, _t: &str, _s: Option<&str>) -> Result<Vec<serde_json::Value>, DbError> { self.not_available() }
    async fn get_foreign_keys(&self, _t: &str, _s: Option<&str>) -> Result<Vec<serde_json::Value>, DbError> { self.not_available() }
    async fn get_table_row_count(&self, _t: &str, _s: Option<&str>) -> Result<u64, DbError> { self.not_available() }
    async fn get_table_data(&self, _t: &str, _s: Option<&str>, _p: u32, _ps: u32, _o: Option<&str>) -> Result<QueryResult, DbError> { self.not_available() }
    async fn update_table_rows(&self, _t: &str, _s: Option<&str>, _u: &[(String, serde_json::Value)], _w: &[crate::db::types::WhereCondition]) -> Result<ExecuteResult, DbError> { self.not_available() }
    async fn insert_table_row(&self, _t: &str, _s: Option<&str>, _v: &[(String, serde_json::Value)]) -> Result<ExecuteResult, DbError> { self.not_available() }
    async fn delete_table_rows(&self, _t: &str, _s: Option<&str>, _w: &[crate::db::types::WhereCondition]) -> Result<ExecuteResult, DbError> { self.not_available() }
    async fn export_table_sql(&self, _t: &str, _s: Option<&str>) -> Result<String, DbError> { self.not_available() }
}
