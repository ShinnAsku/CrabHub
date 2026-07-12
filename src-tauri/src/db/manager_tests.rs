//! ConnectionManager core-path tests.
//!
//! All tests run against SQLite (in-memory or temp file) — no external
//! dependencies. Coverage targets the paths the UI depends on most:
//!
//! - connect / disconnect lifecycle and error surfaces
//! - concurrent query isolation between connections
//! - per-connection cancellation (shared CancellationToken semantics)
//! - configurable query timeout enforcement
//! - paged query boundary conditions (offset past end, limit 0, user LIMIT)
//! - row edit commits (insert / update / delete with type conversion)
//! - metadata TTL cache: serving stale data + DDL / manual invalidation
//! - batch execution with embedded per-statement errors

#![cfg(test)]

use super::manager::ConnectionManager;
use super::types::{ConnectionConfig, DatabaseType, DbError, WhereCondition};
use serde_json::json;
use std::sync::Arc;

/// A CPU-heavy query that runs for many seconds on any machine — used to have
/// something in-flight to cancel or time out. Never allowed to finish.
const HEAVY_SQL: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000000) SELECT count(*) FROM c";

fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        db_type: DatabaseType::SQLite,
        host: if path.is_empty() { None } else { Some(path.into()) },
        port: None,
        username: None,
        password: None,
        database: None,
        ssl_enabled: false,
        keepalive_interval: 0,
        auto_reconnect: false,
        query_timeout_secs: 300,
        ssh_tunnel: None,
        pool_options: None,
    }
}

