use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::sql_limiter;
use super::types::{
    DatabaseType, DbError, ExecuteResult, PagedQueryResult, QueryResult,
};


use super::manager::{ConnectionManager, user_query_timeout};

pub(super) async fn execute(manager: &ConnectionManager, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
    super::sql_kind::reject_unscoped_transaction(sql).map_err(DbError::QueryError)?;
    let result = manager.execute_inner(id, sql).await;
    if let Err(DbError::ConnectionError(error)) = &result {
        if manager.should_reconnect(id).await { let _ = manager.reconnect(id).await; }
        return Err(DbError::ConnectionError(format!("{error}; write completion is unknown and was not retried; verify the database before retrying")));
    }
    if result.is_ok() && ConnectionManager::is_ddl(sql) {
        manager.invalidate_metadata(id).await;
    }
    result
}

pub(super) async fn query(manager: &ConnectionManager, id: &str, sql: &str) -> Result<QueryResult, DbError> {
    super::sql_kind::reject_unscoped_transaction(sql).map_err(DbError::QueryError)?;
    let result = manager.query_inner_cancellable(id, sql).await;
    if let Err(DbError::ConnectionError(_)) = &result {
        if super::sql_kind::parse_one(sql).is_ok_and(|statement| super::sql_kind::is_read_only(&statement))
            && manager.should_reconnect(id).await
            && manager.reconnect(id).await.is_ok() {
                return manager.query_inner_cancellable(id, sql).await;
            }
    }
    result
}

pub(super) async fn query_metadata(manager: &ConnectionManager, id: &str, sql: &str) -> Result<QueryResult, DbError> {
    let result = manager.query_inner(id, sql).await;
    if let Err(DbError::ConnectionError(_)) = &result {
        if manager.should_reconnect(id).await
            && manager.reconnect(id).await.is_ok() {
                return manager.query_inner(id, sql).await;
            }
    }
    result
}

pub(super) async fn query_paged(
    manager: &ConnectionManager,
    id: &str,
    sql: &str,
    limit: u64,
    offset: u64,
) -> Result<PagedQueryResult, DbError> {
    super::sql_kind::reject_unscoped_transaction(sql).map_err(DbError::QueryError)?;
    let cancel = manager.cancel_token(id).await;
    let run = async {
        let result = manager.query_paged_inner(id, sql, limit, offset).await;
        if let Err(DbError::ConnectionError(_)) = &result {
            if super::sql_kind::parse_one(sql).is_ok_and(|statement| super::sql_kind::is_read_only(&statement))
                && manager.should_reconnect(id).await && manager.reconnect(id).await.is_ok() {
                return manager.query_paged_inner(id, sql, limit, offset).await;
            }
        }
        result
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DbError::QueryError("Paged query cancelled".into())),
        result = run => result,
    }
}

pub(super) async fn query_inner_cancellable(manager: &ConnectionManager, id: &str, sql: &str) -> Result<QueryResult, DbError> {
    let cancel = manager.cancel_token(id).await;
    let entry = manager.active_entry(id).await?;
    let connection = entry.connection.read().await;
    // Configurable hard timeout (default 300s, 0 = unlimited) prevents
    // queries from hanging indefinitely
    let timeout_dur = user_query_timeout(&entry.config);
    let timeout = tokio::time::sleep(timeout_dur);
    tokio::pin!(timeout);
    let result = tokio::select! {
        r = connection.query_sql(sql) => r,
        _ = cancel.cancelled() => {
            log::info!("Query cancelled by user for connection '{}'", id);
            Err(DbError::QueryError("Query cancelled".to_string()))
        }
        _ = &mut timeout => {
            log::warn!("Query timed out ({}s) for connection '{}'", timeout_dur.as_secs(), id);
            Err(DbError::Timeout(format!("Query exceeded {}s limit", timeout_dur.as_secs())))
        }
    };
    if result.is_ok() {
        *entry.last_heartbeat.lock().unwrap() = Instant::now();
    }
    result
}

pub(super) async fn query_inner(manager: &ConnectionManager, id: &str, sql: &str) -> Result<QueryResult, DbError> {
    let entry = manager.active_entry(id).await?;
    let connection = entry.connection.read().await;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        connection.query_sql(sql),
    )
    .await
    .map_err(|_| DbError::Timeout("Metadata query exceeded 60s limit".to_string()))?;
    if let Ok(ref _r) = result {
        *entry.last_heartbeat.lock().unwrap() = Instant::now();
    }
    result
}

