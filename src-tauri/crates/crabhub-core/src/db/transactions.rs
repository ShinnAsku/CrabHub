use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use super::execution::StatementOutcome;
use super::session::DatabaseSession;
use super::types::DbError;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum TransactionRequest {
    Begin { id: String },
    Execute { transaction_id: String, statements: Vec<String> },
    Commit { transaction_id: String },
    Rollback { transaction_id: String },
    Cancel { transaction_id: String },
    Status { transaction_id: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResult {
    pub transaction_id: String,
    pub connection_id: String,
    pub state: TransactionState,
    pub statements: Vec<StatementOutcome>,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransactionState { Active, Committed, RolledBack, Unknown }

enum Operation { Execute(Vec<String>), Finish(bool) }

struct Command {
    operation: Operation,
    response: oneshot::Sender<Result<TransactionResult, DbError>>,
}

struct Lease {
    owner: String,
    connection_id: String,
    sender: mpsc::Sender<Command>,
    cancel: CancellationToken,
}

pub struct TransactionService {
    leases: Mutex<HashMap<String, Arc<Lease>>>,
    capacity: Arc<Semaphore>,
}

impl Default for TransactionService {
    fn default() -> Self {
        Self { leases: Mutex::new(HashMap::new()), capacity: Arc::new(Semaphore::new(16)) }
    }
}

fn unavailable() -> DbError {
    DbError::QueryError("Transaction is no longer active or belongs to another client; no SQL was executed".into())
}

impl TransactionService {
    pub async fn begin(self: &Arc<Self>, owner: &str, connection_id: &str, mut session: Box<dyn DatabaseSession>, timeout: Duration, permit: OwnedSemaphorePermit) -> Result<TransactionResult, DbError> {
        tokio::time::timeout(Duration::from_secs(10), session.execute("BEGIN")).await
            .map_err(|_| DbError::Timeout("Transaction begin timed out".into()))??;
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel(1);
        let lease = Arc::new(Lease { owner: owner.into(), connection_id: connection_id.into(), sender, cancel: CancellationToken::new() });
        self.leases.lock().map_err(|_| unavailable())?.insert(transaction_id.clone(), lease.clone());
        let initial = TransactionResult { transaction_id: transaction_id.clone(), connection_id: connection_id.into(), state: TransactionState::Active, statements: Vec::new() };
        let registry = Arc::downgrade(self);
        let snapshot = initial.clone();
        tokio::spawn(async move {
            let _permit = permit;
            run_session(session, receiver, lease.cancel.clone(), timeout, snapshot).await;
            if let Some(registry) = registry.upgrade() {
                if let Ok(mut leases) = registry.leases.lock() { leases.remove(&transaction_id); }
            }
        });
        Ok(initial)
    }

    pub fn reserve(&self) -> Result<OwnedSemaphorePermit, DbError> {
        self.capacity.clone().try_acquire_owned()
            .map_err(|_| DbError::QueryError("At most 16 interactive transactions may be open".into()))
    }

    fn lease(&self, owner: &str, transaction_id: &str) -> Result<Arc<Lease>, DbError> {
        self.leases.lock().map_err(|_| unavailable())?.get(transaction_id)
            .filter(|lease| lease.owner == owner && !lease.cancel.is_cancelled()).cloned().ok_or_else(unavailable)
    }

    pub async fn request(&self, owner: &str, request: TransactionRequest) -> Result<TransactionResult, DbError> {
        let (transaction_id, operation) = match request {
            TransactionRequest::Execute { transaction_id, statements } => (transaction_id, Some(Operation::Execute(statements))),
            TransactionRequest::Commit { transaction_id } => (transaction_id, Some(Operation::Finish(true))),
            TransactionRequest::Rollback { transaction_id } => (transaction_id, Some(Operation::Finish(false))),
            TransactionRequest::Status { transaction_id } => (transaction_id, None),
            TransactionRequest::Cancel { transaction_id } => {
                let lease = self.lease(owner, &transaction_id)?;
                lease.cancel.cancel();
                return Ok(TransactionResult { transaction_id, connection_id: lease.connection_id.clone(), state: TransactionState::Unknown, statements: Vec::new() });
            }
            TransactionRequest::Begin { .. } => return Err(DbError::QueryError("Begin requires an acquired database session".into())),
        };
        let lease = self.lease(owner, &transaction_id)?;
        let Some(operation) = operation else {
            return Ok(TransactionResult { transaction_id, connection_id: lease.connection_id.clone(), state: TransactionState::Active, statements: Vec::new() });
        };
        let (response, received) = oneshot::channel();
        lease.sender.try_send(Command { operation, response })
            .map_err(|_| DbError::QueryError("Transaction is busy or closing; no additional SQL was queued".into()))?;
        received.await.map_err(|_| unavailable())?
    }

    pub fn disconnect(&self, connection_id: &str) {
        if let Ok(leases) = self.leases.lock() {
            let prefix = format!("{connection_id}:sub:");
            for lease in leases.values().filter(|lease| lease.connection_id == connection_id || lease.connection_id.starts_with(&prefix)) {
                lease.cancel.cancel();
            }
        }
    }

    pub fn has_connection(&self, connection_id: &str) -> bool {
        self.leases.lock().map(|leases| leases.values().any(|lease| lease.connection_id == connection_id))
            .unwrap_or(true)
    }
}

impl Drop for TransactionService {
    fn drop(&mut self) {
        if let Ok(leases) = self.leases.lock() {
            for lease in leases.values() { lease.cancel.cancel(); }
        }
    }
}

async fn run_session(mut session: Box<dyn DatabaseSession>, mut receiver: mpsc::Receiver<Command>, cancel: CancellationToken, timeout: Duration, mut snapshot: TransactionResult) {
    let mut final_response = None;
    let mut failure = None;
    loop {
        let command = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            command = tokio::time::timeout(Duration::from_secs(300), receiver.recv()) => match command {
                Ok(Some(command)) => command,
                _ => break,
            },
        };
        let Command { operation, mut response } = command;
        let commit = matches!(operation, Operation::Finish(true));
        let finishing = matches!(operation, Operation::Finish(_));
        let operation = async {
            match operation {
                Operation::Execute(statements) => execute_statements(&mut *session, &statements).await,
                Operation::Finish(commit) => session.execute(if commit { "COMMIT" } else { "ROLLBACK" }).await.map(|_| Vec::new()),
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(DbError::QueryError("Transaction cancelled".into())),
            _ = response.closed() => Err(DbError::QueryError("Transaction client disconnected".into())),
            result = tokio::time::timeout(if finishing { Duration::from_secs(10) } else { timeout }, operation) =>
                result.map_err(|_| DbError::Timeout("Transaction operation timed out".into())).and_then(|result| result),
        };
        match result {
            Ok(statements) if !finishing => {
                let mut update = snapshot.clone();
                update.statements = statements;
                if response.send(Ok(update)).is_err() { break; }
            }
            Ok(_) => {
                snapshot.state = if commit { TransactionState::Committed } else { TransactionState::RolledBack };
                final_response = Some(response);
                break;
            }
            Err(error) => {
                failure = Some(error);
                final_response = Some(response);
                break;
            }
        }
    }
    cancel.cancel();
    if snapshot.state == TransactionState::Active {
        let _ = tokio::time::timeout(Duration::from_secs(2), session.cancel()).await;
        snapshot.state = match tokio::time::timeout(Duration::from_secs(5), session.execute("ROLLBACK")).await {
            Ok(Ok(_)) => TransactionState::RolledBack,
            _ => TransactionState::Unknown,
        };
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
    if let Some(response) = final_response {
        let result = match failure {
            Some(error) => Err(DbError::QueryError(format!("{error}; transaction ended. Verify the database before retrying writes"))),
            None => Ok(snapshot),
        };
        let _ = response.send(result);
    }
}

async fn execute_statements(session: &mut dyn DatabaseSession, statements: &[String]) -> Result<Vec<StatementOutcome>, DbError> {
    use super::execution::{validate_script, ScriptOptions, StatementStatus};
    let parsed = validate_script(statements, &ScriptOptions { atomic: true, stop_on_error: true })?;
    session.validate_atomic(statements).await?;
    let mut outcomes = Vec::with_capacity(statements.len());
    let row_limit = (10_000 / statements.len()).min(500);
    let byte_limit = (16 * 1024 * 1024 / statements.len()).min(1024 * 1024);
    for (index, (sql, statement)) in statements.iter().zip(parsed).enumerate() {
        let started = std::time::Instant::now();
        let (result, rows_affected, truncated) = if super::sql_kind::returns_rows(&statement) {
            let (result, truncated) = session.query_preview(sql, row_limit, byte_limit).await?;
            (Some(super::types::WireQueryResult::from(result)), None, truncated)
        } else {
            (None, Some(session.execute(sql).await?.rows_affected), false)
        };
        outcomes.push(StatementOutcome {
            statement_index: index, status: StatementStatus::Succeeded,
            execution_time_ms: started.elapsed().as_millis() as u64,
            driver_elapsed_ms: None, first_row_ms: session.first_row_ms(),
            result, rows_affected, truncated, error: None,
        });
    }
    Ok(outcomes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn database() -> (tempfile::TempDir, sqlx::SqlitePool) {
        let directory = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new().filename(directory.path().join("transactions.db")).create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(4).connect_with(options).await.unwrap();
        sqlx::query("CREATE TABLE records (value INTEGER NOT NULL)").execute(&pool).await.unwrap();
        (directory, pool)
    }

    async fn begin(service: &Arc<TransactionService>, pool: &sqlx::SqlitePool) -> String {
        let session = super::super::session::SqlxSession::new(pool.acquire().await.unwrap());
        service.begin("owner", "connection", Box::new(session), Duration::from_secs(5), service.reserve().unwrap())
            .await.unwrap().transaction_id
    }

    async fn execute(service: &TransactionService, transaction_id: &str, sql: &[&str]) -> Result<TransactionResult, DbError> {
        service.request("owner", TransactionRequest::Execute {
            transaction_id: transaction_id.into(), statements: sql.iter().map(|sql| sql.to_string()).collect(),
        }).await
    }

    async fn count(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM records").fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    async fn transaction_holds_one_session_across_requests_and_commits() {
        let (_directory, pool) = database().await;
        let service = Arc::new(TransactionService::default());
        let transaction_id = begin(&service, &pool).await;
        execute(&service, &transaction_id, &["INSERT INTO records VALUES (1)"]).await.unwrap();
        assert_eq!(count(&pool).await, 0);
        let outcome = execute(&service, &transaction_id, &["SELECT COUNT(*) AS total FROM records"]).await.unwrap();
        let result = outcome.statements[0].result.as_ref().unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(1));
        assert!(service.request("another-owner", TransactionRequest::Commit { transaction_id: transaction_id.clone() }).await.is_err());
        let outcome = service.request("owner", TransactionRequest::Commit { transaction_id: transaction_id.clone() }).await.unwrap();
        assert!(outcome.state == TransactionState::Committed);
        assert_eq!(count(&pool).await, 1);
        assert!(execute(&service, &transaction_id, &["INSERT INTO records VALUES (2)"]).await.is_err());
        pool.close().await;
    }

    #[tokio::test]
    async fn rollback_and_statement_errors_do_not_commit_prior_writes() {
        let (_directory, pool) = database().await;
        let service = Arc::new(TransactionService::default());
        let transaction_id = begin(&service, &pool).await;
        execute(&service, &transaction_id, &["INSERT INTO records VALUES (1)"]).await.unwrap();
        let outcome = service.request("owner", TransactionRequest::Rollback { transaction_id }).await.unwrap();
        assert!(outcome.state == TransactionState::RolledBack);
        assert_eq!(count(&pool).await, 0);
        let transaction_id = begin(&service, &pool).await;
        execute(&service, &transaction_id, &["INSERT INTO records VALUES (1)"]).await.unwrap();
        assert!(execute(&service, &transaction_id, &["INSERT INTO missing_table VALUES (2)"]).await.is_err());
        assert_eq!(count(&pool).await, 0);
        assert!(service.request("owner", TransactionRequest::Status { transaction_id }).await.is_err());
        pool.close().await;
    }

    #[tokio::test]
    async fn disconnect_cancels_transaction_and_releases_sqlite_write_lock() {
        let (_directory, pool) = database().await;
        let service = Arc::new(TransactionService::default());
        let transaction_id = begin(&service, &pool).await;
        execute(&service, &transaction_id, &["INSERT INTO records VALUES (1)"]).await.unwrap();
        service.disconnect("connection");
        tokio::time::timeout(Duration::from_secs(8), sqlx::query("INSERT INTO records VALUES (2)").execute(&pool)).await.unwrap().unwrap();
        assert_eq!(count(&pool).await, 1);
        assert!(service.request("owner", TransactionRequest::Status { transaction_id }).await.is_err());
        pool.close().await;
    }

    #[test]
    fn admission_is_bounded_before_acquiring_a_database_session() {
        let service = TransactionService::default();
        let permits = (0..16).map(|_| service.reserve().unwrap()).collect::<Vec<_>>();
        assert!(service.reserve().is_err());
        drop(permits);
        assert!(service.reserve().is_ok());
    }

    #[tokio::test]
    async fn single_connection_pool_exhaustion_does_not_reconnect_or_abort_transaction() {
        use super::super::manager::ConnectionManager;
        let directory = tempfile::tempdir().unwrap();
        let manager = ConnectionManager::new();
        let config = serde_json::from_value(serde_json::json!({
            "id": "single", "name": "Single connection", "dbType": "sqlite",
            "database": directory.path().join("single.db").to_str().unwrap(),
            "poolOptions": { "acquireTimeoutSecs": 1 }
        })).unwrap();
        manager.connect(config).await.unwrap();
        manager.execute("single", "CREATE TABLE records (value INTEGER)").await.unwrap();
        let active = manager.transaction("owner", TransactionRequest::Begin { id: "single".into() }).await.unwrap();
        manager.transaction("owner", TransactionRequest::Execute {
            transaction_id: active.transaction_id.clone(), statements: vec!["INSERT INTO records VALUES (1)".into()],
        }).await.unwrap();
        assert!(matches!(manager.query("single", "SELECT COUNT(*) FROM records").await, Err(DbError::Timeout(_))));
        let committed = manager.transaction("owner", TransactionRequest::Commit { transaction_id: active.transaction_id }).await.unwrap();
        assert!(committed.state == TransactionState::Committed);
        let result = manager.query("single", "SELECT COUNT(*) AS total FROM records").await.unwrap();
        assert_eq!(result.rows[0]["total"], serde_json::json!(1));
        manager.disconnect("single").await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires CRABHUB_TRANSACTION_TEST_CONFIG pointing to an isolated PostgreSQL or MySQL instance"]
    async fn live_transaction_contract() {
        use super::super::manager::ConnectionManager;
        use super::super::types::{ConnectionConfig, DatabaseType};
        let config: ConnectionConfig = serde_json::from_str(&std::env::var("CRABHUB_TRANSACTION_TEST_CONFIG").expect("Isolated database config is required")).unwrap();
        assert!(matches!(config.db_type, DatabaseType::PostgreSQL | DatabaseType::MySQL));
        let manager = ConnectionManager::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        loop {
            if manager.connect(config.clone()).await.is_ok() { break; }
            assert!(tokio::time::Instant::now() < deadline, "Isolated database did not become ready");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let id = &config.id;
        let table = format!("crabhub_tx_{}", uuid::Uuid::new_v4().simple());
        let engine = if config.db_type == DatabaseType::MySQL { " ENGINE=InnoDB" } else { "" };
        manager.execute(id, &format!("CREATE TABLE {table} (value INTEGER PRIMARY KEY){engine}")).await.unwrap();
        let active = manager.transaction("owner", TransactionRequest::Begin { id: id.clone() }).await.unwrap();
        manager.transaction("owner", TransactionRequest::Execute { transaction_id: active.transaction_id.clone(), statements: vec![format!("INSERT INTO {table} VALUES (1)")] }).await.unwrap();
        assert_eq!(manager.query(id, &format!("SELECT value FROM {table}")).await.unwrap().row_count, 0);
        let inside = manager.transaction("owner", TransactionRequest::Execute { transaction_id: active.transaction_id.clone(), statements: vec![format!("SELECT value FROM {table}")] }).await.unwrap();
        assert_eq!(inside.statements[0].result.as_ref().unwrap().row_count, 1);
        assert!(manager.transaction("other-owner", TransactionRequest::Commit { transaction_id: active.transaction_id.clone() }).await.is_err());
        let committed = manager.transaction("owner", TransactionRequest::Commit { transaction_id: active.transaction_id }).await.unwrap();
        assert!(committed.state == TransactionState::Committed);
        assert_eq!(manager.query(id, &format!("SELECT value FROM {table}")).await.unwrap().row_count, 1);
        for failing in [false, true] {
            let active = manager.transaction("owner", TransactionRequest::Begin { id: id.clone() }).await.unwrap();
            manager.transaction("owner", TransactionRequest::Execute { transaction_id: active.transaction_id.clone(), statements: vec![format!("INSERT INTO {table} VALUES (2)")] }).await.unwrap();
            if failing {
                assert!(manager.transaction("owner", TransactionRequest::Execute { transaction_id: active.transaction_id, statements: vec![format!("INSERT INTO {table} VALUES (1)")] }).await.is_err());
            } else {
                manager.transaction("owner", TransactionRequest::Rollback { transaction_id: active.transaction_id }).await.unwrap();
            }
            assert_eq!(manager.query(id, &format!("SELECT value FROM {table}")).await.unwrap().row_count, 1);
        }
        let active = manager.transaction("owner", TransactionRequest::Begin { id: id.clone() }).await.unwrap();
        manager.transaction("owner", TransactionRequest::Execute { transaction_id: active.transaction_id.clone(), statements: vec![format!("INSERT INTO {table} VALUES (3)")] }).await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), manager.disconnect(id)).await.unwrap().unwrap();
        assert!(manager.transaction("owner", TransactionRequest::Status { transaction_id: active.transaction_id }).await.is_err());
        manager.connect(config.clone()).await.unwrap();
        assert_eq!(manager.query(id, &format!("SELECT value FROM {table}")).await.unwrap().row_count, 1);
        assert!(manager.execute(id, "BEGIN").await.is_err());
        manager.execute(id, &format!("DROP TABLE {table}")).await.unwrap();
        manager.disconnect(id).await.unwrap();
    }
}