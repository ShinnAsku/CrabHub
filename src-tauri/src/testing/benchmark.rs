//! Benchmark harness for database query performance testing.
//! Measures execution time and approximate memory usage.

use std::sync::Arc;
use std::time::Instant;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkResult {
    pub test_name: String,
    pub query: String,
    pub row_count: u64,
    pub execution_time_ms: u64,
    /// Approximate JSON serialization size in bytes (memory proxy)
    pub json_size_bytes: u64,
    pub rows_per_second: f64,
}

/// Run a single benchmark query and measure its performance.
pub async fn run_benchmark(
    manager: &crate::db::manager::ConnectionManager,
    connection_id: &str,
    sql: &str,
    label: &str,
) -> Result<BenchmarkResult, String> {
    let start = Instant::now();
    let result = manager
        .query(connection_id, sql)
        .await
        .map_err(|e| e.to_string())?;
    let elapsed = start.elapsed().as_millis() as u64;
    let row_count = result.row_count;

    let json_size = serde_json::to_vec(&result.rows)
        .unwrap_or_default()
        .len() as u64;

    let rows_per_second = if elapsed > 0 {
        (row_count as f64 / elapsed as f64) * 1000.0
    } else {
        0.0
    };

    Ok(BenchmarkResult {
        test_name: label.to_string(),
        query: sql.to_string(),
        row_count,
        execution_time_ms: elapsed,
        json_size_bytes: json_size,
        rows_per_second,
    })
}

/// Run a suite of benchmark queries and collect results.
pub async fn run_benchmark_suite(
    manager: &crate::db::manager::ConnectionManager,
    connection_id: &str,
    tests: &[(&str, &str)],
) -> Vec<BenchmarkResult> {
    let mut results = Vec::new();
    for (label, sql) in tests {
        match run_benchmark(manager, connection_id, sql, label).await {
            Ok(result) => results.push(result),
            Err(e) => {
                results.push(BenchmarkResult {
                    test_name: label.to_string(),
                    query: sql.to_string(),
                    row_count: 0,
                    execution_time_ms: 0,
                    json_size_bytes: 0,
                    rows_per_second: 0.0,
                });
            }
        }
    }
    results
}

/// Standard stress test scenarios for database performance validation
pub fn stress_test_scenarios(table_name: &str) -> Vec<(&'static str, String)> {
    vec![
        ("SELECT * (10K rows, LIMIT 1000)", format!("SELECT * FROM {} LIMIT 1000", table_name)),
        ("SELECT * 10K rows", format!("SELECT * FROM {}", table_name)),
        ("COUNT(*)", format!("SELECT COUNT(*) FROM {}", table_name)),
        ("WHERE filter", format!("SELECT * FROM {} WHERE col_1 LIKE 'a%' LIMIT 1000", table_name)),
        ("ORDER BY", format!("SELECT * FROM {} ORDER BY col_0 LIMIT 1000", table_name)),
        ("GROUP BY", format!("SELECT col_0, COUNT(*) FROM {} GROUP BY col_0 LIMIT 100", table_name)),
        ("Paged (offset 5000)", format!("SELECT * FROM {} LIMIT 1000 OFFSET 5000", table_name)),
        ("Paged (offset 50000)", format!("SELECT * FROM {} LIMIT 1000 OFFSET 50000", table_name)),
    ]
}

/// Run concurrent query stress test
pub async fn run_concurrency_stress(
    manager: Arc<crate::db::manager::ConnectionManager>,
    connection_id: &str,
    concurrent: usize,
    sql: &str,
) -> Vec<Result<BenchmarkResult, String>> {
    let mut handles = Vec::new();
    for i in 0..concurrent {
        let mgr = manager.clone();
        let cid = connection_id.to_string();
        let s = sql.to_string();
        let label = format!("concurrent-{}", i);
        handles.push(tokio::spawn(async move {
            run_benchmark(&mgr, &cid, &s, &label).await
        }));
    }
    let mut results = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(_) => {} // task panicked
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stress_scenarios_generate_eight() {
        let scenarios = stress_test_scenarios("test_table");
        assert_eq!(scenarios.len(), 8);
    }
}
