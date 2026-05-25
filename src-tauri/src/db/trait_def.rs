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

/// Escape a SQL identifier (table name, column name, schema name) for safe interpolation.
/// Uses double-quote escaping for PostgreSQL/GaussDB/SQLite and backtick for MySQL/ClickHouse.
pub fn escape_identifier(ident: &str, db_type: &crate::db::types::DatabaseType) -> String {
    match db_type {
        crate::db::types::DatabaseType::MySQL | crate::db::types::DatabaseType::ClickHouse => {
            format!("`{}`", ident.replace('`', "``"))
        }
        _ => {
            format!("\"{}\"", ident.replace('"', "\"\""))
        }
    }
}

/// Validate and sanitize a WHERE clause used in row-level UPDATE/DELETE operations.
///
/// DEPRECATED: kept only for any legacy callers. New code MUST go through
/// `build_where_sql` with structured `WhereCondition`s — the IPC boundary no
/// longer accepts raw WHERE strings.
#[allow(dead_code)]
pub fn sanitize_where_clause(where_clause: &str) -> Result<&str, String> {
    let trimmed = where_clause.trim();
    if trimmed.is_empty() {
        return Err("WHERE clause cannot be empty (would affect all rows)".to_string());
    }
    if trimmed.len() > 4096 {
        return Err("WHERE clause is too long".to_string());
    }

    let upper = trimmed.to_uppercase();

    // Block characters / sequences that have no business in a simple row-key WHERE.
    // NOTE: parentheses are blocked to defeat subqueries and function calls.
    let dangerous_chars = [';', '(', ')'];
    for c in dangerous_chars {
        if trimmed.contains(c) {
            return Err(format!(
                "Unsafe WHERE clause: contains '{}'. Only simple comparison expressions (col = value [AND ...]) are allowed.",
                c
            ));
        }
    }

    // Keywords / tokens that indicate injection or complex queries.
    // Surrounding spaces avoid false positives inside identifiers/values (e.g. `ORDER`).
    let dangerous_tokens: &[&str] = &[
        " OR ", " UNION ", " SELECT ", " INSERT ", " UPDATE ", " DELETE ",
        " DROP ", " TRUNCATE ", " ALTER ", " CREATE ", " EXEC ", " EXECUTE ",
        " GRANT ", " REVOKE ", " SHUTDOWN ", " INTO ", " CASE ", " WHEN ",
        " SLEEP", " PG_SLEEP", " BENCHMARK", " LOAD_FILE", " XP_", " CHAR ",
        " CONCAT ", " WAITFOR ",
    ];
    // Pad with spaces so the first/last token also matches.
    let padded = format!(" {} ", upper);
    for token in dangerous_tokens {
        if padded.contains(token) {
            return Err(format!(
                "Unsafe WHERE clause: contains '{}'. Only simple comparison expressions are allowed.",
                token.trim()
            ));
        }
    }

    // Comment markers anywhere in the string.
    for marker in ["--", "/*", "*/", "#"] {
        if trimmed.contains(marker) {
            return Err(format!(
                "Unsafe WHERE clause: contains comment marker '{}'.",
                marker
            ));
        }
    }

    // Hex literals like 0x41 are commonly used to bypass keyword filters.
    if upper.contains(" 0X") || upper.starts_with("0X") {
        return Err("Unsafe WHERE clause: hex literals are not allowed.".to_string());
    }

    // Quote balance check (single quotes; doubled '' for SQL-escape are OK).
    let stripped = trimmed.replace("''", "");
    if stripped.matches('\'').count() % 2 != 0 {
        return Err("Unsafe WHERE clause: unbalanced single quote.".to_string());
    }

    Ok(where_clause)
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
mod sanitize_tests {
    use super::{build_where_sql, sanitize_where_clause};
    use crate::db::types::WhereCondition;
    use serde_json::json;

    #[test]
    fn accepts_simple_eq() {
        assert!(sanitize_where_clause("id = 1").is_ok());
        assert!(sanitize_where_clause("\"id\" = 1 AND \"name\" = 'bob'").is_ok());
        assert!(sanitize_where_clause("name = 'O''Brien'").is_ok());
    }

    #[test]
    fn rejects_empty() {
        assert!(sanitize_where_clause("").is_err());
        assert!(sanitize_where_clause("   ").is_err());
    }

    #[test]
    fn rejects_or_injection() {
        assert!(sanitize_where_clause("id = 1 OR '1'='1'").is_err());
        assert!(sanitize_where_clause("id = 1 or 1=1").is_err());
    }

    #[test]
    fn rejects_subquery() {
        assert!(sanitize_where_clause("id IN (SELECT password FROM users)").is_err());
        assert!(sanitize_where_clause("id = (SELECT 1)").is_err());
    }

    #[test]
    fn rejects_stacked_statements() {
        assert!(sanitize_where_clause("id = 1; DROP TABLE users").is_err());
    }

    #[test]
    fn rejects_comments() {
        assert!(sanitize_where_clause("id = 1 -- comment").is_err());
        assert!(sanitize_where_clause("id = 1 /* x */").is_err());
        assert!(sanitize_where_clause("id = 1 # mysql comment").is_err());
    }

    #[test]
    fn rejects_unbalanced_quote() {
        assert!(sanitize_where_clause("name = 'bob").is_err());
    }

    #[test]
    fn rejects_hex_literal_bypass() {
        assert!(sanitize_where_clause("name = 0x41424344").is_err());
    }

    #[test]
    fn rejects_dangerous_functions() {
        assert!(sanitize_where_clause("id = SLEEP 5").is_err());
        assert!(sanitize_where_clause("id = BENCHMARK 1000000").is_err());
    }

    // --- build_where_sql (the new structured API) ---

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
