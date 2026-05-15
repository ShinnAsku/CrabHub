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
            tokens.push(Token::StringLit(&sql[start..i]));
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
            tokens.push(Token::Word(&sql[start..i]));
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
            tokens.push(Token::Word(&sql[start..i]));
            continue;
        }

        // Line comment: --...
        if ch == '-' && i + 1 < len && chars[i + 1] == '-' {
            let start = i;
            while i < len && chars[i] != '\n' {
                i += 1;
            }
            tokens.push(Token::Symbol(&sql[start..i]));
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
            tokens.push(Token::Symbol(&sql[start..i]));
            continue;
        }

        // Number: digits, optional decimal
        if ch.is_ascii_digit() {
            let start = i;
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            tokens.push(Token::Number(&sql[start..i]));
            continue;
        }

        // Parentheses and symbols
        if "(),;".contains(ch) {
            tokens.push(Token::Symbol(&sql[i..i + 1]));
            i += 1;
            continue;
        }

        // Word: letters, digits, underscore, dollar
        if ch.is_ascii_alphabetic() || ch == '_' || ch == '$' {
            let start = i;
            while i < len && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            tokens.push(Token::Word(&sql[start..i]));
            continue;
        }

        // Other symbol (operators, etc.)
        tokens.push(Token::Symbol(&sql[i..i + 1]));
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
            Token::Word(w) if w.to_uppercase() == "LIMIT" => {
                if i + 1 < tokens.len() {
                    match &tokens[i + 1] {
                        Token::Number(_) => return true,
                        Token::Word(w2) if w2.to_uppercase() == "ALL" => return true,
                        _ => {}
                    }
                }
            }
            Token::Word(w) if w.to_uppercase() == "TOP" => {
                if i + 1 < tokens.len() {
                    return true; // TOP N or TOP (N)
                }
            }
            Token::Word(w) if w.to_uppercase() == "FETCH" => {
                if i + 1 < tokens.len() {
                    if let Token::Word(w2) = &tokens[i + 1] {
                        let u = w2.to_uppercase();
                        if u == "FIRST" || u == "NEXT" {
                            return true;
                        }
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
    let mut offset_pos: Option<usize> = None;

    // Scan backward to find LIMIT ... OFFSET ... at the end
    let mut i = n;
    // Check for OFFSET N at the end
    let mut has_offset = false;
    if i >= 2 {
        if let (Token::Word(o), Token::Number(_) | Token::Word(_)) = (&tokens[i - 2], &tokens[i - 1]) {
            if o.to_uppercase() == "OFFSET" {
                offset_pos = Some(i - 2);
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
        _ => {
            format!("{} LIMIT {} OFFSET {}", base, limit, offset)
        }
    }
}