pub(super) async fn execute_inner(manager: &ConnectionManager, id: &str, sql: &str) -> Result<ExecuteResult, DbError> {
    let cancel = manager.cancel_token(id).await;
    let entry = manager.active_entry(id).await?;
    let connection = entry.connection.read().await;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DbError::QueryError("Write cancellation requested; completion is unknown; verify data before retrying".into())),
        result = tokio::time::timeout(user_query_timeout(&entry.config), connection.execute_sql(sql)) =>
            result.map_err(|_| DbError::Timeout("Write timed out; completion is unknown; verify data before retrying".into()))?,
    };
    if let Ok(ref _r) = result {
        *entry.last_heartbeat.lock().unwrap() = Instant::now();
    }
    result
}

pub(super) async fn query_paged_inner(
    manager: &ConnectionManager,
    id: &str,
    sql: &str,
    limit: u64,
    offset: u64,
) -> Result<PagedQueryResult, DbError> {
    let entry = manager.active_entry(id).await?;
    let connection = entry.connection.read().await;

    // Configurable hard timeout matching the cancellable path; prevents
    // runaway queries from holding a pool connection indefinitely.
    let timeout = user_query_timeout(&entry.config);

    // If the user already specified a LIMIT / TOP / FETCH, execute as-is
    if matches!(connection.db_type(), DatabaseType::MongoDB | DatabaseType::Redis)
        || sql_limiter::has_user_limit(sql) {
        let result = tokio::time::timeout(timeout, connection.query_sql(sql))
            .await
            .map_err(|_| DbError::Timeout(format!("Query exceeded {}s limit", timeout.as_secs())))??;
        return Ok(PagedQueryResult {
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            execution_time_ms: result.execution_time_ms,
            has_more: false,
        });
    }

    // Use streaming paged query that fetches at most limit+1 rows
    let db_type = connection.db_type();
    let modified_sql = if connection.handles_query_pagination() {
        sql.to_owned()
    } else {
        sql_limiter::inject_limit_offset(sql, &db_type, limit + 1, offset)
    };
    let (result, has_more) = tokio::time::timeout(
        timeout,
        connection.query_sql_paged(&modified_sql, limit, offset),
    )
    .await
    .map_err(|_| DbError::Timeout(format!("Query exceeded {}s limit", timeout.as_secs())))??;

    let row_count = result.rows.len() as u64;
    Ok(PagedQueryResult {
        columns: result.columns,
        rows: result.rows,
        row_count,
        execution_time_ms: result.execution_time_ms,
        has_more,
    })
}

pub(super) fn cancel_execution(manager: &ConnectionManager, owner: &str, execution_id: &str) -> bool {
    manager.executions.cancel(owner, execution_id)
}

pub(super) async fn transaction(manager: &ConnectionManager, owner: &str, request: super::transactions::TransactionRequest) -> Result<super::transactions::TransactionResult, DbError> {
    if let super::transactions::TransactionRequest::Begin { id } = request {
        let permit = manager.transactions.reserve()?;
        if !manager.supports_script_sessions(&id).await? {
            return Err(DbError::QueryError("Interactive transactions are unavailable for this connection".into()));
        }
        let entry = manager.active_entry(&id).await?;
        let connection = tokio::time::timeout(Duration::from_secs(10), entry.connection.read()).await
            .map_err(|_| DbError::Timeout("Transaction connection wait exceeded 10s".into()))?;
        if entry.disconnected.load(Ordering::Relaxed) || !Arc::ptr_eq(&entry, &manager.entry(&id).await?) {
            return Err(DbError::ConnectionError("Connection changed while beginning a transaction".into()));
        }
        let session = tokio::time::timeout(Duration::from_secs(10), connection.open_session()).await
            .map_err(|_| DbError::Timeout("Transaction session acquisition exceeded 10s".into()))??;
        manager.transactions.begin(owner, &id, session, user_query_timeout(&entry.config), permit).await
    } else {
        manager.transactions.request(owner, request).await
    }
}

pub(super) async fn insert_rows_bulk(manager: &ConnectionManager, owner: &str, request: &super::bulk::BulkRequest) -> Result<super::bulk::BulkOutcome, DbError> {
    super::bulk::validate(request)?;
    if !manager.supports_script_sessions(&request.id).await? {
        return Err(DbError::QueryError("Parameterized bulk writes are unavailable for this connection".into()));
    }
    let registration = manager.executions.register(owner, &request.execution_id)?;
    let _permit = manager.executions.limits(&request.id).acquire(&registration.cancel).await?;
    let entry = manager.active_entry(&request.id).await?;
    let connection = tokio::select! {
        biased;
        _ = registration.cancel.cancelled() => return Err(DbError::QueryError("Bulk cancelled while awaiting the connection".into())),
        result = tokio::time::timeout(Duration::from_secs(10), entry.connection.read()) =>
            result.map_err(|_| DbError::Timeout("Bulk connection wait exceeded 10s".into()))?,
    };
    let session = tokio::select! {
        biased;
        _ = registration.cancel.cancelled() => return Err(DbError::QueryError("Bulk cancelled before session acquisition".into())),
        result = tokio::time::timeout(Duration::from_secs(10), connection.open_session()) =>
            result.map_err(|_| DbError::Timeout("Bulk session acquisition exceeded 10s".into()))??,
    };
    super::bulk::run(session, request, registration.cancel.clone(), user_query_timeout(&entry.config)).await
}

