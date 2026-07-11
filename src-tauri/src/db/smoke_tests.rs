//! End-to-end driver smoke tests.
//!
//! - SQLite tests run by default against an in-memory database, with no
//!   external dependencies.
//! - PostgreSQL / MySQL / ClickHouse tests are gated by `#[ignore]` and pick up
//!   connection details from environment variables. Run them explicitly with:
//!
//!     cargo test --lib --features=smoke-network -- --ignored
//!
//!   or without the feature flag:
//!
//!     cargo test --lib -- --ignored smoke_pg
//!
//!   Required env vars per driver:
//!     CRABHUB_SMOKE_PG_URL       postgres://user:pass@host:port/db
//!     CRABHUB_SMOKE_MYSQL_URL    mysql://user:pass@host:port/db
//!     CRABHUB_SMOKE_CH_URL       http://host:8123 (database via CH_DB)
//!     CRABHUB_SMOKE_CH_DB        default database name (optional, defaults to "default")
//!
//! These tests focus on the connect -> simple query -> disconnect contract that
//! every driver in CrabHub must honour. They do NOT exhaustively cover
//! dialect-specific behaviour.

#![cfg(test)]

use super::trait_def::DatabaseConnection;
use super::types::{ConnectionConfig, DatabaseType};

fn base_config(db_type: DatabaseType) -> ConnectionConfig {
    ConnectionConfig {
        id: "smoke".into(),
        name: "smoke".into(),
        db_type,
        host: None,
        port: None,
        username: None,
        password: None,
        database: None,
        ssl_enabled: false,
        keepalive_interval: 60,
        auto_reconnect: false,
        query_timeout_secs: 300,
        ssh_tunnel: None,
        pool_options: None,
    }
}

// ---------------------------------------------------------------------------
// SQLite (in-memory) — always runs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn smoke_sqlite_select_one() {
    let cfg = base_config(DatabaseType::SQLite); // empty host => sqlite::memory:
    let conn = super::sqlite::SQLiteConnection::new(&cfg)
        .await
        .expect("sqlite connect");

    let result = conn
        .query_sql("SELECT 1 AS one, 'hello' AS greeting")
        .await
        .expect("sqlite query");

    assert_eq!(result.row_count, 1, "expected exactly 1 row");
    assert_eq!(result.columns.len(), 2, "expected 2 columns");
    assert_eq!(result.columns[0].name, "one");
    assert_eq!(result.columns[1].name, "greeting");
}

