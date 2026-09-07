use sqlx::{ConnectOptions, Connection};
use std::str::FromStr;

pub(crate) enum SessionCancel {
    Sqlite { interrupted: std::sync::Arc<std::sync::atomic::AtomicBool> },
    PostgreSql { connection_string: String, pid: i32, application_name: String },
    MySql { connection_string: String, id: u64 },
}

impl SessionCancel {
    pub fn interrupt_local(&self) {
        if let Self::Sqlite { interrupted } = self { interrupted.store(true, std::sync::atomic::Ordering::Relaxed); }
    }

    pub async fn cancel(&self) -> bool {
        let operation = async {
            match self {
                Self::Sqlite { .. } => { self.interrupt_local(); Some(true) }
                Self::PostgreSql { connection_string, pid, application_name } => {
                    let options = sqlx::postgres::PgConnectOptions::from_str(connection_string).ok()?
                        .application_name("crabhub-control").disable_statement_logging();
                    let mut control = sqlx::PgConnection::connect_with(&options).await.ok()?;
                    sqlx::query_scalar::<_, bool>("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND application_name = $2")
                        .bind(pid).bind(application_name).fetch_optional(&mut control).await.ok().flatten()
                }
                Self::MySql { connection_string, id } => {
                    let options = sqlx::mysql::MySqlConnectOptions::from_str(connection_string).ok()?.disable_statement_logging();
                    let mut control = sqlx::MySqlConnection::connect_with(&options).await.ok()?;
                    sqlx::query(&format!("KILL QUERY {id}")).execute(&mut control).await.ok().map(|_| true)
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), operation).await.ok().flatten().unwrap_or(false)
    }
}

impl Drop for SessionCancel {
    fn drop(&mut self) { self.interrupt_local(); }
}