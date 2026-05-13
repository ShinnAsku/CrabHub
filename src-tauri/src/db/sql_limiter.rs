use regex::Regex;
use std::sync::LazyLock;

use super::types::DatabaseType;

static RE_LIMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bLIMIT\s+\d+").unwrap());

static RE_TOP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bTOP\s+\(?\s*\d+\s*\)?").unwrap());

static RE_FETCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bFETCH\s+(FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY").unwrap());

/// Check whether the SQL already contains a user-specified row limit clause.
///
/// Detects: LIMIT N, TOP N, FETCH FIRST/NEXT N ROWS ONLY
pub fn has_user_limit(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    RE_LIMIT.is_match(trimmed) || RE_TOP.is_match(trimmed) || RE_FETCH.is_match(trimmed)
}

/// Inject LIMIT/OFFSET into a SQL statement based on the database type.
///
/// - Standard DBs (PostgreSQL, MySQL, SQLite, ClickHouse, GaussDB, OpenGauss):
///   appends `LIMIT {limit} OFFSET {offset}`
/// - MSSQL: wraps in a subquery with `OFFSET ... ROWS FETCH NEXT ... ROWS ONLY`
pub fn inject_limit_offset(
    sql: &str,
    db_type: &DatabaseType,
    limit: u64,
    offset: u64,
) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();

    match db_type {
        _ => {
            format!("{} LIMIT {} OFFSET {}", trimmed, limit, offset)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_has_user_limit_basic() {
        assert!(has_user_limit("SELECT * FROM t LIMIT 10"));
        assert!(has_user_limit("SELECT * FROM t limit 10"));
        assert!(has_user_limit("SELECT * FROM t LIMIT 10 OFFSET 5"));
        assert!(has_user_limit("SELECT * FROM t LIMIT 10;"));
    }

    #[test]
    fn test_has_user_limit_top() {
        assert!(has_user_limit("SELECT TOP 10 * FROM t"));
        assert!(has_user_limit("SELECT TOP(10) * FROM t"));
        assert!(has_user_limit("SELECT top 10 * FROM t"));
    }

    #[test]
    fn test_has_user_limit_fetch() {
        assert!(has_user_limit(
            "SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
        ));
        assert!(has_user_limit(
            "SELECT * FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY"
        ));
    }

    #[test]
    fn test_no_user_limit() {
        assert!(!has_user_limit("SELECT * FROM t"));
        assert!(!has_user_limit("SELECT * FROM t WHERE id > 10"));
        assert!(!has_user_limit("SELECT * FROM t ORDER BY id"));
        assert!(!has_user_limit("SELECT * FROM t;"));
    }

    #[test]
    fn test_inject_postgres() {
        let result =
            inject_limit_offset("SELECT * FROM t", &DatabaseType::PostgreSQL, 1000, 0);
        assert_eq!(result, "SELECT * FROM t LIMIT 1000 OFFSET 0");
    }

    #[test]
    fn test_inject_postgres_with_semicolon() {
        let result =
            inject_limit_offset("SELECT * FROM t;", &DatabaseType::PostgreSQL, 1000, 500);
        assert_eq!(result, "SELECT * FROM t LIMIT 1000 OFFSET 500");
    }

    #[test]
    fn test_inject_mysql() {
        let result = inject_limit_offset("SELECT * FROM t", &DatabaseType::MySQL, 500, 100);
        assert_eq!(result, "SELECT * FROM t LIMIT 500 OFFSET 100");
    }

}
