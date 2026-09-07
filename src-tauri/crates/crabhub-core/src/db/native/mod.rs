mod dameng;
mod gbase;
mod oracle;
mod relational;
mod yashan;

use super::types::{ColumnInfo, ConnectionConfig, DatabaseType, DbError, QueryResult};
use serde_json::{Map, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};

pub const MAX_ROWS: usize = 20_000;
pub const MAX_CELL_BYTES: usize = 1024 * 1024;
pub const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;
static WORKERS: Semaphore = Semaphore::const_new(16);

pub struct NativeConnection {
    pub(super) config: ConnectionConfig,
    worker: Mutex<Option<Worker>>,
    closed: tokio_util::sync::CancellationToken,
}

struct Worker {
    sender: mpsc::Sender<Request>,
    abandoned: Arc<AtomicBool>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.abandoned.store(true, Ordering::Release);
    }
}

pub(super) struct Request {
    sql: String,
    params: Vec<Value>,
    window: Option<(usize, usize)>,
    catalog: Option<Catalog>,
    response: oneshot::Sender<Result<QueryResult, DbError>>,
}

pub(super) enum Catalog {
    Tables { schema: Option<String>, views: bool },
    Columns { table: String, schema: String },
    PrimaryKeys { table: String, schema: String },
    ForeignKeys { table: String, schema: String },
}

trait NativeClient {
    fn run(&mut self, request: &Request) -> Result<QueryResult, DbError>;
}

impl NativeConnection {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, DbError> {
        if config.ssl_enabled {
            return Err(DbError::ConfigError(
                "Native TLS is not configured for this vendor; refusing an unverified connection"
                    .into(),
            ));
        }
        let permit = WORKERS.try_acquire().map_err(|_| DbError::ConfigError("Native connection limit (16) reached; a timed-out vendor call may still be running".into()))?;
        let config = config.clone();
        let worker_config = config.clone();
        let (sender, mut receiver) = mpsc::channel::<Request>(1);
        let (ready, readiness) = oneshot::channel();
        let abandoned = Arc::new(AtomicBool::new(false));
        let stopped = abandoned.clone();
        let worker = Worker { sender, abandoned };
        std::thread::Builder::new()
            .name(format!("crabhub-{}", config.db_type))
            .spawn(move || {
                let _permit = permit;
                let connected: Result<Box<dyn NativeClient>, DbError> = match worker_config.db_type
                {
                    DatabaseType::Oracle => oracle::Client::connect(&worker_config)
                        .map(|client| Box::new(client) as Box<dyn NativeClient>),
                    DatabaseType::YashanDB => yashan::Client::connect(&worker_config)
                        .map(|client| Box::new(client) as Box<dyn NativeClient>),
                    DatabaseType::DaMeng => dameng::Client::connect(&worker_config)
                        .map(|client| Box::new(client) as Box<dyn NativeClient>),
                    DatabaseType::GBase => gbase::Client::connect(&worker_config)
                        .map(|client| Box::new(client) as Box<dyn NativeClient>),
                    _ => Err(DbError::ConfigError(
                        "Native adapter is not registered".into(),
                    )),
                };
                let mut client = match connected {
                    Ok(client) => {
                        if ready.send(Ok(())).is_err() {
                            return;
                        }
                        client
                    }
                    Err(error) => {
                        let _ = ready.send(Err(redact(error, &worker_config)));
                        return;
                    }
                };
                while let Some(request) = receiver.blocking_recv() {
                    if stopped.load(Ordering::Acquire) || request.response.is_closed() {
                        break;
                    }
                    let result = client.run(&request);
                    if request.response.send(result).is_err() || stopped.load(Ordering::Acquire) {
                        break;
                    }
                }
            })
            .map_err(|error| DbError::Internal(error.to_string()))?;
        tokio::time::timeout(Duration::from_secs(30), readiness)
            .await
            .map_err(|_| {
                DbError::Timeout(
                    "Native login timed out; the worker is isolated until its native call finishes"
                        .into(),
                )
            })?
            .map_err(|_| DbError::ConnectionError("Native login worker stopped".into()))??;
        Ok(Self {
            config,
            worker: Mutex::new(Some(worker)),
            closed: tokio_util::sync::CancellationToken::new(),
        })
    }

    pub async fn run(
        &self,
        sql: &str,
        params: Vec<Value>,
        window: Option<(usize, usize)>,
    ) -> Result<QueryResult, DbError> {
        self.dispatch(sql, params, window, None).await
    }

    async fn catalog(&self, catalog: Catalog) -> Result<QueryResult, DbError> {
        let result = self
            .dispatch("", vec![], Some((MAX_ROWS + 1, 0)), Some(catalog))
            .await?;
        if result.rows.len() > MAX_ROWS {
            return Err(native_error("Native catalog exceeds 20,000 entries"));
        }
        Ok(result)
    }

