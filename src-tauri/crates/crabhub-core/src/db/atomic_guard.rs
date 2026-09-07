use super::types::DbError;

fn relations(statements: &[String]) -> Result<Vec<(Option<String>, String)>, DbError> {
    use sqlparser::ast::{visit_relations, ObjectNamePart};
    use std::ops::ControlFlow;
    let mut tables = std::collections::BTreeSet::new();
    for text in statements {
        let statement = super::sql_kind::parse_one(text).map_err(DbError::QueryError)?;
        let result = visit_relations(&statement, |name| {
            let parts: Option<Vec<_>> = name.0.iter().map(|part| match part {
                ObjectNamePart::Identifier(identifier) => Some(identifier.value.clone()),
                _ => None,
            }).collect();
            match parts.as_deref() {
                Some([table]) => { tables.insert((None, table.clone())); }
                Some([schema, table]) => { tables.insert((Some(schema.clone()), table.clone())); }
                _ => return ControlFlow::Break(()),
            }
            ControlFlow::Continue(())
        });
        if result.is_break() { return Err(DbError::QueryError("Atomic MySQL scripts require static one- or two-part table names".into())); }
    }
    Ok(tables.into_iter().collect())
}

pub(crate) async fn mysql(connection: &mut sqlx::MySqlConnection, statements: &[String]) -> Result<(), DbError> {
    for (schema, table) in relations(statements)? {
        mysql_table(connection, schema.as_deref(), &table).await?;
    }
    Ok(())
}

pub(crate) async fn mysql_table(connection: &mut sqlx::MySqlConnection, schema: Option<&str>, table: &str) -> Result<(), DbError> {
    let engine: Option<String> = sqlx::query_scalar("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?")
        .bind(schema).bind(table).fetch_optional(&mut *connection).await.map_err(super::session::sqlx_error)?;
    let triggers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = COALESCE(?, DATABASE()) AND EVENT_OBJECT_TABLE = ?")
        .bind(schema).bind(table).fetch_one(&mut *connection).await.map_err(super::session::sqlx_error)?;
    if !engine.is_some_and(|engine| engine.eq_ignore_ascii_case("InnoDB")) || triggers != 0 {
        return Err(DbError::QueryError("Atomic MySQL scripts and bulk writes require visible InnoDB tables without triggers; views, temporary tables and unresolved CTE relations are unsupported".into()));
    }
    Ok(())
}

pub(crate) async fn postgres(_: &mut sqlx::PgConnection, _: &[String]) -> Result<(), DbError> { Ok(()) }
pub(crate) async fn sqlite(_: &mut sqlx::SqliteConnection, _: &[String]) -> Result<(), DbError> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_dml_targets_and_joined_relations_without_losing_quotes() {
        let sql = ["INSERT INTO `odd.name` VALUES (1)", "UPDATE records SET id = 2", "DELETE FROM records", "SELECT * FROM app.records JOIN other ON other.id = records.id"];
        let tables = relations(&sql.map(String::from)).unwrap();
        assert!(tables.contains(&(None, "odd.name".into())));
        assert!(tables.contains(&(None, "records".into())));
        assert!(tables.contains(&(Some("app".into()), "records".into())));
        assert!(tables.contains(&(None, "other".into())));
    }
}