/// Unique temp-file path so tests never share state accidentally.
fn temp_db_path(tag: &str) -> String {
    let path = std::env::temp_dir().join(format!(
        "crabhub-mgr-test-{}-{}-{}.db",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    path.to_string_lossy().into_owned()
}

async fn connect_memory(m: &ConnectionManager, id: &str) {
    m.connect(sqlite_config(id, "")).await.expect("connect");
}

/// Create a `t(id INTEGER, name TEXT)` table with `n` rows.
async fn seed_rows(m: &ConnectionManager, id: &str, n: usize) {
    m.execute(id, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await
        .expect("create");
    for i in 0..n {
        m.execute(id, &format!("INSERT INTO t VALUES ({}, 'row{}')", i, i))
            .await
            .expect("insert");
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn connect_query_disconnect_lifecycle() {
    let m = ConnectionManager::new();
    connect_memory(&m, "c1").await;

    let r = m.query("c1", "SELECT 1 AS one").await.expect("query");
    assert_eq!(r.row_count, 1);

    // list_connections reflects the live connection without credentials
    let listed = m.list_connections().await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], "c1");
    assert_eq!(listed[0]["dbType"], "sqlite");
    assert_eq!(listed[0]["disconnected"], false);
    assert!(listed[0].get("password").is_none());

    m.disconnect("c1").await.expect("disconnect");

    // Disconnected (auto_reconnect=false): SQL must fail, entry stays listed
    let err = m.query("c1", "SELECT 1").await.unwrap_err();
    assert!(matches!(err, DbError::ConnectionError(_)), "got {err:?}");
    let listed = m.list_connections().await;
    assert_eq!(listed[0]["disconnected"], true);
}

#[tokio::test]
async fn unknown_connection_id_is_not_found() {
    let m = ConnectionManager::new();
    let err = m.query("nope", "SELECT 1").await.unwrap_err();
    assert!(matches!(err, DbError::NotFound(_)), "got {err:?}");
    assert!(m.disconnect("nope").await.is_err());
}

#[tokio::test]
async fn get_databases_sqlite_returns_main() {
    let m = ConnectionManager::new();
    connect_memory(&m, "c1").await;
    assert_eq!(m.get_databases("c1").await.unwrap(), vec!["main".to_string()]);
}

// ---------------------------------------------------------------------------
// Concurrency & cancellation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn concurrent_connections_are_isolated_and_cancel_targets_one() {
    let m = Arc::new(ConnectionManager::new());
    connect_memory(&m, "heavy").await;
    connect_memory(&m, "fast").await;

    // Long-running query on 'heavy'
    let mh = m.clone();
    let heavy = tokio::spawn(async move { mh.query("heavy", HEAVY_SQL).await });

    // Give the heavy query time to actually start
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // 'fast' must be completely unaffected while 'heavy' is grinding
    for i in 0..10 {
        let r = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            m.query("fast", &format!("SELECT {i} AS v")),
        )
        .await
        .expect("fast query must not be blocked by heavy connection")
        .expect("fast query ok");
        assert_eq!(r.row_count, 1);
    }

    // Cancel ONLY the heavy connection
    assert!(m.cancel_query("heavy").await, "expected an in-flight token");
    let heavy_result = tokio::time::timeout(std::time::Duration::from_secs(5), heavy)
        .await
        .expect("cancel must unblock the heavy query promptly")
        .expect("join");
    let err = heavy_result.unwrap_err();
    assert!(
        matches!(&err, DbError::QueryError(msg) if msg.contains("cancelled")),
        "got {err:?}"
    );

    // 'fast' still works after the cancel
    assert!(m.query("fast", "SELECT 1").await.is_ok());
}

#[tokio::test]
async fn cancel_without_inflight_query_returns_false() {
    let m = ConnectionManager::new();
    connect_memory(&m, "c1").await;
    assert!(!m.cancel_query("c1").await);

    // A completed query's token is consumed lazily — cancel after completion
    // must not poison the next query.
    m.query("c1", "SELECT 1").await.unwrap();
    m.cancel_query("c1").await;
    assert!(m.query("c1", "SELECT 2").await.is_ok(), "next query gets a fresh token");
}

#[tokio::test]
async fn query_timeout_is_enforced() {
    let m = ConnectionManager::new();
    let mut cfg = sqlite_config("t1", "");
    cfg.query_timeout_secs = 1;
    m.connect(cfg).await.expect("connect");

    let start = std::time::Instant::now();
    let err = m.query("t1", HEAVY_SQL).await.unwrap_err();
    assert!(matches!(err, DbError::Timeout(_)), "got {err:?}");
    assert!(
        start.elapsed() < std::time::Duration::from_secs(10),
        "timeout must fire near the configured 1s, took {:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn query_timeout_zero_means_unlimited() {
    let m = ConnectionManager::new();
    let mut cfg = sqlite_config("t0", "");
    cfg.query_timeout_secs = 0;
    m.connect(cfg).await.expect("connect");

    // A moderately-sized query must complete rather than instantly time out
    let r = m
        .query(
            "t0",
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000) SELECT count(*) AS n FROM c",
        )
        .await
        .expect("unlimited timeout must not cancel");
    assert_eq!(r.rows[0].get("n").and_then(|v| v.as_i64()), Some(10000), "row = {:?}", r.rows[0]);
}

// ---------------------------------------------------------------------------
// Paged query boundaries
// ---------------------------------------------------------------------------

#[tokio::test]
async fn query_paged_boundaries() {
    let m = ConnectionManager::new();
    connect_memory(&m, "p1").await;
    seed_rows(&m, "p1", 10).await;
    let sql = "SELECT * FROM t ORDER BY id";

    // First page: full page + more available
    let r = m.query_paged("p1", sql, 5, 0).await.unwrap();
    assert_eq!(r.rows.len(), 5);
    assert!(r.has_more);
    assert_eq!(r.rows[0].get("id").and_then(|v| v.as_i64()), Some(0));

    // Last page exactly: full page, nothing after
    let r = m.query_paged("p1", sql, 5, 5).await.unwrap();
    assert_eq!(r.rows.len(), 5);
    assert!(!r.has_more);
    assert_eq!(r.rows[4].get("id").and_then(|v| v.as_i64()), Some(9));

    // Offset at end: empty page
    let r = m.query_paged("p1", sql, 5, 10).await.unwrap();
    assert_eq!(r.rows.len(), 0);
    assert!(!r.has_more);

    // Offset far past end: empty, no error
    let r = m.query_paged("p1", sql, 5, 9999).await.unwrap();
    assert_eq!(r.rows.len(), 0);
    assert!(!r.has_more);

    // Limit larger than the table: everything, no more
    let r = m.query_paged("p1", sql, 100, 0).await.unwrap();
    assert_eq!(r.rows.len(), 10);
    assert!(!r.has_more);

    // Limit 0: degenerate but must not error or claim rows
    let r = m.query_paged("p1", sql, 0, 0).await.unwrap();
    assert_eq!(r.rows.len(), 0);
    assert!(r.has_more, "10 rows exist beyond an empty window");
}

#[tokio::test]
async fn query_paged_respects_user_limit() {
    let m = ConnectionManager::new();
    connect_memory(&m, "p2").await;
    seed_rows(&m, "p2", 10).await;

    // User already wrote LIMIT: run as-is, never inject, never report has_more
    let r = m
        .query_paged("p2", "SELECT * FROM t ORDER BY id LIMIT 3", 500, 0)
        .await
        .unwrap();
    assert_eq!(r.rows.len(), 3);
    assert!(!r.has_more);
}

#[tokio::test]
async fn query_paged_empty_result_set() {
    let m = ConnectionManager::new();
    connect_memory(&m, "p3").await;
    m.execute("p3", "CREATE TABLE empty_t (id INTEGER)").await.unwrap();

    let r = m.query_paged("p3", "SELECT * FROM empty_t", 50, 0).await.unwrap();
    assert_eq!(r.rows.len(), 0);
    assert!(!r.has_more);
    assert!(!r.columns.is_empty(), "column metadata must survive empty results: {:?}", r.columns);
}

// ---------------------------------------------------------------------------
// Row edit commits (insert / update / delete)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn insert_update_delete_roundtrip_with_type_conversion() {
    let m = ConnectionManager::new();
    connect_memory(&m, "e1").await;
    m.execute(
        "e1",
        "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, price REAL, active BOOLEAN, note TEXT)",
    )
    .await
    .unwrap();

    // INSERT covering string-with-quote, unicode, float, bool, NULL
    let inserted = m
        .insert_table_row(
            "e1",
            "items",
            None,
            &[
                ("id".into(), json!(1)),
                ("label".into(), json!("O'Brien 中文 \"quoted\"")),
                ("price".into(), json!(19.99)),
                ("active".into(), json!(true)),
                ("note".into(), serde_json::Value::Null),
            ],
        )
        .await
        .expect("insert");
    assert_eq!(inserted.rows_affected, 1);

    let r = m.query("e1", "SELECT * FROM items").await.unwrap();
    assert_eq!(r.rows[0].get("label").and_then(|v| v.as_str()), Some("O'Brien 中文 \"quoted\""));
    assert_eq!(r.rows[0].get("price").and_then(|v| v.as_f64()), Some(19.99));
    assert!(r.rows[0].get("note").map(|v| v.is_null()).unwrap_or(false), "row = {:?}", r.rows[0]);

    // UPDATE with a WHERE on the primary key; value contains a quote again
    let updated = m
        .update_table_rows(
            "e1",
            "items",
            None,
            &[("label".into(), json!("it's updated")), ("active".into(), json!(false))],
            &[WhereCondition { column: "id".into(), value: json!(1) }],
        )
        .await
        .expect("update");
    assert_eq!(updated.rows_affected, 1);
    let r = m.query("e1", "SELECT label FROM items WHERE id = 1").await.unwrap();
    assert_eq!(r.rows[0].get("label").and_then(|v| v.as_str()), Some("it's updated"));

    // UPDATE matching a NULL column via IS NULL semantics
    let updated = m
        .update_table_rows(
            "e1",
            "items",
            None,
            &[("note".into(), json!("filled"))],
            &[WhereCondition { column: "note".into(), value: serde_json::Value::Null }],
        )
        .await
        .expect("update by null");
    assert_eq!(updated.rows_affected, 1);

    // DELETE with WHERE
    let deleted = m
        .delete_table_rows(
            "e1",
            "items",
            None,
            &[WhereCondition { column: "id".into(), value: json!(1) }],
        )
        .await
        .expect("delete");
    assert_eq!(deleted.rows_affected, 1);
    let r = m.query("e1", "SELECT count(*) AS n FROM items").await.unwrap();
    assert_eq!(r.rows[0].get("n").and_then(|v| v.as_i64()), Some(0));
}