pub(super) async fn query_read_only(manager: &ConnectionManager, id: &str, sql: &str, explain: bool) -> Result<QueryResult, DbError> {
    let statement = super::sql_kind::parse_one(sql).map_err(DbError::QueryError)?;
    if !super::sql_kind::is_read_only(&statement) || !manager.supports_script_sessions(id).await? {
        return Err(DbError::QueryError("Database-enforced read-only execution is unavailable for this query or driver".into()));
    }
    let _permit = manager.executions.limits(id).acquire(&tokio_util::sync::CancellationToken::new()).await?;
    let entry = manager.active_entry(id).await?;
    let connection = tokio::time::timeout(Duration::from_secs(10), entry.connection.read()).await
        .map_err(|_| DbError::Timeout("Read-only connection wait exceeded 10s".into()))?;
    let mut session = tokio::time::timeout(Duration::from_secs(10), connection.open_session()).await
        .map_err(|_| DbError::Timeout("Read-only session acquisition timed out".into()))??;
    let result = tokio::time::timeout(user_query_timeout(&entry.config), async {
        session.begin_read_only().await?;
        let text = if explain { format!("EXPLAIN {}", sql) } else { sql.to_string() };
        session.query_preview(&text, 500, 1024 * 1024).await.map(|(result, _)| result)
    }).await.map_err(|_| DbError::Timeout("Read-only query timed out".into())).and_then(|result| result);
    let _ = tokio::time::timeout(Duration::from_secs(5), session.close()).await;
    result
}

pub(super) async fn supports_script_sessions(manager: &ConnectionManager, id: &str) -> Result<bool, DbError> {
    if std::env::var("CRABHUB_SCRIPT_EXECUTION").as_deref() == Ok("0") { return Ok(false); }
    let entry = manager.active_entry(id).await?;
    let supported = entry.connection.read().await.supports_script_sessions();
    Ok(supported)
}

pub(super) async fn connection_capabilities(manager: &ConnectionManager, id: &str) -> Result<super::types::ConnectionCapabilities, DbError> {
    let entry = manager.active_entry(id).await?;
    let connection = entry.connection.read().await;
    let sessions = std::env::var("CRABHUB_SCRIPT_EXECUTION").as_deref() != Ok("0") && connection.supports_script_sessions();
    Ok(super::types::ConnectionCapabilities {
        driver: connection.db_type().capabilities(),
        supports_script_sessions: sessions,
        supports_interactive_transactions: sessions,
    })
}

pub(super) fn acknowledge_execution(manager: &ConnectionManager, owner: &str, execution_id: &str, sequence: usize) -> bool {
    manager.executions.acknowledge(owner, execution_id, sequence)
}

pub(super) fn expect_execution_ack(manager: &ConnectionManager, owner: &str, execution_id: &str, sequence: usize, sender: tokio::sync::oneshot::Sender<()>) -> bool {
    manager.executions.expect_ack(owner, execution_id, sequence, sender)
}

pub(super) async fn execute_script(
    manager: &ConnectionManager,
    owner: &str,
    execution_id: &str,
    id: &str,
    statements: &[String],
    options: &super::execution::ScriptOptions,
) -> Result<super::execution::ScriptOutcome, DbError> {
    let request = super::execution::ScriptRequest { id: id.to_string(), execution_id: execution_id.to_string(), statements: statements.to_vec(), options: options.clone(), mode: super::execution::ExecutionMode::Script, concurrency: 1 };
    manager.execute_script_progress(owner, &request, None).await
}

