use super::*;
use crate::db::trait_def::{escape_identifier, sanitize_order_by, DatabaseConnection};
use crate::db::types::{ExecuteResult, TableInfo, WhereCondition};
use async_trait::async_trait;
use serde_json::json;

impl NativeConnection {
    fn quote(&self, value: &str) -> String {
        escape_identifier(value, &self.config.db_type)
    }

    fn qualified(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        if table.is_empty()
            || table.chars().any(char::is_control)
            || schema
                .is_some_and(|schema| schema.is_empty() || schema.chars().any(char::is_control))
        {
            return Err(DbError::ConfigError(
                "Invalid table or schema identifier".into(),
            ));
        }
        Ok(schema
            .map(|schema| format!("{}.{}", self.quote(schema), self.quote(table)))
            .unwrap_or_else(|| self.quote(table)))
    }

    fn owner(&self, schema: Option<&str>) -> String {
        schema.map(str::to_owned).unwrap_or_else(|| {
            if matches!(
                self.config.db_type,
                DatabaseType::DaMeng | DatabaseType::YashanDB
            ) {
                if let Some(schema) = self
                    .config
                    .database
                    .as_ref()
                    .filter(|schema| !schema.is_empty())
                {
                    return schema.clone();
                }
            }
            let username = self.config.username.clone().unwrap_or_default();
            if self.config.db_type == DatabaseType::GBase {
                username
            } else {
                username.to_uppercase()
            }
        })
    }

    fn marker(&self, index: usize) -> String {
        if matches!(
            self.config.db_type,
            DatabaseType::Oracle | DatabaseType::YashanDB
        ) {
            format!(":{index}")
        } else {
            "?".into()
        }
    }