#[tokio::test]
async fn delete_with_empty_where_is_rejected() {
    let m = ConnectionManager::new();
    connect_memory(&m, "e2").await;
    m.execute("e2", "CREATE TABLE t (id INTEGER)").await.unwrap();
    m.execute("e2", "INSERT INTO t VALUES (1)").await.unwrap();

    // Empty WHERE would nuke the whole table — must be refused
    assert!(m.delete_table_rows("e2", "t", None, &[]).await.is_err());
    assert!(m.update_table_rows("e2", "t", None, &[("id".into(), json!(2))], &[]).await.is_err());

    let r = m.query("e2", "SELECT count(*) AS n FROM t").await.unwrap();
    assert_eq!(r.rows[0].get("n").and_then(|v| v.as_i64()), Some(1), "row must survive: {:?}", r.rows[0]);
}

#[tokio::test]
async fn update_where_injection_attempt_stays_literal() {
    let m = ConnectionManager::new();
    connect_memory(&m, "e3").await;
    m.execute("e3", "CREATE TABLE t (id INTEGER, name TEXT)").await.unwrap();
    m.execute("e3", "INSERT INTO t VALUES (1, 'a'), (2, 'b')").await.unwrap();

    // A value crafted to break out of the string must stay a literal
    let updated = m
        .update_table_rows(
            "e3",
            "t",
            None,
            &[("name".into(), json!("x"))],
            &[WhereCondition { column: "name".into(), value: json!("a' OR '1'='1") }],
        )
        .await
        .expect("update runs");
    assert_eq!(updated.rows_affected, 0, "injection must match nothing, not everything");
}

