use std::time::{Duration, Instant};
use futures_util::{stream, StreamExt};

use serde::{Deserialize, Serialize};
use sqlparser::ast::Statement;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::session::DatabaseSession;
use super::sql_kind::{parse_one, returns_rows};
use super::types::{DbError, WireQueryResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptOptions {
    #[serde(default)]
    pub atomic: bool,
    #[serde(default = "default_stop_on_error")]
    pub stop_on_error: bool,
}

fn default_stop_on_error() -> bool { true }

impl Default for ScriptOptions {
    fn default() -> Self { Self { atomic: false, stop_on_error: true } }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptRequest {
    pub id: String,
    pub execution_id: String,
    pub statements: Vec<String>,
    #[serde(default)]
    pub options: ScriptOptions,
    #[serde(default)]
    pub mode: ExecutionMode,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_concurrency() -> usize { 4 }

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    #[default]
    Script,
    Independent,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatementStatus {
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    pub statement_index: usize,
    pub status: StatementStatus,
    pub execution_time_ms: u64,
    pub driver_elapsed_ms: Option<u64>,
    pub first_row_ms: Option<u64>,
    pub result: Option<WireQueryResult>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransactionOutcome {
    Native,
    Committed,
    RolledBack,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutcome {
    pub execution_id: Option<String>,
    pub queue_ms: Option<u64>,
    pub acquire_ms: Option<u64>,
    pub statements: Vec<StatementOutcome>,
    pub transaction: TransactionOutcome,
    pub total_ms: u64,
    pub cleanup_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecutionUpdate {
    Started { execution_id: String },
    Statement { execution_id: String, statement: StatementOutcome },
    Finished { outcome: ScriptOutcome },
    Error { execution_id: String, error: String },
}

pub struct ExecutionDelivery {
    pub update: ExecutionUpdate,
    pub acknowledged: oneshot::Sender<()>,
}

pub async fn deliver(
    progress: &mpsc::Sender<ExecutionDelivery>,
    update: ExecutionUpdate,
    cancel: &CancellationToken,
) -> Result<(), DbError> {
    let (acknowledged, acknowledgement) = oneshot::channel();
    let delivery = async {
        progress.send(ExecutionDelivery { update, acknowledged }).await
            .map_err(|_| DbError::QueryError("Result consumer disconnected".into()))?;
        acknowledgement.await.map_err(|_| DbError::QueryError("Result was not acknowledged".into()))
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DbError::QueryError("Execution cancelled while delivering results".into())),
        result = tokio::time::timeout(Duration::from_secs(15), delivery) => result
            .map_err(|_| DbError::Timeout("Result consumer did not respond within 15s".into()))?,
    }
}

pub fn validate_script(sql: &[String], options: &ScriptOptions) -> Result<Vec<Statement>, DbError> {
    if sql.is_empty() || sql.len() > 1000 || sql.iter().map(String::len).sum::<usize>() > 4 * 1024 * 1024 {
        return Err(DbError::QueryError("Scripts require 1-1000 statements and at most 4 MiB of SQL".into()));
    }
    if options.atomic && !options.stop_on_error {
        return Err(DbError::QueryError("Atomic scripts require stopOnError".into()));
    }
    let statements = sql.iter().map(|sql| parse_one(sql).map_err(DbError::QueryError))
        .collect::<Result<Vec<_>, _>>()?;
    let mut transaction_open = false;
    for statement in &statements {
        if !returns_rows(statement) && !matches!(statement,
            Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_)
            | Statement::CreateTable(_) | Statement::CreateIndex(_) | Statement::CreateView { .. }
            | Statement::AlterTable { .. } | Statement::Drop { .. } | Statement::Truncate { .. }
            | Statement::StartTransaction { .. } | Statement::Commit { .. } | Statement::Rollback { .. }
            | Statement::Set(_) | Statement::Use(_)) {
            return Err(DbError::QueryError("This statement is not supported by isolated scripts; procedure calls and dynamic SQL require multi-result support".into()));
        }
        if options.atomic && !matches!(statement,
            Statement::Query(_) | Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_)) {
            return Err(DbError::QueryError("Atomic scripts currently support queries and DML only; explicit transaction control and DDL are not supported".into()));
        }
        if options.atomic && matches!(statement, Statement::Query(_)) && !super::sql_kind::is_read_only(statement) {
            return Err(DbError::QueryError("Atomic query statements must be classified read-only; SELECT INTO and unclassified functions are not supported".into()));
        }
        match statement {
            Statement::StartTransaction { statements, .. } if !transaction_open && statements.is_empty() => transaction_open = true,
            Statement::StartTransaction { .. } => return Err(DbError::QueryError("Nested transaction blocks are not supported".into())),
            Statement::Commit { chain: false, .. } | Statement::Rollback { chain: false, savepoint: None } if transaction_open => transaction_open = false,
            Statement::Commit { .. } | Statement::Rollback { .. }
            | Statement::Savepoint { .. } | Statement::ReleaseSavepoint { .. } => return Err(DbError::QueryError("Transaction control must be balanced within this script; savepoints and chained transactions are not supported yet".into())),
            _ => {}
        }
    }
    if transaction_open {
        return Err(DbError::QueryError("Close the explicit transaction in this script before executing it".into()));
    }
    Ok(statements)
}

fn failure(index: usize, status: StatementStatus, error: String, elapsed: Duration) -> StatementOutcome {
    StatementOutcome {
        statement_index: index,
        status,
        execution_time_ms: elapsed.as_millis() as u64,
        driver_elapsed_ms: None,
        first_row_ms: None,
        result: None,
        rows_affected: None,
        truncated: false,
        error: Some(error),
    }
}

pub fn validate_request(request: &ScriptRequest) -> Result<(), DbError> {
    let statements = validate_script(&request.statements, &request.options)?;
    if request.mode == ExecutionMode::Independent {
        if request.options.atomic || !(1..=8).contains(&request.concurrency) {
            return Err(DbError::QueryError("Independent reads require concurrency 1-8 and cannot share an atomic transaction".into()));
        }
        if !statements.iter().all(super::sql_kind::is_read_only) {
            return Err(DbError::QueryError("Independent execution accepts only classified read-only queries without session dependencies".into()));
        }
    }
    Ok(())
}

pub async fn run_independent(
    connection: &dyn super::trait_def::DatabaseConnection,
    request: &ScriptRequest,
    cancel: CancellationToken,
    timeout: Duration,
    capacity: super::execution_registry::ExecutionLimits,
    progress: Option<&mpsc::Sender<ExecutionDelivery>>,
) -> Result<ScriptOutcome, DbError> {
    validate_request(request)?;
    let started = Instant::now();
    let row_limit = (10_000 / request.statements.len()).min(500);
    let byte_limit = (32 * 1024 * 1024 / request.statements.len()).min(1024 * 1024);
    let jobs = stream::iter(request.statements.clone().into_iter().enumerate()).map(|(index, sql)| {
        let cancel = cancel.clone();
        let capacity = capacity.clone();
        async move {
            let statement_started = Instant::now();
            let run = async {
                let acquire = async {
                    let permit = capacity.acquire(&cancel).await?;
                    let session = connection.open_session().await?;
                    Ok::<_, DbError>((permit, session))
                };
                let (_permit, mut session) = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(DbError::QueryError("Read cancelled while queued or acquiring a session".into())),
                    result = tokio::time::timeout(Duration::from_secs(10), acquire) => result
                        .map_err(|_| DbError::Timeout("Read queue or session acquisition exceeded 10s".into()))??,
                };
                let read = async {
                    session.begin_read_only().await?;
                    session.query_preview(&sql, row_limit, byte_limit).await
                };
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(DbError::QueryError("Read cancellation requested".into())),
                    result = tokio::time::timeout(timeout, read) => result
                        .map_err(|_| DbError::Timeout("Independent read exceeded its time limit".into())).and_then(|result| result),
                };
                    let first_row_ms = session.first_row_ms();
                if cancel.is_cancelled() || matches!(result, Err(DbError::Timeout(_))) { session.cancel().await; }
                let cleanup = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
                if !matches!(cleanup, Ok(Ok(()))) {
                    return Err(DbError::ConnectionError("Read session cleanup was not acknowledged; connection will not be reused".into()));
                }
                result.map(|(result, truncated)| (result, truncated, first_row_ms))
            };
            if cancel.is_cancelled() {
                return failure(index, StatementStatus::Skipped, "Read was not started".into(), Duration::ZERO);
            }
            match run.await {
                Ok((result, truncated, first_row_ms)) => StatementOutcome {
                    statement_index: index, status: StatementStatus::Succeeded,
                    execution_time_ms: statement_started.elapsed().as_millis() as u64,
                    driver_elapsed_ms: Some(result.execution_time_ms), first_row_ms,
                    result: Some(WireQueryResult::from(result)), rows_affected: None, truncated, error: None,
                },
                Err(error) => failure(index, if cancel.is_cancelled() { StatementStatus::Cancelled } else { StatementStatus::Failed }, error.to_string(), statement_started.elapsed()),
            }
        }
    }).buffer_unordered(request.concurrency);
    tokio::pin!(jobs);
    let mut results = Vec::with_capacity(request.statements.len());
    let mut cleanup_error = None;
    while let Some(mut result) = jobs.next().await {
        if result.status == StatementStatus::Failed && request.options.stop_on_error { cancel.cancel(); }
        if let Some(sender) = progress {
            let update = ExecutionUpdate::Statement { execution_id: request.execution_id.clone(), statement: result.clone() };
            if let Err(error) = deliver(sender, update, &cancel).await {
                cleanup_error = Some(error.to_string());
                cancel.cancel();
            }
            result.result = None;
        }
        results.push(result);
    }
    results.sort_by_key(|result| result.statement_index);
    Ok(ScriptOutcome {
        execution_id: Some(request.execution_id.clone()), queue_ms: None, acquire_ms: None,
        statements: results, transaction: TransactionOutcome::Native,
        total_ms: started.elapsed().as_millis() as u64, cleanup_error,
    })
}

pub async fn run_script(
    session: Box<dyn DatabaseSession>,
    sql: &[String],
    options: &ScriptOptions,
    cancel: CancellationToken,
    timeout: Duration,
) -> Result<ScriptOutcome, DbError> {
    run_script_progress(session, sql, options, cancel, timeout, None).await
}

pub async fn run_script_progress(
    mut session: Box<dyn DatabaseSession>,
    sql: &[String],
    options: &ScriptOptions,
    cancel: CancellationToken,
    timeout: Duration,
    progress: Option<(&str, &mpsc::Sender<ExecutionDelivery>)>,
) -> Result<ScriptOutcome, DbError> {
    let statements = match validate_script(sql, options) {
        Ok(statements) => statements,
        Err(error) => {
            let _ = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
            return Err(error);
        }
    };
    let started = Instant::now();
    let mut outcome = ScriptOutcome {
        execution_id: None,
        queue_ms: None,
        acquire_ms: None,
        statements: Vec::with_capacity(sql.len()),
        transaction: TransactionOutcome::Native,
        total_ms: 0,
        cleanup_error: None,
    };
    let mut interrupted = false;
    let mut stopped = false;
    let mut remaining_rows = 10_000usize;
    let mut remaining_bytes = 32 * 1024 * 1024usize;
    if options.atomic {
        let begin = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(DbError::QueryError("Script cancelled before transaction start".into())),
            result = tokio::time::timeout(timeout, async {
                session.validate_atomic(sql).await?;
                session.execute("BEGIN").await
            }) => result
                .map_err(|_| DbError::Timeout("Transaction start timed out".into())).and_then(|result| result),
        };
        if let Err(error) = begin {
            let _ = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
            return Err(error);
        }
    }
    for (index, (text, statement)) in sql.iter().zip(&statements).enumerate() {
        if stopped || cancel.is_cancelled() {
            stopped = true;
            outcome.statements.push(failure(index, StatementStatus::Skipped, "Statement was not started".into(), Duration::ZERO));
            continue;
        }
        let statement_started = Instant::now();
        let execute = async {
            if returns_rows(statement) {
                session.query_preview(text, remaining_rows.min(500), remaining_bytes).await.map(|(result, truncated)| StatementOutcome {
                    statement_index: index,
                    status: StatementStatus::Succeeded,
                    execution_time_ms: statement_started.elapsed().as_millis() as u64,
                    driver_elapsed_ms: Some(result.execution_time_ms), first_row_ms: None,
                    result: Some(WireQueryResult::from(result)),
                    rows_affected: None,
                    truncated,
                    error: None,
                })
            } else {
                session.execute(text).await.map(|result| StatementOutcome {
                    statement_index: index,
                    status: StatementStatus::Succeeded,
                    execution_time_ms: statement_started.elapsed().as_millis() as u64,
                    driver_elapsed_ms: Some(result.execution_time_ms), first_row_ms: None,
                    result: None,
                    rows_affected: Some(result.rows_affected),
                    truncated: false,
                    error: None,
                })
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => { interrupted = true; Err(DbError::QueryError("Cancellation requested; completion was not acknowledged by the database".into())) },
            result = tokio::time::timeout(timeout, execute) => match result {
                Ok(result) => result,
                Err(_) => { interrupted = true; Err(DbError::Timeout("Statement timed out; completion was not acknowledged by the database".into())) }
            },
        };
        match result {
            Ok(mut result) => {
                result.first_row_ms = session.first_row_ms();
                if let Some(preview) = &result.result {
                    remaining_rows = remaining_rows.saturating_sub(preview.rows.len());
                    remaining_bytes = remaining_bytes.saturating_sub(serde_json::to_vec(preview).map(|bytes| bytes.len()).unwrap_or(remaining_bytes));
                }
                outcome.statements.push(result);
            }
            Err(error) => {
                interrupted |= matches!(error, DbError::ConnectionError(_));
                let status = if interrupted { StatementStatus::Unknown } else { StatementStatus::Failed };
                outcome.statements.push(failure(index, status, error.to_string(), statement_started.elapsed()));
                stopped = interrupted || options.stop_on_error;
            }
        }
        if let Some((execution_id, sender)) = progress {
            let statement = outcome.statements.last_mut().expect("statement outcome was recorded");
            let update = ExecutionUpdate::Statement { execution_id: execution_id.to_string(), statement: statement.clone() };
            if let Err(error) = deliver(sender, update, &cancel).await {
                stopped = true;
                cancel.cancel();
                outcome.cleanup_error = Some(error.to_string());
            }
            statement.result = None;
        }
    }
    if interrupted { session.cancel().await; }
    if options.atomic {
        let failed = outcome.statements.iter().any(|statement| statement.status != StatementStatus::Succeeded);
        let rollback = failed || cancel.is_cancelled();
        if interrupted {
            outcome.transaction = TransactionOutcome::Unknown;
        } else {
            let finish = tokio::time::timeout(Duration::from_secs(5), session.execute(if rollback { "ROLLBACK" } else { "COMMIT" })).await;
            outcome.transaction = match finish {
                Ok(Ok(_)) if rollback => TransactionOutcome::RolledBack,
                Ok(Ok(_)) => TransactionOutcome::Committed,
                _ => {
                    outcome.cleanup_error = Some("Transaction completion was not acknowledged; do not automatically retry writes".into());
                    TransactionOutcome::Unknown
                }
            };
        }
    }
    match tokio::time::timeout(Duration::from_secs(5), session.close()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => outcome.cleanup_error = Some(error.to_string()),
        Err(_) => outcome.cleanup_error = Some("Session close timed out; connection will not be reused".into()),
    }
    outcome.total_ms = started.elapsed().as_millis() as u64;
    Ok(outcome)
}

