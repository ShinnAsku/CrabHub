use async_trait::async_trait;

use super::types::{ColumnInfo, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo, WhereCondition};

/// Trait defining the interface for database connections.
/// Each database type implements this trait with its own specific behavior.
#[async_trait]
pub trait DatabaseConnection: Send + Sync {
    // --- Core operations ---
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError>;
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError>;

    /// Streamed query that fetches at most `limit + 1` rows (to detect has_more).
    /// Default impl falls back to fetch_all + truncation.
    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        _offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        let result = self.query_sql(sql).await?;
        let has_more = result.rows.len() as u64 > limit;
        let rows = if has_more {
            result.rows.into_iter().take(limit as usize).collect()
        } else {
            result.rows
        };
        Ok((QueryResult { rows, ..result }, has_more))
    }

    #[allow(dead_code)]
    fn db_type(&self) -> DatabaseType;
    async fn close(&self);

    /// Best-effort SERVER-SIDE cancellation of the currently running query.
    ///
    /// Dropping the query future (client-side cancel) leaves the statement
    /// running on the server and keeps a pool connection busy. Drivers that
    /// can, should ask the server to abort it (pg_cancel_backend, KILL QUERY,
    /// wire-protocol CancelRequest, ...).
    ///
    /// Returns `true` if a cancel request was sent. Implementations must not
    /// error: failures are logged and swallowed (cancel is best-effort).
    async fn cancel_running_query(&self) -> bool {
        false
    }

    // --- Metadata ---
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError>;
    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError>;
    async fn get_schemas(&self) -> Result<Vec<String>, DbError>;
    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError>;
    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError>;
    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError>;
    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError>;

    // --- Data operations ---
    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError>;
    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError>;
    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_conditions: &[WhereCondition],
    ) -> Result<ExecuteResult, DbError>;
    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError>;
    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_conditions: &[WhereCondition],
    ) -> Result<ExecuteResult, DbError>;
}

/// Serialize a JSON value to a SQL literal string
pub fn json_value_to_sql(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        _ => format!("'{}'", val.to_string().replace('\'', "''")),
    }
}

/// Escape a SQL identifier for safe interpolation.
/// Uses bracket for SQLServer, backtick for MySQL/ClickHouse, double-quote for others.
pub fn escape_identifier(ident: &str, db_type: &crate::db::types::DatabaseType) -> String {
    match db_type {
        crate::db::types::DatabaseType::MySQL | crate::db::types::DatabaseType::ClickHouse => {
            format!("`{}`", ident.replace('`', "``"))
        }
        crate::db::types::DatabaseType::SQLServer => {
            format!("[{}]", ident.replace(']', "]]"))
        }
        _ => {
            format!("\"{}\"", ident.replace('"', "\"\""))
        }
    }
}

/// Escape a string value for safe interpolation into a single-quoted SQL literal.
/// Doubles embedded single quotes (SQL standard escaping).
pub fn escape_sql_string(val: &str) -> String {
    val.replace('\'', "''")
}

/// Build a safe `WHERE` SQL fragment from structured conditions.
///
/// Produces `col1 = value1 AND col2 IS NULL AND ...`. Column names are escaped
/// using the caller-supplied identifier quoter; values are rendered via
/// `json_value_to_sql` which doubles single quotes. Because the input shape is
/// `(column, value)` pairs only, callers cannot inject operators, subqueries,
/// or boolean expressions.
///
/// Returns an error if `conditions` is empty (refusing to produce a WHERE that
/// would match every row in the table).
pub fn build_where_sql(
    conditions: &[WhereCondition],
    quote_ident: &dyn Fn(&str) -> String,
) -> Result<String, DbError> {
    if conditions.is_empty() {
        return Err(DbError::QueryError(
            "WHERE conditions are required (refusing to match all rows)".to_string(),
        ));
    }
    let parts: Vec<String> = conditions
        .iter()
        .map(|c| {
            let col = quote_ident(&c.column);
            if c.value.is_null() {
                format!("{} IS NULL", col)
            } else {
                format!("{} = {}", col, json_value_to_sql(&c.value))
            }
        })
        .collect();
    Ok(parts.join(" AND "))
}