// ---------------------------------------------------------------------------
// Metadata cache
// ---------------------------------------------------------------------------

#[tokio::test]
async fn metadata_cache_invalidated_by_ddl_through_manager() {
    let m = ConnectionManager::new();
    connect_memory(&m, "m1").await;
    m.execute("m1", "CREATE TABLE first_t (id INTEGER)").await.unwrap();

    let tables = m.get_tables("m1").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "first_t"));

    // DDL via manager.execute must invalidate the cached table list
    m.execute("m1", "CREATE TABLE second_t (id INTEGER)").await.unwrap();
    let tables = m.get_tables("m1").await.unwrap();
    assert!(
        tables.iter().any(|t| t.name == "second_t"),
        "cache must be refreshed after DDL, got: {:?}",
        tables.iter().map(|t| &t.name).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn metadata_cache_serves_stale_until_manual_invalidation() {
    // Two managers on the SAME database file: manager A caches, an external
    // writer (manager B) changes structure behind A's back.
    let path = temp_db_path("stale");
    let a = ConnectionManager::new();
    let b = ConnectionManager::new();
    a.connect(sqlite_config("a", &path)).await.unwrap();
    b.connect(sqlite_config("b", &path)).await.unwrap();

    a.execute("a", "CREATE TABLE seen_t (id INTEGER)").await.unwrap();
    let tables = a.get_tables("a").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "seen_t"));

    // External DDL — manager A knows nothing about it
    b.execute("b", "CREATE TABLE hidden_t (id INTEGER)").await.unwrap();

    // Within the TTL the stale list is served (this is the cache working)
    let tables = a.get_tables("a").await.unwrap();
    assert!(
        !tables.iter().any(|t| t.name == "hidden_t"),
        "expected cached (stale) table list within TTL"
    );

    // Manual refresh drops the cache and the new table appears
    a.invalidate_metadata("a").await;
    let tables = a.get_tables("a").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "hidden_t"));

    a.disconnect("a").await.ok();
    b.disconnect("b").await.ok();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn get_columns_reflects_ddl() {
    let m = ConnectionManager::new();
    connect_memory(&m, "m2").await;
    m.execute("m2", "CREATE TABLE c_t (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();

    let cols = m.get_columns("m2", "c_t", None).await.unwrap();
    assert_eq!(cols.len(), 2);
    assert!(cols.iter().any(|c| c.name == "id" && c.is_primary_key));

    // ALTER invalidates the cached column list
    m.execute("m2", "ALTER TABLE c_t ADD COLUMN extra TEXT").await.unwrap();
    let cols = m.get_columns("m2", "c_t", None).await.unwrap();
    assert_eq!(cols.len(), 3, "new column must be visible after ALTER");
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

#[tokio::test]
async fn execute_batch_embeds_errors_without_aborting() {
    let m = ConnectionManager::new();
    connect_memory(&m, "b1").await;

    let statements = vec![
        "CREATE TABLE bt (id INTEGER)".to_string(),
        "INSERT INTO bt VALUES (1)".to_string(),
        "SELECT * FROM no_such_table".to_string(), // fails
        "SELECT count(*) AS n FROM bt".to_string(), // must still run
        "   ".to_string(),                          // empty
    ];
    let results = m.execute_batch_json("b1", &statements).await.expect("batch");
    assert_eq!(results.len(), 5);
    assert_eq!(results[2]["type"], "error", "failure is embedded");
    assert!(results[3]["rows"].is_array(), "statement after the failure still ran");
    assert_eq!(results[4]["type"], "empty");
}
