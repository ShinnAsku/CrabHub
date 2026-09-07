use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::session::DatabaseSession;
use super::types::DbError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkRequest {
    pub id: String,
    pub execution_id: String,
    pub table: String,
    pub schema: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub atomic: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkOutcome {
    pub execution_id: String,
    pub committed_rows: Option<u64>,
    pub completed_rows: u64,
    pub failed_row_offset: Option<usize>,
    pub transaction: super::execution::TransactionOutcome,
    pub error: Option<String>,
    pub total_ms: u64,
}

pub fn validate(request: &BulkRequest) -> Result<(), DbError> {
    let identifiers = std::iter::once(&request.table).chain(request.schema.iter()).chain(&request.columns);
    if request.columns.is_empty() || request.columns.len() > 128 || request.rows.len() > 10_000
        || identifiers.clone().any(|name| name.is_empty() || name.len() > 256 || name.contains('\0'))
        || request.columns.iter().collect::<HashSet<_>>().len() != request.columns.len()
        || request.rows.iter().any(|row| row.len() != request.columns.len()) {
        return Err(DbError::QueryError("Invalid bulk shape: require unique columns, 1-128 columns, at most 10000 rows, and bounded identifiers".into()));
    }
    if serde_json::to_vec(&request.rows).map_err(|error| DbError::QueryError(error.to_string()))?.len() > 1024 * 1024 {
        return Err(DbError::QueryError("Bulk payload exceeds 1 MiB; send smaller batches".into()));
    }
    if request.rows.iter().flatten().any(|value| value.is_u64() && value.as_i64().is_none()) {
        return Err(DbError::QueryError("Integers larger than signed 64-bit must be supplied as decimal strings".into()));
    }
    chunk_ranges(request)?;
    Ok(())
}

fn chunk_ranges(request: &BulkRequest) -> Result<Vec<std::ops::Range<usize>>, DbError> {
    let row_limit = (999 / request.columns.len().max(1)).min(200);
    let column_bytes = serde_json::to_vec(&request.columns).map_err(|error| DbError::QueryError(error.to_string()))?.len();
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (index, row) in request.rows.iter().enumerate() {
        let row_bytes = serde_json::to_vec(row).map_err(|error| DbError::QueryError(error.to_string()))?.len() + column_bytes + 64;
        if row_bytes > 256 * 1024 {
            return Err(DbError::QueryError(format!("Bulk row {index} exceeds the 256 KiB chunk budget")));
        }
        if index > start && (index - start >= row_limit || bytes + row_bytes > 256 * 1024) {
            ranges.push(start..index);
            start = index;
            bytes = 0;
        }
        bytes += row_bytes;
    }
    if start < request.rows.len() { ranges.push(start..request.rows.len()); }
    Ok(ranges)
}

fn quote(name: &str, delimiter: char) -> String {
    format!("{delimiter}{}{delimiter}", name.replace(delimiter, &format!("{delimiter}{delimiter}")))
}

fn target(request: &BulkRequest, delimiter: char) -> String {
    match &request.schema {
        Some(schema) => format!("{}.{}", quote(schema, delimiter), quote(&request.table, delimiter)),
        None => quote(&request.table, delimiter),
    }
}

pub(crate) async fn insert_postgres(connection: &mut sqlx::PgConnection, request: &BulkRequest, rows: &[Vec<Value>]) -> Result<u64, DbError> {
    let table = target(request, '"');
    let columns = request.columns.iter().map(|column| quote(column, '"')).collect::<Vec<_>>().join(", ");
    let records: Vec<serde_json::Map<String, Value>> = rows.iter().map(|row| request.columns.iter().cloned().zip(row.iter().cloned()).collect()).collect();
    let sql = format!("INSERT INTO {table} ({columns}) SELECT {columns} FROM json_populate_recordset(NULL::{table}, $1::json)");
    sqlx::query(&sql).bind(sqlx::types::Json(records)).execute(connection).await
        .map(|result| result.rows_affected()).map_err(super::session::sqlx_error)
}

macro_rules! parameterized_insert {
    ($function:ident, $connection:ty, $database:ty, $delimiter:literal) => {
        pub(crate) async fn $function(connection: &mut $connection, request: &BulkRequest, rows: &[Vec<Value>]) -> Result<u64, DbError> {
            let columns = request.columns.iter().map(|column| quote(column, $delimiter)).collect::<Vec<_>>().join(", ");
            let mut builder = sqlx::QueryBuilder::<$database>::new(format!("INSERT INTO {} ({columns}) ", target(request, $delimiter)));
            builder.push_values(rows, |mut separated, row| {
                for value in row {
                    match value {
                        Value::Null => { separated.push("NULL"); }
                        Value::Bool(value) => { separated.push_bind(*value); }
                        Value::Number(value) if value.is_i64() => { separated.push_bind(value.as_i64().unwrap()); }
                        Value::Number(value) => { separated.push_bind(value.as_f64().unwrap()); }
                        Value::String(value) => { separated.push_bind(value.as_str()); }
                        value => { separated.push_bind(value.to_string()); }
                    }
                }
            });
            builder.build().execute(connection).await.map(|result| result.rows_affected())
                .map_err(super::session::sqlx_error)
        }
    };
}

parameterized_insert!(insert_mysql_rows, sqlx::MySqlConnection, sqlx::MySql, '`');
parameterized_insert!(insert_sqlite, sqlx::SqliteConnection, sqlx::Sqlite, '"');

pub(crate) async fn insert_mysql(connection: &mut sqlx::MySqlConnection, request: &BulkRequest, rows: &[Vec<Value>]) -> Result<u64, DbError> {
    super::atomic_guard::mysql_table(connection, request.schema.as_deref(), &request.table).await?;
    insert_mysql_rows(connection, request, rows).await
}

pub async fn run(mut session: Box<dyn DatabaseSession>, request: &BulkRequest, cancel: CancellationToken, timeout: Duration) -> Result<BulkOutcome, DbError> {
    let started = Instant::now();
    if let Err(error) = validate(request) {
        let _ = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
        return Err(error);
    }
    let mut outcome = BulkOutcome { execution_id: request.execution_id.clone(), committed_rows: Some(0), completed_rows: 0,
        failed_row_offset: None, transaction: super::execution::TransactionOutcome::Native, error: None, total_ms: 0 };
    if request.atomic {
        let begin = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(DbError::QueryError("Bulk cancelled before transaction start".into())),
            result = tokio::time::timeout(timeout, session.execute("BEGIN")) => result.map_err(|_| DbError::Timeout("Transaction start timed out".into())).and_then(|result| result),
        };
        if let Err(error) = begin {
            let _ = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
            return Err(error);
        }
    }
    let result: Result<(), DbError> = async {
        for range in chunk_ranges(request)? {
            let rows = &request.rows[range.clone()];
            if cancel.is_cancelled() {
                outcome.failed_row_offset = Some(range.start);
                return Err(DbError::QueryError("Bulk cancellation requested; remaining rows were not started".into()));
            }
            let inserted = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    outcome.committed_rows = None;
                    Err(DbError::QueryError("Bulk cancellation requested; current chunk commit state is unknown".into()))
                },
                result = tokio::time::timeout(timeout, session.insert_rows(request, rows)) => match result {
                    Ok(result) => result,
                    Err(_) => { outcome.committed_rows = None; Err(DbError::Timeout("Bulk chunk timed out; commit state is unknown".into())) }
                },
            };
            match inserted {
                Ok(count) => {
                    outcome.completed_rows += count;
                    if !request.atomic { outcome.committed_rows = Some(outcome.completed_rows); }
                }
                Err(error) => {
                    if matches!(error, DbError::ConnectionError(_)) { outcome.committed_rows = None; }
                    outcome.failed_row_offset = Some(range.start);
                    return Err(error);
                }
            }
        }
        Ok(())
    }.await;
    if outcome.committed_rows.is_none() { session.cancel().await; }
    if request.atomic {
        if outcome.committed_rows.is_none() {
            outcome.transaction = super::execution::TransactionOutcome::Unknown;
        } else {
            let rollback = result.is_err() || cancel.is_cancelled();
            match tokio::time::timeout(Duration::from_secs(5), session.execute(if rollback { "ROLLBACK" } else { "COMMIT" })).await {
                Ok(Ok(_)) => {
                    outcome.transaction = if rollback { super::execution::TransactionOutcome::RolledBack } else { super::execution::TransactionOutcome::Committed };
                    outcome.committed_rows = Some(if rollback { 0 } else { outcome.completed_rows });
                }
                _ => {
                    outcome.transaction = super::execution::TransactionOutcome::Unknown;
                    outcome.committed_rows = None;
                    outcome.error = Some("Transaction completion was not acknowledged; verify data before retrying".into());
                }
            }
        }
    }
    if let Err(error) = result { outcome.error = Some(error.to_string()); }
    if !matches!(tokio::time::timeout(Duration::from_secs(5), session.close()).await, Ok(Ok(()))) {
        outcome.error = Some("Session cleanup was not acknowledged; connection will not be reused".into());
    }
    outcome.total_ms = started.elapsed().as_millis() as u64;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::session::SqlxSession;

    #[test]
    fn chunks_obey_row_parameter_and_byte_budgets() {
        let mut request = BulkRequest { id: "test".into(), execution_id: "test".into(), table: "records".into(), schema: None,
            columns: vec!["value".into()], rows: vec![vec![Value::from("x".repeat(100_000))]; 5], atomic: false };
        assert_eq!(chunk_ranges(&request).unwrap(), vec![0..2, 2..4, 4..5]);
        request.rows = vec![vec![Value::from("x".repeat(256 * 1024))]];
        assert!(validate(&request).is_err());
        request.columns = (0..128).map(|index| format!("column_{index}")).collect();
        request.rows = vec![vec![Value::Null; 128]; 10];
        assert_eq!(chunk_ranges(&request).unwrap(), vec![0..7, 7..10]);
    }

    #[tokio::test]
    async fn parameterized_bulk_preserves_literals_and_rolls_back_duplicate_rows() {
        let directory = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(2)
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(directory.path().join("bulk.db")).create_if_missing(true)).await.unwrap();
        sqlx::query("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)").execute(&pool).await.unwrap();
        let mut request = BulkRequest { id: "test".into(), execution_id: "test".into(), table: "records".into(), schema: None,
            columns: vec!["id".into(), "value".into()], rows: vec![vec![Value::from(1), Value::from("'; DROP TABLE records; --")]], atomic: true };
        let result = run(Box::new(SqlxSession::new(pool.acquire().await.unwrap())), &request, CancellationToken::new(), Duration::from_secs(5)).await.unwrap();
        assert_eq!(result.committed_rows, Some(1));
        let stored: (String,) = sqlx::query_as("SELECT value FROM records").fetch_one(&pool).await.unwrap();
        assert_eq!(stored.0, "'; DROP TABLE records; --");
        request.rows = vec![vec![Value::from(2), Value::Null], vec![Value::from(1), Value::from("duplicate")]];
        let result = run(Box::new(SqlxSession::new(pool.acquire().await.unwrap())), &request, CancellationToken::new(), Duration::from_secs(5)).await.unwrap();
        assert_eq!(result.committed_rows, Some(0));
        assert_eq!(result.transaction, super::super::execution::TransactionOutcome::RolledBack);
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM records").fetch_one(&pool).await.unwrap();
        assert_eq!(count.0, 1);
        pool.close().await;
    }
}