#[tokio::test]
async fn smoke_sqlite_create_insert_select() {
    let cfg = base_config(DatabaseType::SQLite);
    let conn = super::sqlite::SQLiteConnection::new(&cfg)
        .await
        .expect("sqlite connect");

    conn.execute_sql("CREATE TABLE t_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        .await
        .expect("create table");

    let insert = conn
        .execute_sql("INSERT INTO t_smoke (name) VALUES ('alice'), ('bob')")
        .await
        .expect("insert");
    assert_eq!(insert.rows_affected, 2);

    let result = conn
        .query_sql("SELECT id, name FROM t_smoke ORDER BY id")
        .await
        .expect("select");
    assert_eq!(result.row_count, 2);
    assert_eq!(result.rows.len(), 2);
}

#[tokio::test]
async fn smoke_sqlite_invalid_sql_returns_error() {
    let cfg = base_config(DatabaseType::SQLite);
    let conn = super::sqlite::SQLiteConnection::new(&cfg)
        .await
        .expect("sqlite connect");

    let err = conn.query_sql("SELECT * FROM definitely_not_a_table").await;
    assert!(err.is_err(), "expected error for missing table, got {:?}", err);
}

// ---------------------------------------------------------------------------
// PostgreSQL — opt-in via CRABHUB_SMOKE_PG_URL
// ---------------------------------------------------------------------------

fn parse_url(url: &str) -> Option<(String, u16, String, String, String)> {
    // scheme://user:pass@host:port/db
    let no_scheme = url.split_once("://")?.1;
    let (creds, host_db) = no_scheme.split_once('@')?;
    let (user, pass) = creds.split_once(':').unwrap_or((creds, ""));
    let (hostport, db) = host_db.split_once('/').unwrap_or((host_db, ""));
    let (host, port_str) = hostport.split_once(':').unwrap_or((hostport, "0"));
    let port: u16 = port_str.parse().ok()?;
    Some((host.into(), port, user.into(), pass.into(), db.into()))
}

#[tokio::test]
#[ignore = "requires CRABHUB_SMOKE_PG_URL=postgres://user:pass@host:port/db"]
async fn smoke_pg_select_one() {
    let url = std::env::var("CRABHUB_SMOKE_PG_URL").expect("CRABHUB_SMOKE_PG_URL not set");
    let (host, port, user, pass, db) = parse_url(&url).expect("invalid PG URL");

    let mut cfg = base_config(DatabaseType::PostgreSQL);
    cfg.host = Some(host);
    cfg.port = Some(port);
    cfg.username = Some(user);
    cfg.password = Some(pass);
    cfg.database = Some(db);

    let conn = super::postgres::PostgresConnection::new(&cfg)
        .await
        .expect("pg connect");
    let r = conn.query_sql("SELECT 1 AS one").await.expect("pg query");
    assert_eq!(r.row_count, 1);
    assert_eq!(r.columns[0].name, "one");
}

// ---------------------------------------------------------------------------
// MySQL — opt-in via CRABHUB_SMOKE_MYSQL_URL
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires CRABHUB_SMOKE_MYSQL_URL=mysql://user:pass@host:port/db"]
async fn smoke_mysql_select_one() {
    let url = std::env::var("CRABHUB_SMOKE_MYSQL_URL").expect("CRABHUB_SMOKE_MYSQL_URL not set");
    let (host, port, user, pass, db) = parse_url(&url).expect("invalid MySQL URL");

    let mut cfg = base_config(DatabaseType::MySQL);
    cfg.host = Some(host);
    cfg.port = Some(port);
    cfg.username = Some(user);
    cfg.password = Some(pass);
    cfg.database = Some(db);

    let conn = super::mysql::MySqlConnection::new(&cfg)
        .await
        .expect("mysql connect");
    let r = conn.query_sql("SELECT 1 AS one").await.expect("mysql query");
    assert_eq!(r.row_count, 1);
    assert_eq!(r.columns[0].name, "one");
}

// ---------------------------------------------------------------------------
// GaussDB — opt-in via CRABHUB_SMOKE_GAUSS_URL
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires CRABHUB_SMOKE_GAUSS_URL=host:port:user:pass:db"]
async fn smoke_gauss_select_one() {
    let url = std::env::var("CRABHUB_SMOKE_GAUSS_URL").expect("CRABHUB_SMOKE_GAUSS_URL not set");
    let parts: Vec<&str> = url.split(':').collect();
    assert_eq!(parts.len(), 5, "expected host:port:user:pass:db");

    let mut cfg = base_config(DatabaseType::GaussDB);
    cfg.host = Some(parts[0].into());
    cfg.port = Some(parts[1].parse().expect("port"));
    cfg.username = Some(parts[2].into());
    cfg.password = Some(parts[3].into());
    cfg.database = Some(parts[4].into());

    let conn = super::gauss_rs::GaussAsyncConnection::new(&cfg)
        .await
        .expect("gaussdb connect");
    let r = conn.query_sql("SELECT 1 AS one").await.expect("gaussdb query");
    assert_eq!(r.row_count, 1);
    assert_eq!(r.columns[0].name, "one");
}

// ---------------------------------------------------------------------------
// SQLServer — opt-in via CRABHUB_SMOKE_MSSQL_URL
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires CRABHUB_SMOKE_MSSQL_URL=host:port:user:pass:db"]
async fn smoke_mssql_select_one() {
    let url = std::env::var("CRABHUB_SMOKE_MSSQL_URL").expect("CRABHUB_SMOKE_MSSQL_URL not set");
    let parts: Vec<&str> = url.split(':').collect();
    assert_eq!(parts.len(), 5, "expected host:port:user:pass:db");

    let mut cfg = base_config(DatabaseType::SQLServer);
    cfg.host = Some(parts[0].into());
    cfg.port = Some(parts[1].parse().expect("port"));
    cfg.username = Some(parts[2].into());
    cfg.password = Some(parts[3].into());
    cfg.database = Some(parts[4].into());

    let conn = super::sqlserver::SqlServerConnection::new(&cfg)
        .await
        .expect("sqlserver connect");
    let r = conn.query_sql("SELECT 1 AS one").await.expect("sqlserver query");
    assert_eq!(r.row_count, 1);
    assert_eq!(r.columns[0].name, "one");
}

#[tokio::test]
#[ignore = "requires CRABHUB_SMOKE_CH_URL=http://host:8123"]
async fn smoke_clickhouse_select_one() {
    let url = std::env::var("CRABHUB_SMOKE_CH_URL").expect("CRABHUB_SMOKE_CH_URL not set");
    let db = std::env::var("CRABHUB_SMOKE_CH_DB").unwrap_or_else(|_| "default".into());

    // Parse http://host:port
    let no_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(&url);
    let (host, port_str) = no_scheme.split_once(':').unwrap_or((no_scheme, "8123"));
    let port: u16 = port_str.trim_end_matches('/').parse().unwrap_or(8123);

    let mut cfg = base_config(DatabaseType::ClickHouse);
    cfg.host = Some(host.into());
    cfg.port = Some(port);
    cfg.database = Some(db);
    cfg.username = Some(std::env::var("CRABHUB_SMOKE_CH_USER").unwrap_or_else(|_| "default".into()));
    cfg.password = Some(std::env::var("CRABHUB_SMOKE_CH_PASS").unwrap_or_default());

    let conn = super::clickhouse::ClickHouseConnection::new(&cfg)
        .await
        .expect("clickhouse connect");
    let r = conn.query_sql("SELECT 1 AS one").await.expect("clickhouse query");
    assert_eq!(r.row_count, 1);
    assert!(r.columns.iter().any(|c| c.name == "one"));
}