/// Sanitize an ORDER BY clause to prevent SQL injection.
/// Only allows column names, optional ASC/DESC/NULLS FIRST/NULLS LAST,
/// comma separation, and safe identifier quoting (double-quotes, backticks).
/// Returns the original string if safe, or an error if dangerous characters are found.
pub fn sanitize_order_by(order_by: &str) -> Result<&str, DbError> {
    // Blocklist approach for order by: reject characters that have no business
    // in a column reference list. Unlike WHERE clauses, ORDER BY is structurally
    // simple — col [ASC|DESC] [NULLS FIRST|LAST], col2 ...
    let dangerous = [
        ';', '\'', '(', ')', '[', ']', '{', '}', '|', '&', '$',
        '%', '^', '<', '>', '=', '!', '~', '\\',
    ];
    for c in dangerous {
        if order_by.contains(c) {
            return Err(DbError::QueryError(format!(
                "Unsafe ORDER BY: contains '{}'", c
            )));
        }
    }
    // Reject SQL keywords that indicate injection attempts
    let upper = order_by.to_uppercase();
    for keyword in &[
        "DROP", "DELETE", "INSERT", "UPDATE", "CREATE", "ALTER",
        "EXEC", "EXECUTE", "UNION", "SELECT", "FROM", "WHERE",
        "HAVING", "INTO", "CASE", "WHEN", "THEN", "ELSE", "END",
        "GRANT", "REVOKE", "TRUNCATE", "SLEEP", "BENCHMARK", "WAITFOR",
        "LIMIT", "OFFSET", "FETCH",
    ] {
        // Use word boundary check: keyword must be a standalone word
        let keyword_padded = format!(" {} ", keyword);
        let upper_padded = format!(" {} ", upper);
        if upper_padded.contains(&keyword_padded) {
            return Err(DbError::QueryError(format!(
                "Unsafe ORDER BY: contains SQL keyword '{}'", keyword
            )));
        }
    }
    // Reject comment markers
    for marker in ["--", "/*", "*/", "#"] {
        if order_by.contains(marker) {
            return Err(DbError::QueryError(format!(
                "Unsafe ORDER BY: contains comment marker '{}'", marker
            )));
        }
    }
    Ok(order_by)
}

#[cfg(test)]
mod where_tests {
    use super::build_where_sql;
    use crate::db::types::WhereCondition;
    use serde_json::json;

    fn dq(s: &str) -> String {
        format!("\"{}\"", s.replace('"', "\"\""))
    }

    #[test]
    fn build_where_sql_basic_eq() {
        let conds = vec![WhereCondition {
            column: "id".into(),
            value: json!(42),
        }];
        assert_eq!(build_where_sql(&conds, &dq).unwrap(), "\"id\" = 42");
    }

    #[test]
    fn build_where_sql_multi_and() {
        let conds = vec![
            WhereCondition { column: "id".into(), value: json!(1) },
            WhereCondition { column: "name".into(), value: json!("bob") },
        ];
        assert_eq!(
            build_where_sql(&conds, &dq).unwrap(),
            "\"id\" = 1 AND \"name\" = 'bob'"
        );
    }

    #[test]
    fn build_where_sql_null_value_uses_is_null() {
        let conds = vec![WhereCondition {
            column: "deleted_at".into(),
            value: serde_json::Value::Null,
        }];
        assert_eq!(build_where_sql(&conds, &dq).unwrap(), "\"deleted_at\" IS NULL");
    }

    #[test]
    fn build_where_sql_escapes_value_quotes() {
        let conds = vec![WhereCondition {
            column: "name".into(),
            value: json!("o'malley"),
        }];
        assert_eq!(
            build_where_sql(&conds, &dq).unwrap(),
            "\"name\" = 'o''malley'"
        );
    }

    #[test]
    fn build_where_sql_escapes_column_quotes() {
        let conds = vec![WhereCondition {
            column: "weird\"col".into(),
            value: json!(1),
        }];
        assert_eq!(
            build_where_sql(&conds, &dq).unwrap(),
            "\"weird\"\"col\" = 1"
        );
    }

    #[test]
    fn build_where_sql_rejects_empty() {
        assert!(build_where_sql(&[], &dq).is_err());
    }

    #[test]
    fn build_where_sql_injection_attempt_is_neutralized() {
        // Even if a malicious column name contains injection payloads, escape_identifier
        // doubles the quotes, and the value goes through json_value_to_sql.
        let conds = vec![WhereCondition {
            column: "id".into(),
            value: json!("1 OR 1=1; DROP TABLE users--"),
        }];
        let sql = build_where_sql(&conds, &dq).unwrap();
        // The payload is a string literal — quotes get doubled, semicolons inert.
        assert_eq!(
            sql,
            "\"id\" = '1 OR 1=1; DROP TABLE users--'"
        );
        // The dangerous keywords are inside a string, not part of SQL syntax.
        assert!(!sql.contains("'; DROP"));
    }
}
