use async_trait::async_trait;
use sqlx::{pool::PoolConnection, Database};

use super::types::{DbError, ExecuteResult, QueryResult};

pub(crate) fn sqlx_error(error: sqlx::Error) -> DbError {
    match error {
        sqlx::Error::PoolTimedOut => DbError::Timeout("Connection pool is busy; no statement was started".into()),
        sqlx::Error::Database(_) => DbError::QueryError(error.to_string()),
        _ => DbError::ConnectionError(error.to_string()),
    }
}

#[async_trait]
pub trait DatabaseSession: Send {
    fn first_row_ms(&self) -> Option<u64> { None }
    async fn cancel(&mut self) -> bool { false }
    async fn validate_atomic(&mut self, _sql: &[String]) -> Result<(), DbError> { Ok(()) }
    async fn insert_rows(&mut self, request: &super::bulk::BulkRequest, rows: &[Vec<serde_json::Value>]) -> Result<u64, DbError>;
    async fn begin_read_only(&mut self) -> Result<(), DbError>;
    async fn execute(&mut self, sql: &str) -> Result<ExecuteResult, DbError>;
    async fn query(&mut self, sql: &str) -> Result<QueryResult, DbError>;
    async fn query_preview(&mut self, sql: &str, row_limit: usize, byte_limit: usize) -> Result<(QueryResult, bool), DbError>;
    async fn close(self: Box<Self>) -> Result<(), DbError>;
}

pub(crate) struct SqlxSession<Driver: Database> {
    connection: PoolConnection<Driver>,
    first_row_ms: Option<u64>,
    cancel: Option<super::session_cancel::SessionCancel>,
}

impl<Driver: Database> SqlxSession<Driver> {
    pub(crate) fn new(mut connection: PoolConnection<Driver>) -> Self {
        connection.close_on_drop();
        Self { connection, first_row_ms: None, cancel: None }
    }

    pub(crate) fn with_cancel(connection: PoolConnection<Driver>, cancel: super::session_cancel::SessionCancel) -> Self {
        let mut session = Self::new(connection);
        session.cancel = Some(cancel);
        session
    }
}

macro_rules! session_driver {
    ($database:ty, $driver:ty, $read_only:literal, $insert:path, $atomic:path) => {
        #[async_trait]
        impl DatabaseSession for SqlxSession<$database> {
            fn first_row_ms(&self) -> Option<u64> { self.first_row_ms }

            async fn cancel(&mut self) -> bool {
                match &self.cancel { Some(cancel) => cancel.cancel().await, None => false }
            }

            async fn validate_atomic(&mut self, sql: &[String]) -> Result<(), DbError> {
                $atomic(&mut self.connection, sql).await
            }

            async fn insert_rows(&mut self, request: &super::bulk::BulkRequest, rows: &[Vec<serde_json::Value>]) -> Result<u64, DbError> {
                $insert(&mut self.connection, request, rows).await
            }

            async fn begin_read_only(&mut self) -> Result<(), DbError> {
                self.execute($read_only).await.map(|_| ())
            }

            async fn execute(&mut self, sql: &str) -> Result<ExecuteResult, DbError> {
                self.first_row_ms = None;
                let started = std::time::Instant::now();
                let result = sqlx::Executor::execute(&mut *self.connection, sql).await
                    .map_err(sqlx_error)?;
                Ok(ExecuteResult {
                    rows_affected: result.rows_affected(),
                    execution_time_ms: started.elapsed().as_millis() as u64,
                })
            }

            async fn query(&mut self, sql: &str) -> Result<QueryResult, DbError> {
                <$driver>::query_on(&mut self.connection, sql).await
            }

            async fn query_preview(&mut self, sql: &str, row_limit: usize, byte_limit: usize) -> Result<(QueryResult, bool), DbError> {
                use futures_util::TryStreamExt;
                use sqlx::{Column, Executor, TypeInfo};

                let started = std::time::Instant::now();
                let mut preview = QueryResult { columns: Vec::new(), rows: Vec::new(), row_count: 0, execution_time_ms: 0 };
                self.first_row_ms = None;
                let mut bytes = 0;
                let mut truncated = false;
                {
                    let mut stream = sqlx::query(sql).fetch(&mut *self.connection);
                    while let Some(row) = stream.try_next().await.map_err(sqlx_error)? {
                        if self.first_row_ms.is_none() { self.first_row_ms = Some(started.elapsed().as_millis() as u64); }
                        if truncated { continue; }
                        let decoded = <$driver>::decode_rows(std::slice::from_ref(&row), 0);
                        if preview.columns.is_empty() { preview.columns = decoded.columns; }
                        let row_bytes = serde_json::to_vec(&decoded.rows).map_err(|error| DbError::QueryError(error.to_string()))?.len();
                        if preview.rows.len() >= row_limit || row_bytes > byte_limit.saturating_sub(bytes) {
                            truncated = true;
                            continue;
                        }
                        bytes += row_bytes;
                        preview.rows.extend(decoded.rows);
                    }
                }
                if preview.columns.is_empty() {
                    if let Ok(description) = (&mut *self.connection).describe(sql).await {
                        preview.columns = description.columns().iter().map(|column| super::types::ColumnInfo {
                            name: column.name().to_string(), data_type: column.type_info().name().to_string(),
                            nullable: true, is_primary_key: false, default_value: None, comment: None,
                            character_maximum_length: None, numeric_precision: None, numeric_scale: None,
                        }).collect();
                    }
                }
                preview.row_count = preview.rows.len() as u64;
                preview.execution_time_ms = started.elapsed().as_millis() as u64;
                Ok((preview, truncated))
            }

            async fn close(self: Box<Self>) -> Result<(), DbError> {
                if let Some(cancel) = &self.cancel { cancel.interrupt_local(); }
                self.connection.close().await.map_err(|error| DbError::ConnectionError(error.to_string()))
            }
        }
    };
}

session_driver!(sqlx::Postgres, super::postgres::PostgresConnection, "BEGIN READ ONLY", super::bulk::insert_postgres, super::atomic_guard::postgres);
session_driver!(sqlx::MySql, super::mysql::MySqlConnection, "START TRANSACTION READ ONLY", super::bulk::insert_mysql, super::atomic_guard::mysql);
session_driver!(sqlx::Sqlite, super::sqlite::SQLiteConnection, "PRAGMA query_only = ON", super::bulk::insert_sqlite, super::atomic_guard::sqlite);

