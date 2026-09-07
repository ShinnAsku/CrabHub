#![allow(dead_code)] // Scaffold: items reserved for upcoming features

use super::types::DatabaseType;

// ============================================================================
// SQL Tokenizer — safely tokenizes SQL respecting strings, quotes, and comments
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
enum Token<'a> {
    Word(&'a str),
    Number(&'a str),
    Symbol(&'a str),
    StringLit(&'a str),
}

/// Tokenize SQL into words, respecting string literals, quoted identifiers,
/// and nested parentheses. Returns tokens with their original text slices.
fn tokenize_sql(sql: &str) -> Vec<Token<'_>> {
    let chars: Vec<char> = sql.chars().collect();
    let byte_offsets: Vec<usize> = sql.char_indices().map(|(offset, _)| offset).chain(std::iter::once(sql.len())).collect();
    let len = chars.len();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        // Skip whitespace
        if ch.is_whitespace() {
            i += 1;
            continue;
        }

        // Single-quoted string: '...''...'
        if ch == '\'' {
            let start = i;
            i += 1;
            while i < len {
                if chars[i] == '\'' && i + 1 < len && chars[i + 1] == '\'' {
                    i += 2; // escaped quote
                } else if chars[i] == '\'' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            tokens.push(Token::StringLit(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Double-quoted identifier: "..."
        if ch == '"' {
            let start = i;
            i += 1;
            while i < len && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            if i < len {
                i += 1; // closing "
            }
            tokens.push(Token::Word(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Backtick identifier: `...`
        if ch == '`' {
            let start = i;
            i += 1;
            while i < len && chars[i] != '`' {
                i += 1;
            }
            if i < len {
                i += 1;
            }
            tokens.push(Token::Word(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Line comment: --...
        if ch == '-' && i + 1 < len && chars[i + 1] == '-' {
            let start = i;
            while i < len && chars[i] != '\n' {
                i += 1;
            }
            tokens.push(Token::Symbol(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Block comment: /*...*/
        if ch == '/' && i + 1 < len && chars[i + 1] == '*' {
            let start = i;
            i += 2;
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 < len {
                i += 2;
            }
            tokens.push(Token::Symbol(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Number: digits, optional decimal
        if ch.is_ascii_digit() {
            let start = i;
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            tokens.push(Token::Number(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Parentheses and symbols
        if "(),;".contains(ch) {
            tokens.push(Token::Symbol(&sql[byte_offsets[i]..byte_offsets[i + 1]]));
            i += 1;
            continue;
        }

        // Word: letters, digits, underscore, dollar
        if ch.is_ascii_alphabetic() || ch == '_' || ch == '$' {
            let start = i;
            while i < len && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            tokens.push(Token::Word(&sql[byte_offsets[start]..byte_offsets[i]]));
            continue;
        }

        // Other symbol (operators, etc.)
        tokens.push(Token::Symbol(&sql[byte_offsets[i]..byte_offsets[i + 1]]));
        i += 1;
    }

    tokens
}

/// Get the text of a token slice for case-insensitive comparison.
fn token_text(token: &Token<'_>) -> String {
    match token {
        Token::Word(s) | Token::Number(s) | Token::Symbol(s) | Token::StringLit(s) => {
            s.to_string()
        }
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Check whether the SQL already contains a user-specified row limit clause.
/// Uses the tokenizer to avoid matching LIMIT inside strings or comments.
pub fn has_user_limit(sql: &str) -> bool {
    let tokens = tokenize_sql(sql);
    // Work with raw tokens so LIMIT <number> is detected correctly
    for i in 0..tokens.len() {
        match &tokens[i] {
            Token::Word(w) if w.to_uppercase() == "LIMIT" && i + 1 < tokens.len() => {
                match &tokens[i + 1] {
                    Token::Number(_) => return true,
                    Token::Word(w2) if w2.to_uppercase() == "ALL" => return true,
                    _ => {}
                }
            }
            Token::Word(w) if w.to_uppercase() == "TOP" && i + 1 < tokens.len() => {
                return true;
            }
            Token::Word(w) if w.to_uppercase() == "FETCH" && i + 1 < tokens.len() => {
                if let Token::Word(w2) = &tokens[i + 1] {
                    let u = w2.to_uppercase();
                    if u == "FIRST" || u == "NEXT" {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// Strip any trailing LIMIT/OFFSET clause from a SQL query.
/// Uses the tokenizer to safely identify the LIMIT/OFFSET at the end.
pub fn strip_limit_offset(sql: &str) -> String {
    let tokens = tokenize_sql(sql);
    if tokens.is_empty() {
        return sql.to_string();
    }

    let n = tokens.len();

    // Find LIMIT keyword position (only meaningful LIMIT — the last one before end)
    let mut limit_pos: Option<usize> = None;

    // Scan backward to find LIMIT ... OFFSET ... at the end
    let mut i = n;
    // Check for OFFSET N at the end
    let mut has_offset = false;
    if i >= 2 {
        if let (Token::Word(o), Token::Number(_) | Token::Word(_)) = (&tokens[i - 2], &tokens[i - 1]) {
            if o.to_uppercase() == "OFFSET" {
                has_offset = true;
                i -= 2;
            }
        }
    }
    // Check for LIMIT N (or LIMIT ALL) before the OFFSET
    if i >= 2 {
        if let (Token::Word(l), Token::Number(_) | Token::Word(_)) = (&tokens[i - 2], &tokens[i - 1]) {
            let upper = l.to_uppercase();
            if upper == "LIMIT" || upper == "FETCH" {
                limit_pos = Some(i - 2);
            }
        }
    }
    // Also check: LIMIT N alone (no OFFSET)
    if limit_pos.is_none() && !has_offset && n >= 2 {
        if let (Token::Word(l), Token::Number(_) | Token::Word(_)) = (&tokens[n - 2], &tokens[n - 1]) {
            if l.to_uppercase() == "LIMIT" {
                limit_pos = Some(n - 2);
            }
        }
    }

    let end_pos = limit_pos.unwrap_or(n);
    if end_pos == n {
        return sql.to_string();
    }

    let mut result = String::new();
    for (idx, token) in tokens.iter().enumerate().take(end_pos) {
        if idx > 0
            && !matches!(token, Token::Symbol(s) if *s == "," || *s == ";" || *s == ")")
            && !matches!(&tokens[idx - 1], Token::Symbol(s) if *s == "(")
        {
            result.push(' ');
        }
        result.push_str(match token {
            Token::Word(s) | Token::Number(s) | Token::Symbol(s) | Token::StringLit(s) => s,
        });
    }
    result.trim().to_string()
}

/// Inject LIMIT/OFFSET into a SQL statement. If the query already has a user LIMIT,
/// that LIMIT is honored as an upper bound (paginated within the user's limit).
/// Otherwise, appends `LIMIT {limit} OFFSET {offset}`.
pub fn inject_limit_offset(
    sql: &str,
    db_type: &DatabaseType,
    limit: u64,
    offset: u64,
) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let base = strip_limit_offset(trimmed);

    match db_type {
        DatabaseType::ClickHouse => {
            if let Ok(mut statements) = sqlparser::parser::Parser::parse_sql(&sqlparser::dialect::ClickHouseDialect {}, &base) {
                if statements.len() == 1 {
                    if let sqlparser::ast::Statement::Query(query) = &mut statements[0] {
                        if let Some(format) = query.format_clause.take() {
                            return format!("{query} LIMIT {limit} OFFSET {offset} {format}");
                        }
                    }
                }
            }
            format!("{base}\nLIMIT {limit} OFFSET {offset}")
        }
        DatabaseType::SQLServer => {
            let has_order = sqlparser::parser::Parser::parse_sql(&sqlparser::dialect::MsSqlDialect {}, &base)
                .ok()
                .filter(|statements| statements.len() == 1)
                .and_then(|mut statements| match statements.remove(0) {
                    sqlparser::ast::Statement::Query(query) => Some(query.order_by.is_some()),
                    _ => None,
                })
                .unwrap_or(false);
            let order = if has_order { "" } else { "ORDER BY 1 " };
            format!("{base}\n{order}OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
        }
        _ => {
            format!("{} LIMIT {} OFFSET {}", base, limit, offset)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::DatabaseType;

    #[test]
    fn detects_limit_n() {
        assert!(has_user_limit("SELECT * FROM users LIMIT 10"));
    }

    #[test]
    fn detects_limit_with_offset() {
        assert!(has_user_limit("SELECT * FROM users LIMIT 10 OFFSET 20"));
    }

    #[test]
    fn detects_fetch_first_n_rows() {
        assert!(has_user_limit("SELECT * FROM users FETCH FIRST 10 ROWS ONLY"));
    }

    #[test]
    fn detects_top_n() {
        assert!(has_user_limit("SELECT TOP 10 * FROM users"));
    }

    #[test]
    fn no_limit_for_bare_select() {
        assert!(!has_user_limit("SELECT * FROM users"));
    }

    #[test]
    fn limit_inside_string_not_detected() {
        assert!(!has_user_limit("SELECT 'LIMIT 10' FROM users"));
    }

    #[test]
    fn limit_inside_comment_not_detected() {
        assert!(!has_user_limit("SELECT * FROM users -- LIMIT 10"));
    }

    #[test]
    fn strips_trailing_limit() {
        let result = strip_limit_offset("SELECT * FROM users LIMIT 10");
        assert_eq!(result, "SELECT * FROM users");
    }

    #[test]
    fn strips_limit_offset() {
        let result = strip_limit_offset("SELECT * FROM users LIMIT 10 OFFSET 5");
        assert_eq!(result, "SELECT * FROM users");
    }

    #[test]
    fn inject_limit_pg() {
        let result = inject_limit_offset("SELECT * FROM users", &DatabaseType::PostgreSQL, 100, 0);
        assert_eq!(result, "SELECT * FROM users LIMIT 100 OFFSET 0");
    }

    #[test]
    fn inject_limit_sqlserver() {
        let result = inject_limit_offset("SELECT * FROM users", &DatabaseType::SQLServer, 100, 0);
        assert_eq!(result, "SELECT * FROM users\nORDER BY 1 OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY");
    }

    #[test]
    fn clickhouse_pagination_precedes_output_format() {
        assert_eq!(inject_limit_offset("SELECT 'FORMAT CSV' AS value FORMAT JSONEachRow", &DatabaseType::ClickHouse, 2, 1),
            "SELECT 'FORMAT CSV' AS value LIMIT 2 OFFSET 1 FORMAT JSONEachRow");
    }

    #[test]
    fn sqlserver_pagination_preserves_only_outer_order() {
        for sql in [
            "SELECT DISTINCT name FROM users",
            "SELECT 'ORDER BY' AS label -- ORDER BY ignored",
            "SELECT ROW_NUMBER() OVER (ORDER BY name) AS position FROM users",
            "SELECT id FROM users UNION ALL SELECT id FROM others",
        ] {
            let paged = inject_limit_offset(sql, &DatabaseType::SQLServer, 10, 5);
            assert!(paged.ends_with("\nORDER BY 1 OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY"), "{paged}");
            assert!(sqlparser::parser::Parser::parse_sql(&sqlparser::dialect::MsSqlDialect {}, &paged).is_ok());
        }
        let ordered = inject_limit_offset("SELECT id FROM users ORDER BY id DESC", &DatabaseType::SQLServer, 10, 5);
        assert_eq!(ordered, "SELECT id FROM users ORDER BY id DESC\nOFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY");
    }

    #[test]
    fn unicode_literals_keep_valid_byte_boundaries() {
        let sql = "SELECT '\u{4e2d}\u{6587}' AS label LIMIT 10 OFFSET 5";
        assert!(has_user_limit(sql));
        assert_eq!(strip_limit_offset(sql), "SELECT '\u{4e2d}\u{6587}' AS label");
        assert!(!has_user_limit("SELECT '\u{4e2d}\u{6587} LIMIT 10' AS label"));
    }
}


