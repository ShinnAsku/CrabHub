use std::ops::ControlFlow;

use sqlparser::ast::{Expr, Query, SetExpr, Statement, Visit, Visitor};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

pub fn parse_one(sql: &str) -> Result<Statement, String> {
    if sql.len() > 1024 * 1024 {
        return Err("SQL exceeds the 1 MiB statement limit".into());
    }
    let mut statements = Parser::new(&GenericDialect {})
        .with_recursion_limit(64)
        .try_with_sql(sql)
        .map_err(|_| "SQL syntax is not supported by the execution classifier")?
        .parse_statements()
        .map_err(|_| "SQL syntax is not supported by the execution classifier")?;
    if statements.len() != 1 {
        return Err("Exactly one SQL statement is required".into());
    }
    Ok(statements.remove(0))
}

pub fn reject_unscoped_transaction(sql: &str) -> Result<(), String> {
    let parsed = Parser::new(&GenericDialect {}).with_recursion_limit(64)
        .try_with_sql(sql).and_then(|mut parser| parser.parse_statements());
    if parsed.is_ok_and(|statements| statements.iter().any(|statement| matches!(statement,
        Statement::StartTransaction { .. } | Statement::Commit { .. } | Statement::Rollback { .. }
        | Statement::Savepoint { .. } | Statement::ReleaseSavepoint { .. }))) {
        return Err("Transaction control requires an interactive transaction handle or a complete isolated script; no SQL was executed".into());
    }
    Ok(())
}

#[derive(Default)]
struct ReadOnlyVisitor;

impl Visitor for ReadOnlyVisitor {
    type Break = ();

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        if matches!(statement, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if !query.locks.is_empty() || !read_only_body(&query.body) {
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_expr(&mut self, expression: &Expr) -> ControlFlow<()> {
        if let Expr::Function(function) = expression {
            let name = function.name.to_string().to_ascii_lowercase();
            if !matches!(name.as_str(),
                "count" | "sum" | "avg" | "min" | "max" | "coalesce" | "nullif"
                | "lower" | "upper" | "length" | "char_length" | "abs" | "round"
                | "substring" | "substr" | "trim" | "concat" | "cast") {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }
}

fn read_only_body(body: &SetExpr) -> bool {
    match body {
        SetExpr::Select(select) => select.into.is_none(),
        SetExpr::Query(_) | SetExpr::Values(_) => true,
        SetExpr::SetOperation { left, right, .. } => read_only_body(left) && read_only_body(right),
        _ => false,
    }
}

pub fn is_read_only(statement: &Statement) -> bool {
    matches!(statement, Statement::Query(_))
        && statement.visit(&mut ReadOnlyVisitor).is_continue()
}

pub fn returns_rows(statement: &Statement) -> bool {
    match statement {
        Statement::Query(_) | Statement::Explain { .. } | Statement::ExplainTable { .. }
        | Statement::ShowTables { .. } | Statement::ShowColumns { .. }
        | Statement::ShowVariable { .. } | Statement::ShowVariables { .. }
        | Statement::ShowDatabases { .. } | Statement::ShowSchemas { .. }
        | Statement::ShowCreate { .. } => true,
        Statement::Insert(insert) => insert.returning.is_some(),
        Statement::Update { returning, .. } => returning.is_some(),
        Statement::Delete(delete) => delete.returning.is_some(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pooled_execution_rejects_transaction_control_before_any_statement_runs() {
        for sql in ["BEGIN", "/* comment */ COMMIT", "ROLLBACK", "INSERT INTO records VALUES (1); BEGIN", "SAVEPOINT point"] {
            assert!(reject_unscoped_transaction(sql).is_err(), "{sql}");
        }
        assert!(reject_unscoped_transaction("SELECT 'BEGIN; COMMIT'").is_ok());
    }

    #[test]
    fn sql_kind_handles_comments_literals_and_unicode() {
        for sql in ["/* query */ SELECT 42", "SELECT '; DELETE FROM t'", "SELECT '\u{4e2d}\u{6587}'"] {
            assert!(is_read_only(&parse_one(sql).unwrap()));
        }
        assert!(parse_one("SELECT 1; DELETE FROM t").is_err());
    }

    #[test]
    fn sql_kind_does_not_trust_ctes_or_function_names() {
        for sql in [
            "WITH changed AS (DELETE FROM t RETURNING *) SELECT * FROM changed",
            "WITH source AS (SELECT 1) DELETE FROM t",
            "SELECT * INTO new_table FROM old_table",
            "SELECT dangerous_function()",
            "SELECT * FROM t FOR UPDATE",
        ] {
            assert!(!parse_one(sql).is_ok_and(|statement| is_read_only(&statement)), "{sql}");
        }
        assert!(is_read_only(&parse_one("WITH source AS (SELECT 1) SELECT * FROM source").unwrap()));
    }

    #[test]
    fn sql_kind_recognizes_returning_and_transactions() {
        assert!(returns_rows(&parse_one("INSERT INTO t VALUES (1) RETURNING id").unwrap()));
        assert!(!returns_rows(&parse_one("INSERT INTO t VALUES (1)").unwrap()));
        assert!(matches!(parse_one("BEGIN").unwrap(), Statement::StartTransaction { .. }));
        assert!(parse_one("unsupported dialect syntax").is_err());
    }
}
