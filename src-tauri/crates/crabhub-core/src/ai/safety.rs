use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub enum SafetyAction {
    Allow,
    Confirm { reason: String },
    Deny { reason: String },
}

#[derive(Debug, Clone)]
pub struct SafetyGate {
    pub require_confirm_ddl: bool,
    pub require_confirm_dml: bool,
    pub require_confirm_drop: bool,
}

impl Default for SafetyGate {
    fn default() -> Self {
        Self {
            require_confirm_ddl: true,
            require_confirm_dml: true,
            require_confirm_drop: true,
        }
    }
}

impl SafetyGate {
    /// Evaluate a SQL statement for safety
    pub fn evaluate(&self, sql: &str) -> SafetyAction {
        use crate::db::sql_kind::{is_read_only, parse_one};
        use sqlparser::ast::Statement;

        let statement = match parse_one(sql) {
            Ok(statement) => statement,
            Err(reason) => return SafetyAction::Deny { reason },
        };
        if is_read_only(&statement) {
            return SafetyAction::Allow;
        }
        let requires_confirmation = match &statement {
            Statement::Delete(delete) if delete.selection.is_none() => {
                return SafetyAction::Deny {
                    reason: "DELETE without a WHERE clause is not allowed through the agent".into(),
                };
            }
            Statement::Drop { .. } | Statement::Truncate { .. } => self.require_confirm_drop,
            Statement::CreateTable(_) | Statement::CreateIndex(_)
            | Statement::CreateView { .. } | Statement::AlterTable { .. } => self.require_confirm_ddl,
            Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_) => self.require_confirm_dml,
            Statement::Query(_) => true,
            _ => return SafetyAction::Deny {
                reason: "This statement is not supported for automatic agent execution".into(),
            },
        };
        if requires_confirmation {
            SafetyAction::Confirm { reason: "SQL may change data or session state; explicit approval is required".into() }
        } else {
            SafetyAction::Allow
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> SafetyGate { SafetyGate::default() }

    #[test]
    fn allows_select() {
        assert!(matches!(gate().evaluate("SELECT * FROM users"), SafetyAction::Allow));
    }

    #[test]
    fn denies_multi_statement() {
        let r = gate().evaluate("SELECT 1; DROP TABLE users;");
        assert!(matches!(r, SafetyAction::Deny { .. }));
    }

    #[test]
    fn allows_single_statement_with_trailing_semicolon() {
        assert!(matches!(gate().evaluate("SELECT 1;"), SafetyAction::Allow));
    }

    #[test]
    fn confirms_drop_table() {
        let r = gate().evaluate("DROP TABLE users");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn confirms_truncate() {
        let r = gate().evaluate("TRUNCATE TABLE users");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn denies_delete_without_where() {
        let r = gate().evaluate("DELETE FROM users");
        assert!(matches!(r, SafetyAction::Deny { .. }));
    }

    #[test]
    fn confirms_delete_with_where() {
        let r = gate().evaluate("DELETE FROM users WHERE id = 1");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn confirms_insert() {
        let r = gate().evaluate("INSERT INTO users VALUES (1, 'test')");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn confirms_update() {
        let r = gate().evaluate("UPDATE users SET name = 'x' WHERE id = 1");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn confirms_create_table() {
        let r = gate().evaluate("CREATE TABLE t (id INT)");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn case_insensitive() {
        let r = gate().evaluate("drop table users");
        assert!(matches!(r, SafetyAction::Confirm { .. }));
    }

    #[test]
    fn allows_single_statement_no_semicolons() {
        assert!(matches!(gate().evaluate("SELECT 1"), SafetyAction::Allow));
    }

    #[test]
    fn rejects_commented_unqualified_delete() {
        assert!(matches!(gate().evaluate("/* WHERE id = 1 */ DELETE FROM users"), SafetyAction::Deny { .. }));
    }

    #[test]
    fn does_not_reject_semicolons_inside_literals() {
        assert!(matches!(gate().evaluate("SELECT 'one;two;'"), SafetyAction::Allow));
    }

    #[test]
    fn unclassified_statements_and_write_ctes_are_not_allowed() {
        for sql in ["WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed", "SELECT dangerous_function()", "unknown syntax"] {
            assert!(!matches!(gate().evaluate(sql), SafetyAction::Allow), "{sql}");
        }
    }
}