    async fn dispatch(
        &self,
        sql: &str,
        params: Vec<Value>,
        window: Option<(usize, usize)>,
        catalog: Option<Catalog>,
    ) -> Result<QueryResult, DbError> {
        if sql.len() > MAX_CELL_BYTES
            || params.len() > 999
            || serde_json::to_vec(&params).map_err(native_error)?.len() > MAX_RESULT_BYTES
        {
            return Err(DbError::ConfigError(
                "Native request exceeds the size limit".into(),
            ));
        }
        if let Some((limit, offset)) = window {
            if limit == 0 || limit > MAX_ROWS + 1 || offset > i32::MAX as usize {
                return Err(DbError::ConfigError("Invalid native query page".into()));
            }
        }
        let mut slot = self.worker.lock().await;
        if self.closed.is_cancelled() {
            return Err(native_error("Native session is closed"));
        }
        let worker = slot.take().ok_or_else(|| DbError::QueryError("Native session is closed or its result is unknown; reconnect explicitly and verify writes before retrying".into()))?;
        let (response, received) = oneshot::channel();
        worker
            .sender
            .send(Request {
                sql: sql.into(),
                params,
                window,
                catalog,
                response,
            })
            .await
            .map_err(|_| {
                DbError::QueryError("Native worker stopped; request was not sent".into())
            })?;
        let received = tokio::select! {
            biased;
            _ = self.closed.cancelled() => return Err(native_error("Native connection closed; in-flight completion is unknown, request NOT retried")),
            received = async {
                if self.config.query_timeout_secs == 0 { Ok(received.await) }
                else { tokio::time::timeout(Duration::from_secs(self.config.query_timeout_secs.saturating_add(5)), received).await }
            } => received.map_err(|_| DbError::Timeout("Native request timed out; completion is unknown, session isolated, request NOT retried".into()))?,
        };
        let result = received.map_err(|_| {
            DbError::QueryError(
                "Native worker stopped; completion is unknown; request NOT retried".into(),
            )
        })?;
        *slot = Some(worker);
        result.map_err(|error| redact(error, &self.config))
    }

    pub async fn shutdown(&self) {
        self.closed.cancel();
        self.worker.lock().await.take();
    }
}

fn redact(error: DbError, config: &ConnectionConfig) -> DbError {
    let message = error.to_string();
    let message = config
        .password
        .as_deref()
        .filter(|password| !password.is_empty())
        .map_or_else(
            || message.clone(),
            |password| message.replace(password, "[redacted]"),
        );
    match error {
        DbError::ConfigError(_) => DbError::ConfigError(message),
        DbError::Timeout(_) => DbError::Timeout(message),
        _ => DbError::QueryError(message),
    }
}

pub(super) fn native_error(error: impl std::fmt::Display) -> DbError {
    DbError::QueryError(error.to_string())
}

pub(super) fn column(name: String, data_type: String, nullable: bool) -> ColumnInfo {
    ColumnInfo {
        name,
        data_type,
        nullable,
        is_primary_key: false,
        default_value: None,
        comment: None,
        character_maximum_length: None,
        numeric_precision: None,
        numeric_scale: None,
    }
}

pub(super) fn unique_columns(columns: &mut [ColumnInfo]) {
    let mut names = std::collections::HashSet::new();
    for column in columns {
        let original = column.name.clone();
        let mut suffix = 2;
        while !names.insert(column.name.clone()) {
            column.name = format!("{original}_{suffix}");
            suffix += 1;
        }
    }
}

pub(super) fn append_row(
    result: &mut QueryResult,
    values: Vec<Value>,
    bytes: &mut usize,
) -> Result<(), DbError> {
    if values.len() != result.columns.len() {
        return Err(native_error("Native column/value count mismatch"));
    }
    for value in &values {
        if let Value::String(text) = value {
            if text.len() > MAX_CELL_BYTES {
                return Err(native_error(
                    "Native value exceeds 1 MiB; select a smaller projection",
                ));
            }
        }
    }
    let row: Map<String, Value> = result
        .columns
        .iter()
        .zip(values)
        .map(|(column, value)| (column.name.clone(), value))
        .collect();
    *bytes += serde_json::to_vec(&row).map_err(native_error)?.len();
    if *bytes > MAX_RESULT_BYTES {
        return Err(native_error(
            "Native result exceeds 16 MiB; use pagination or a smaller projection",
        ));
    }
    result.rows.push(row);
    result.row_count = result.rows.len() as u64;
    Ok(())
}

pub(super) fn empty_result(start: Instant) -> QueryResult {
    QueryResult {
        columns: vec![],
        rows: vec![],
        row_count: 0,
        execution_time_ms: start.elapsed().as_millis() as u64,
    }
}

pub(super) fn host(config: &ConnectionConfig) -> Result<String, DbError> {
    let host = config.host.as_deref().unwrap_or("localhost");
    if host.is_empty()
        || !host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-:[]".contains(character))
    {
        return Err(DbError::ConfigError(
            "Invalid native database hostname".into(),
        ));
    }
    Ok(if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.into()
    })
}

pub fn use_jdbc(kind: &DatabaseType) -> Result<bool, DbError> {
    let selected = std::env::var("CRABHUB_JDBC_DATABASES").unwrap_or_default();
    let selected: Vec<&str> = selected
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    if selected
        .iter()
        .any(|name| !["oracle", "dameng", "yashandb", "gbase"].contains(name))
    {
        return Err(DbError::ConfigError("CRABHUB_JDBC_DATABASES must be a comma-separated subset of oracle,dameng,yashandb,gbase".into()));
    }
    Ok(selected.contains(&kind.to_string().as_str()))
}