    async fn read(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult, DbError> {
        let result = self.run(sql, params, Some((MAX_ROWS + 1, 0))).await?;
        if result.rows.len() > MAX_ROWS {
            return Err(native_error(
                "Native result exceeds 20,000 rows; use pagination",
            ));
        }
        Ok(result)
    }

    async fn write(&self, sql: &str, params: Vec<Value>) -> Result<ExecuteResult, DbError> {
        let result = self.run(sql, params, None).await?;
        Ok(ExecuteResult {
            rows_affected: result.row_count,
            execution_time_ms: result.execution_time_ms,
        })
    }

    async fn objects(&self, schema: Option<&str>, views: bool) -> Result<Vec<TableInfo>, DbError> {
        let result = if self.config.db_type == DatabaseType::GBase {
            self.catalog(Catalog::Tables {
                schema: schema.map(str::to_owned),
                views,
            })
            .await?
        } else {
            let (name, catalog) = if views {
                ("VIEW_NAME", "ALL_VIEWS")
            } else {
                ("TABLE_NAME", "ALL_TABLES")
            };
            let filter = schema
                .map(|_| format!(" WHERE OWNER = {}", self.marker(1)))
                .unwrap_or_default();
            self.read(&format!("SELECT {name} AS \"name\", OWNER AS \"schema\" FROM {catalog}{filter} ORDER BY OWNER, {name}"), schema.map(|schema| vec![json!(schema)]).unwrap_or_default()).await?
        };
        result
            .rows
            .iter()
            .map(|row| {
                let odbc = self.config.db_type == DatabaseType::GBase;
                let name = required(row, if odbc { "TABLE_NAME" } else { "name" })?;
                let schema = text(row, if odbc { "TABLE_SCHEM" } else { "schema" });
                Ok(TableInfo {
                    name,
                    schema: schema.clone(),
                    row_count: None,
                    comment: text(row, "REMARKS"),
                    table_type: if views { "VIEW" } else { "TABLE" }.into(),
                    oid: None,
                    owner: schema,
                    acl: None,
                    primary_key: None,
                    partition_of: None,
                    has_indexes: None,
                    has_triggers: None,
                    engine: None,
                    data_length: None,
                    create_time: None,
                    update_time: None,
                    collation: None,
                })
            })
            .collect()
    }

    fn bind_value(&self, value: &Value, params: &mut Vec<Value>) -> String {
        if value.is_null() {
            "NULL".into()
        } else {
            params.push(value.clone());
            self.marker(params.len())
        }
    }

    fn conditions(
        &self,
        conditions: &[WhereCondition],
        params: &mut Vec<Value>,
    ) -> Result<String, DbError> {
        if conditions.is_empty() {
            return Err(native_error("WHERE conditions are required"));
        }
        Ok(conditions
            .iter()
            .map(|condition| {
                if condition.value.is_null() {
                    format!("{} IS NULL", self.quote(&condition.column))
                } else {
                    format!(
                        "{} = {}",
                        self.quote(&condition.column),
                        self.bind_value(&condition.value, params)
                    )
                }
            })
            .collect::<Vec<_>>()
            .join(" AND "))
    }
}

#[async_trait]
impl DatabaseConnection for NativeConnection {
    fn db_type(&self) -> DatabaseType {
        self.config.db_type.clone()
    }
    fn handles_query_pagination(&self) -> bool {
        true
    }
    async fn close(&self) {
        self.shutdown().await;
    }
    async fn ping(&self) -> Result<(), DbError> {
        self.read(
            if self.config.db_type == DatabaseType::GBase {
                "SELECT FIRST 1 1 FROM systables"
            } else {
                "SELECT 1 FROM DUAL"
            },
            vec![],
        )
        .await
        .map(|_| ())
    }
    async fn database_names(&self) -> Result<Option<Vec<String>>, DbError> {
        Ok(Some(vec![match self.config.db_type {
            DatabaseType::DaMeng => "DaMeng".into(),
            DatabaseType::YashanDB => "YashanDB".into(),
            _ => self.config.database.clone().unwrap_or_default(),
        }]))
    }
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        self.write(sql, vec![]).await
    }
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        self.read(sql, vec![]).await
    }
    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        if limit == 0 || limit > MAX_ROWS as u64 || offset > i32::MAX as u64 {
            return Err(native_error("Invalid query page"));
        }
        let mut result = self
            .run(sql, vec![], Some((limit as usize + 1, offset as usize)))
            .await?;
        let has_more = result.rows.len() as u64 > limit;
        result.rows.truncate(limit as usize);
        result.row_count = result.rows.len() as u64;
        Ok((result, has_more))
    }
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        self.objects(None, false).await
    }
    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        self.objects(schema, true).await
    }
    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = if self.config.db_type == DatabaseType::GBase {
            "SELECT DISTINCT owner AS \"name\" FROM systables ORDER BY owner"
        } else {
            "SELECT USERNAME AS \"name\" FROM ALL_USERS ORDER BY USERNAME"
        };
        self.read(sql, vec![])
            .await?
            .rows
            .iter()
            .map(|row| required(row, "name"))
            .collect()
    }
    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let owner = self.owner(schema);
        if self.config.db_type == DatabaseType::GBase {
            let keys = self
                .catalog(Catalog::PrimaryKeys {
                    table: table.into(),
                    schema: owner.clone(),
                })
                .await?;
            let keys = keys
                .rows
                .iter()
                .filter_map(|row| text(row, "COLUMN_NAME"))
                .collect::<std::collections::HashSet<_>>();
            let columns = self
                .catalog(Catalog::Columns {
                    table: table.into(),
                    schema: owner.clone(),
                })
                .await?;
            return columns
                .rows
                .iter()
                .filter(|row| {
                    text(row, "TABLE_NAME").as_deref() == Some(table)
                        && text(row, "TABLE_SCHEM").as_deref() == Some(owner.as_str())
                })
                .map(|row| {
                    let name = required(row, "COLUMN_NAME")?;
                    let mut column = column(
                        name.clone(),
                        required(row, "TYPE_NAME")?,
                        number(row, "NULLABLE") != Some(0),
                    );
                    column.is_primary_key = keys.contains(&name);
                    column.default_value = text(row, "COLUMN_DEF");
                    column.comment = text(row, "REMARKS");
                    column.character_maximum_length = number(row, "CHAR_OCTET_LENGTH");
                    column.numeric_precision = number(row, "COLUMN_SIZE");
                    column.numeric_scale = number(row, "DECIMAL_DIGITS");
                    Ok(column)
                })
                .collect();
        }
        let sql = format!("SELECT c.COLUMN_NAME AS \"name\", c.DATA_TYPE AS \"type\", c.NULLABLE AS \"nullable\", c.DATA_DEFAULT AS \"default\", c.DATA_LENGTH AS \"length\", c.DATA_PRECISION AS \"precision\", c.DATA_SCALE AS \"scale\", m.COMMENTS AS \"comment\", CASE WHEN EXISTS (SELECT 1 FROM ALL_CONSTRAINTS p JOIN ALL_CONS_COLUMNS k ON k.OWNER=p.OWNER AND k.CONSTRAINT_NAME=p.CONSTRAINT_NAME WHERE p.CONSTRAINT_TYPE='P' AND p.OWNER=c.OWNER AND p.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME) THEN 1 ELSE 0 END AS \"primary\" FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER=c.OWNER AND m.TABLE_NAME=c.TABLE_NAME AND m.COLUMN_NAME=c.COLUMN_NAME WHERE c.OWNER={} AND c.TABLE_NAME={} ORDER BY c.COLUMN_ID", self.marker(1), self.marker(2));
        self.read(&sql, vec![json!(owner), json!(table)])
            .await?
            .rows
            .iter()
            .map(|row| {
                let mut column = column(
                    required(row, "name")?,
                    required(row, "type")?,
                    text(row, "nullable").as_deref() == Some("Y"),
                );
                column.is_primary_key = number(row, "primary") == Some(1);
                column.default_value = text(row, "default");
                column.comment = text(row, "comment");
                column.character_maximum_length = number(row, "length");
                column.numeric_precision = number(row, "precision");
                column.numeric_scale = number(row, "scale");
                Ok(column)
            })
            .collect()
    }
    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> {
        let owner = self.owner(schema);
        let (sql, params) = if self.config.db_type == DatabaseType::GBase {
            let sql = (1..=16).map(|position| format!("SELECT i.idxname AS \"name\", c.colname AS \"column_name\", CASE WHEN i.idxtype='U' THEN 1 ELSE 0 END AS \"unique\", {position} AS \"ordinal_position\" FROM sysindexes i JOIN systables t ON t.tabid=i.tabid JOIN syscolumns c ON c.tabid=i.tabid AND c.colno=ABS(i.part{position}) WHERE t.owner=? AND t.tabname=? AND i.part{position}<>0")).collect::<Vec<_>>().join(" UNION ALL ");
            (
                sql,
                (0..16).flat_map(|_| [json!(owner), json!(table)]).collect(),
            )
        } else {
            (format!("SELECT i.INDEX_NAME AS \"name\", c.COLUMN_NAME AS \"column_name\", CASE WHEN i.UNIQUENESS='UNIQUE' THEN 1 ELSE 0 END AS \"unique\", c.COLUMN_POSITION AS \"ordinal_position\" FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER=i.OWNER AND c.INDEX_NAME=i.INDEX_NAME WHERE i.TABLE_OWNER={} AND i.TABLE_NAME={} ORDER BY i.INDEX_NAME,c.COLUMN_POSITION", self.marker(1), self.marker(2)), vec![json!(owner), json!(table)])
        };
        Ok(self.read(&sql, params).await?.rows.iter().map(|row| json!({"name":text(row,"name"),"column_name":text(row,"column_name"),"is_unique":number(row,"unique")==Some(1),"ordinal_position":number(row,"ordinal_position")})).collect())
    }
    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<Value>, DbError> {
        let owner = self.owner(schema);
        if self.config.db_type == DatabaseType::GBase {
            let result = self
                .catalog(Catalog::ForeignKeys {
                    table: table.into(),
                    schema: owner,
                })
                .await?;
            return Ok(result.rows.iter().map(|row| json!({"name":text(row,"FK_NAME"),"column_name":text(row,"FKCOLUMN_NAME"),"foreign_table_schema":text(row,"PKTABLE_SCHEM"),"foreign_table_name":text(row,"PKTABLE_NAME"),"foreign_column_name":text(row,"PKCOLUMN_NAME"),"ordinal_position":number(row,"KEY_SEQ")})).collect());
        }
        let sql = format!("SELECT f.CONSTRAINT_NAME AS \"name\", c.COLUMN_NAME AS \"column_name\", p.OWNER AS \"foreign_table_schema\", p.TABLE_NAME AS \"foreign_table_name\", r.COLUMN_NAME AS \"foreign_column_name\", c.POSITION AS \"ordinal_position\" FROM ALL_CONSTRAINTS f JOIN ALL_CONS_COLUMNS c ON c.OWNER=f.OWNER AND c.CONSTRAINT_NAME=f.CONSTRAINT_NAME JOIN ALL_CONSTRAINTS p ON p.OWNER=f.R_OWNER AND p.CONSTRAINT_NAME=f.R_CONSTRAINT_NAME JOIN ALL_CONS_COLUMNS r ON r.OWNER=p.OWNER AND r.CONSTRAINT_NAME=p.CONSTRAINT_NAME AND r.POSITION=c.POSITION WHERE f.CONSTRAINT_TYPE='R' AND f.OWNER={} AND f.TABLE_NAME={} ORDER BY f.CONSTRAINT_NAME,c.POSITION", self.marker(1), self.marker(2));
        Ok(self
            .read(&sql, vec![json!(owner), json!(table)])
            .await?
            .rows
            .into_iter()
            .map(Value::Object)
            .collect())
    }
    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        if self.config.db_type == DatabaseType::GBase {
            return Err(native_error("Exact GBase 8s DDL export requires vendor dbschema; it is not synthesized from incomplete metadata"));
        }
        let owner = self.owner(schema);
        let views = self.get_views(Some(&owner)).await?;
        let kind = if views.iter().any(|view| view.name == table) {
            "VIEW"
        } else {
            "TABLE"
        };
        let sql = format!(
            "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) AS \"ddl\" FROM DUAL",
            self.marker(1),
            self.marker(2),
            self.marker(3)
        );
        let result = self
            .read(&sql, vec![json!(kind), json!(table), json!(owner)])
            .await?;
        result
            .rows
            .first()
            .ok_or_else(|| native_error("DDL returned no rows"))
            .and_then(|row| required(row, "ddl"))
    }
    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        let result = self
            .read(
                &format!(
                    "SELECT COUNT(*) AS \"count\" FROM {}",
                    self.qualified(table, schema)?
                ),
                vec![],
            )
            .await?;
        let value = result
            .rows
            .first()
            .ok_or_else(|| native_error("COUNT returned no rows"))
            .and_then(|row| required(row, "count"))?;
        value.parse().map_err(native_error)
    }
    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        if page == 0 || page_size == 0 || page_size as usize > MAX_ROWS {
            return Err(native_error("Invalid table page"));
        }
        let offset = u64::from(page - 1) * u64::from(page_size);
        let sql = format!(
            "SELECT * FROM {} ORDER BY {}",
            self.qualified(table, schema)?,
            sanitize_order_by(order_by.unwrap_or("1"))?
        );
        self.query_sql_paged(&sql, page_size.into(), offset)
            .await
            .map(|(result, _)| result)
    }
    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, Value)],
        conditions: &[WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        if updates.is_empty() {
            return Err(native_error("Updates must not be empty"));
        }
        let mut params = vec![];
        let assignments = updates
            .iter()
            .map(|(name, value)| {
                format!(
                    "{} = {}",
                    self.quote(name),
                    self.bind_value(value, &mut params)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let filter = self.conditions(conditions, &mut params)?;
        self.write(
            &format!(
                "UPDATE {} SET {assignments} WHERE {filter}",
                self.qualified(table, schema)?
            ),
            params,
        )
        .await
    }
    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, Value)],
    ) -> Result<ExecuteResult, DbError> {
        if values.is_empty() {
            return Err(native_error("Insert values must not be empty"));
        }
        let mut params = vec![];
        let columns = values
            .iter()
            .map(|(name, _)| self.quote(name))
            .collect::<Vec<_>>()
            .join(", ");
        let markers = values
            .iter()
            .map(|(_, value)| self.bind_value(value, &mut params))
            .collect::<Vec<_>>()
            .join(", ");
        self.write(
            &format!(
                "INSERT INTO {} ({columns}) VALUES ({markers})",
                self.qualified(table, schema)?
            ),
            params,
        )
        .await
    }
    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        conditions: &[WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let mut params = vec![];
        let filter = self.conditions(conditions, &mut params)?;
        self.write(
            &format!(
                "DELETE FROM {} WHERE {filter}",
                self.qualified(table, schema)?
            ),
            params,
        )
        .await
    }
}

fn text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .and_then(|(_, value)| match value {
            Value::Null => None,
            Value::String(value) => Some(value.clone()),
            value => Some(value.to_string()),
        })
}

fn required(row: &Map<String, Value>, key: &str) -> Result<String, DbError> {
    text(row, key).ok_or_else(|| native_error(format!("Native catalog field {key} is missing")))
}

fn number(row: &Map<String, Value>, key: &str) -> Option<i64> {
    text(row, key).and_then(|value| value.parse().ok())
}