pub(super) async fn execute_script_progress(
    manager: &ConnectionManager,
    owner: &str,
    request: &super::execution::ScriptRequest,
    progress: Option<&tokio::sync::mpsc::Sender<super::execution::ExecutionDelivery>>,
) -> Result<super::execution::ScriptOutcome, DbError> {
    let super::execution::ScriptRequest { id, execution_id, statements, options, .. } = request;
    if !manager.supports_script_sessions(id).await? {
        return Err(DbError::QueryError("Isolated scripts are disabled or unsupported for this connection".into()));
    }
    super::execution::validate_request(request)?;
    let registration = manager.executions.register(owner, execution_id)?;
    let started = Instant::now();
    let cancel = &registration.cancel;
    if let Some(sender) = progress {
        super::execution::deliver(sender, super::execution::ExecutionUpdate::Started { execution_id: execution_id.clone() }, cancel).await?;
    }
    if request.mode == super::execution::ExecutionMode::Independent {
        let entry = manager.active_entry(id).await?;
        let connection = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(DbError::QueryError("Execution cancelled while awaiting the connection".into())),
            result = tokio::time::timeout(Duration::from_secs(10), entry.connection.read()) =>
                result.map_err(|_| DbError::Timeout("Connection lock wait exceeded 10s".into()))?,
        };
        let mut result = super::execution::run_independent(&**connection, request, cancel.clone(), user_query_timeout(&entry.config), manager.executions.limits(id), progress).await?;
        result.total_ms = started.elapsed().as_millis() as u64;
        return Ok(result);
    }
    let queued = Instant::now();
    let _permit = manager.executions.limits(id).acquire(cancel).await?;
    let queue_ms = queued.elapsed().as_millis() as u64;
    let entry = manager.active_entry(id).await?;
    let acquired = Instant::now();
    let connection = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(DbError::QueryError("Execution cancelled while awaiting the connection".into())),
        connection = tokio::time::timeout(Duration::from_secs(10), entry.connection.read()) =>
            connection.map_err(|_| DbError::Timeout("Connection lock wait exceeded 10s".into()))?,
    };
    let session = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(DbError::QueryError("Execution cancelled before acquiring a session".into())),
        session = tokio::time::timeout(Duration::from_secs(10), connection.open_session()) =>
            session.map_err(|_| DbError::Timeout("Session acquisition exceeded 10s".into()))??,
    };
    let acquire_ms = acquired.elapsed().as_millis() as u64;
    let mut outcome = super::execution::run_script_progress(session, statements, options, cancel.clone(), user_query_timeout(&entry.config), progress.map(|sender| (execution_id.as_str(), sender))).await?;
    outcome.execution_id = Some(execution_id.to_string());
    outcome.queue_ms = Some(queue_ms);
    outcome.acquire_ms = Some(acquire_ms);
    outcome.total_ms = started.elapsed().as_millis() as u64;
    manager.invalidate_metadata(id).await;
    Ok(outcome)
}

pub(super) async fn execute_batch_json(manager: &ConnectionManager, id: &str, statements: &[String]) -> Result<Vec<serde_json::Value>, String> {
    for sql in statements { super::sql_kind::reject_unscoped_transaction(sql)?; }
    use super::types::WirePagedQueryResult;
    let mut results = Vec::with_capacity(statements.len());
    let cancel = manager.cancel_token(id).await;
    let db_type = manager.get_db_type(id).await;
    for sql in statements {
        if cancel.is_cancelled() {
            results.push(serde_json::json!({"type": "error", "message": "Statement was not started: batch cancelled", "executionTimeMs": 0}));
            continue;
        }
        let started = Instant::now();
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            results.push(serde_json::json!({"type": "empty"}));
            continue;
        }
        let upper = trimmed.to_uppercase();
        let is_query = if db_type == Some(DatabaseType::MongoDB) {
            match super::mongo_native::returns_rows(trimmed) {
                Ok(returns_rows) => returns_rows,
                Err(error) => {
                    results.push(serde_json::json!({"type": "error", "message": error.to_string(), "executionTimeMs": started.elapsed().as_millis() as u64}));
                    continue;
                }
            }
        } else if db_type == Some(DatabaseType::Redis) {
            true
        } else { upper.starts_with("SELECT")
            || upper.starts_with("WITH")
            || upper.starts_with("SHOW")
            || upper.starts_with("DESCRIBE")
            || upper.starts_with("EXPLAIN") };
        if is_query {
            match manager.query_paged(id, trimmed, 500, 0).await {
                Ok(r) => results.push(
                    serde_json::to_value(WirePagedQueryResult::from(r)).map_err(|e| e.to_string())?,
                ),
                Err(e) => results.push(serde_json::json!({"type": "error", "message": e.to_string(), "executionTimeMs": started.elapsed().as_millis() as u64})),
            }
        } else {
            match manager.execute(id, trimmed).await {
                Ok(r) => results.push(serde_json::to_value(r).map_err(|e| e.to_string())?),
                Err(e) => results.push(serde_json::json!({"type": "error", "message": e.to_string(), "executionTimeMs": started.elapsed().as_millis() as u64})),
            }
        }
    }
    Ok(results)
}
