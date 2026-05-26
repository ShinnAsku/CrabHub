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
        let upper = sql.trim().to_uppercase();

        // Reject multi-statement SQL from the agent (prevents bypass via
        // "SELECT 1; DROP TABLE users;" where only the first statement is benign).
        if sql.trim().contains(';') {
            let without_last = sql.trim().trim_end_matches(';').trim();
            if without_last.contains(';') {
                return SafetyAction::Deny {
                    reason: "Multi-statement SQL is not allowed through the agent".into(),
                };
            }
        }

        // Block DROP without WHERE
        if (upper.contains("DROP TABLE")
            || upper.contains("DROP DATABASE")
            || upper.contains("TRUNCATE"))
            && self.require_confirm_drop
        {
            return SafetyAction::Confirm {
                reason: "此操作将删除数据/表，不可恢复".into(),
            };
        }

        // DDL confirmation
        if (upper.starts_with("CREATE") || upper.starts_with("ALTER")) && self.require_confirm_ddl {
            return SafetyAction::Confirm {
                reason: "此操作将修改数据库结构".into(),
            };
        }

        // DELETE without WHERE is denied
        if upper.starts_with("DELETE") {
            if !upper.contains("WHERE") {
                return SafetyAction::Deny {
                    reason: "DELETE没有WHERE条件，将删除全表数据，已拒绝".into(),
                };
            }
            if self.require_confirm_dml {
                return SafetyAction::Confirm {
                    reason: "此操作将删除数据，请确认".into(),
                };
            }
        }

        // DML confirmation
        if (upper.starts_with("INSERT") || upper.starts_with("UPDATE")) && self.require_confirm_dml
        {
            return SafetyAction::Confirm {
                reason: "此操作将修改数据，请确认".into(),
            };
        }

        SafetyAction::Allow
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
}
