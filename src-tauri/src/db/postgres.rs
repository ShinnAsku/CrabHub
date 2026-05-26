use async_trait::async_trait;
use sqlx::Row;
use std::time::{Duration, Instant};

use super::pg_utils;
use super::trait_def::{escape_sql_string, json_value_to_sql, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

// ============================================================================
// PostgreSQL Connection
// ============================================================================

pub struct PostgresConnection {
    pool: sqlx::PgPool,
    db_type_label: DatabaseType,
}

impl PostgresConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        use urlencoding::encode;

        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(5432);
        let username = config.username.as_deref().unwrap_or("postgres");
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");

        let ssl_mode = if config.ssl_enabled {
            "require"
        } else {
            "prefer"
        };

        let connection_string = if password.is_empty() {
            if database.is_empty() {
                format!(
                    "postgres://{}@{}:{}?sslmode={}",
                    encode(username),
                    host,
                    port,
                    ssl_mode
                )
            } else {
                format!(
                    "postgres://{}@{}:{}/{}?sslmode={}",
                    encode(username),
                    host,
                    port,
                    encode(database),
                    ssl_mode
                )
            }
        } else {
            if database.is_empty() {
                format!(
                    "postgres://{}:{}@{}:{}?sslmode={}",
                    encode(username),
                    encode(password),
                    host,
                    port,
                    ssl_mode
                )
            } else {
                format!(
                    "postgres://{}:{}@{}:{}/{}?sslmode={}",
                    encode(username),
                    encode(password),
                    host,
                    port,
                    encode(database),
                    ssl_mode
                )
            }
        };

        log::info!("Connecting to PostgreSQL at {}:{}", host, port);

        let pc = crate::db::pool_config::PoolConfig::with_overrides(&config.db_type, config.pool_options.as_ref());
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(pc.max_connections)
            .idle_timeout(Duration::from_secs(pc.idle_timeout_secs))
            .max_lifetime(Duration::from_secs(pc.max_lifetime_secs))
            .acquire_timeout(Duration::from_secs(pc.acquire_timeout_secs))
            .connect(&connection_string)
            .await
            .map_err(|e| {
                DbError::ConnectionError(format!("Failed to connect to PostgreSQL: {}", e))
            })?;

        log::info!("Successfully connected to PostgreSQL");

        Ok(Self {
            pool,
            db_type_label: config.db_type.clone(),
        })
    }
}

#[async_trait]
impl DatabaseConnection for PostgresConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = Instant::now();
        let result = sqlx::query(sql)
            .execute(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(ExecuteResult {
            rows_affected: result.rows_affected(),
            execution_time_ms: elapsed,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = Instant::now();

        let result = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let elapsed = start.elapsed().as_millis() as u64;

        let (columns, rows) = pg_utils::parse_pg_rows(&result);
        let row_count = rows.len() as u64;

        Ok(QueryResult {
            columns,
            rows,
            row_count,
            execution_time_ms: elapsed,
        })
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = r#"
            SELECT
                c.oid::bigint AS oid,
                c.relname AS table_name,
                n.nspname AS table_schema,
                r.rolname AS owner,
                CASE c.relkind
                    WHEN 'r' THEN 'TABLE'
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'MATERIALIZED VIEW'
                    WHEN 'p' THEN 'PARTITIONED TABLE'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                    ELSE 'TABLE'
                END AS table_type,
                obj_description(c.oid, 'pg_class') AS table_comment,
                c.reltuples::bigint AS row_count,
                c.relhasindex AS has_indexes,
                c.relhastriggers AS has_triggers,
                pg_catalog.array_to_string(c.relacl, E'\n') AS acl,
                (
                    SELECT string_agg(a.attname, ', ' ORDER BY array_position(ix.indkey, a.attnum))
                    FROM pg_index ix
                    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
                    WHERE ix.indrelid = c.oid AND ix.indisprimary
                ) AS primary_key,
                (
                    SELECT p.relname
                    FROM pg_inherits inh
                    JOIN pg_class p ON p.oid = inh.inhparent
                    WHERE inh.inhrelid = c.oid
                    LIMIT 1
                ) AS partition_of
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
            ORDER BY n.nspname, c.relname
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let tables = rows
            .iter()
            .map(|row| {
                let oid: Option<i64> = row.try_get("oid").ok();
                let row_count_raw: Option<i64> = row.try_get("row_count").ok();
                let row_count =
                    row_count_raw.and_then(|v| if v >= 0 { Some(v as u64) } else { None });
                TableInfo {
                    name: row.get("table_name"),
                    schema: row.get("table_schema"),
                    row_count,
                    comment: row.try_get("table_comment").ok().flatten(),
                    table_type: row
                        .try_get::<String, _>("table_type")
                        .unwrap_or_else(|_| "TABLE".to_string()),
                    oid,
                    owner: row.try_get("owner").ok().flatten(),
                    acl: row.try_get("acl").ok().flatten(),
                    primary_key: row.try_get("primary_key").ok().flatten(),
                    partition_of: row.try_get("partition_of").ok().flatten(),
                    has_indexes: row.try_get("has_indexes").ok(),
                    has_triggers: row.try_get("has_triggers").ok(),
                    engine: None,
                    data_length: None,
                    create_time: None,
                    update_time: None,
                    collation: None,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("public");

        let sql = r#"
            SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                col_description(cls.oid, c.ordinal_position) as column_comment,
                CASE
                    WHEN pk.column_name IS NOT NULL THEN true
                    ELSE false
                END as is_primary_key,
                c.character_maximum_length,
                c.numeric_precision::bigint as numeric_precision,
                c.numeric_scale::bigint as numeric_scale
            FROM information_schema.columns c
            LEFT JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name
            LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = c.table_schema
            LEFT JOIN (
                SELECT
                    kcu.table_schema,
                    kcu.table_name,
                    kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk ON pk.table_schema = c.table_schema
                AND pk.table_name = c.table_name
                AND pk.column_name = c.column_name
            WHERE c.table_name = $1 AND c.table_schema = $2
            ORDER BY c.ordinal_position
        "#;

        let rows = sqlx::query(sql)
            .bind(table)
            .bind(schema_name)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let columns = rows
            .iter()
            .map(|row| {
                let is_nullable: String = row.get("is_nullable");
                let char_max_len: Option<i32> = row.get("character_maximum_length");
                let num_precision: Option<i64> = row.get("numeric_precision");
                let num_scale: Option<i64> = row.get("numeric_scale");
                ColumnInfo {
                    name: row.get("column_name"),
                    data_type: row.get("data_type"),
                    nullable: is_nullable == "YES",
                    is_primary_key: row.get("is_primary_key"),
                    default_value: row.get("column_default"),
                    comment: row.get("column_comment"),
                    character_maximum_length: char_max_len.map(|v| v as i64),
                    numeric_precision: num_precision,
                    numeric_scale: num_scale,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = r#"
            SELECT nspname AS schema_name
            FROM pg_namespace
            WHERE nspname NOT IN ('pg_catalog', 'information_schema')
              AND nspname NOT LIKE 'pg_toast%'
              AND nspname NOT LIKE 'pg_temp_%'
            ORDER BY nspname
        "#;

        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let schemas = rows.iter().map(|row| row.get::<String, _>(0)).collect();
        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        self.db_type_label.clone()
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_name = $1 AND table_schema = $2 \
             ORDER BY ordinal_position"
        );
        let rows = sqlx::query(&sql)
            .bind(table)
            .bind(schema_name)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        let col_defs: Vec<String> = rows
            .iter()
            .map(|row| {
                let name: String = row.get("column_name");
                let data_type: String = row.get("data_type");
                let is_nullable: String = row.get("is_nullable");
                let default: Option<String> = row.get("column_default");
                let null_str = if is_nullable == "YES" {
                    ""
                } else {
                    " NOT NULL"
                };
                let default_str = match default {
                    Some(d) => format!(" DEFAULT {}", d),
                    None => String::new(),
                };
                format!("    {} {}{}{}", name, data_type, null_str, default_str)
            })
            .collect();

        let full_table = if schema_name == "public" {
            table.to_string()
        } else {
            format!("{}.{}", schema_name, table)
        };

        Ok(format!(
            "-- Table: {}\nCREATE TABLE IF NOT EXISTS {} (\n{}\n);\n",
            full_table,
            full_table,
            col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let schema_filter = match schema {
            Some(s) => format!("AND table_schema = '{}'", escape_sql_string(s)),
            None => String::new(),
        };
        let sql = format!(
            "SELECT table_name, table_schema, NULL::text as table_comment, 'VIEW' as table_type \
             FROM information_schema.views \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             {} ORDER BY table_schema, table_name",
            schema_filter
        );
        let rows = self.query_sql(&sql).await?;
        let views = rows
            .rows
            .iter()
            .map(|row| TableInfo {
                name: row
                    .get("table_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                schema: row
                    .get("table_schema")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                row_count: None,
                comment: None,
                table_type: "VIEW".to_string(),
                oid: None,
                owner: None,
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
            .collect();
        Ok(views)
    }

    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            "SELECT index_name, is_unique, is_primary, column_names FROM (\
                SELECT i.relname as index_name, ix.indisunique as is_unique, \
                ix.indisprimary as is_primary, \
                array_to_string(array_agg(a.attname), ', ') as column_names \
                FROM pg_class t JOIN pg_index ix ON t.oid = ix.indrelid \
                JOIN pg_class i ON i.oid = ix.indexrelid \
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
                JOIN pg_namespace n ON n.oid = t.relnamespace \
                WHERE t.relname = '{}' AND n.nspname = '{}' \
                GROUP BY i.relname, ix.indisunique, ix.indisprimary\
            ) sub ORDER BY index_name",
            escape_sql_string(table),
            escape_sql_string(schema_name)
        );
        let rows = self.query_sql(&sql).await?;
        Ok(rows
            .rows
            .into_iter()
            .map(|m| serde_json::Value::Object(m))
            .collect())
    }

    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            r#"
            SELECT
                tc.constraint_name,
                kcu.column_name,
                ccu.table_schema as foreign_table_schema,
                ccu.table_name as foreign_table_name,
                ccu.column_name as foreign_column_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '{}' AND tc.table_schema = '{}'
            "#,
            escape_sql_string(table),
            escape_sql_string(schema_name)
        );
        let rows = self.query_sql(&sql).await?;
        Ok(rows
            .rows
            .into_iter()
            .map(|m| serde_json::Value::Object(m))
            .collect())
    }

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let full_table_ref = pg_utils::full_table(table, schema);
        let sql = format!("SELECT COUNT(*) as cnt FROM {}", full_table_ref);
        let rows = self.query_sql(&sql).await?;
        if let Some(row) = rows.rows.first() {
            if let Some(cnt) = row
                .get("cnt")
                .and_then(|v| v.as_u64())
            {
                return Ok(cnt);
            }
        }
        Ok(0)
    }

    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let full_table_ref = pg_utils::full_table(table, schema);
        let order_clause = if let Some(o) = order_by {
            crate::db::trait_def::sanitize_order_by(o)?;
            format!(" ORDER BY {}", o)
        } else {
            String::new()
        };
        let offset = (page.saturating_sub(1)) * page_size;
        let sql = format!(
            "SELECT * FROM {}{} LIMIT {} OFFSET {}",
            full_table_ref, order_clause, page_size, offset
        );
        let mut result = self.query_sql(&sql).await?;
        if result.columns.is_empty() {
            result.columns = self.get_columns(table, schema).await.unwrap_or_default();
        }
        Ok(result)
    }

    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        use crate::db::trait_def::{build_where_sql, escape_identifier};
        use crate::db::types::DatabaseType;
        let full_table_ref = pg_utils::full_table_quoted(table, schema);
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| format!("{} = {}", escape_identifier(col, &DatabaseType::PostgreSQL), json_value_to_sql(val)))
            .collect();
        let where_sql = build_where_sql(where_conditions, &|c| {
            escape_identifier(c, &DatabaseType::PostgreSQL)
        })?;
        let sql = format!(
            "UPDATE {} SET {} WHERE {}",
            full_table_ref,
            set_clauses.join(", "),
            where_sql
        );
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        use crate::db::trait_def::escape_identifier;
        use crate::db::types::DatabaseType;
        let full_table_ref = pg_utils::full_table_quoted(table, schema);
        let columns: Vec<String> = values.iter()
            .map(|(c, _)| escape_identifier(c, &DatabaseType::PostgreSQL))
            .collect();
        let value_strs: Vec<String> = values.iter().map(|(_, val)| json_value_to_sql(val)).collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            full_table_ref,
            columns.join(", "),
            value_strs.join(", ")
        );
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        use crate::db::trait_def::{build_where_sql, escape_identifier};
        use crate::db::types::DatabaseType;
        let full_table_ref = pg_utils::full_table_quoted(table, schema);
        let where_sql = build_where_sql(where_conditions, &|c| {
            escape_identifier(c, &DatabaseType::PostgreSQL)
        })?;
        let sql = format!("DELETE FROM {} WHERE {}", full_table_ref, where_sql);
        self.execute_sql(&sql).await
    }

    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        _offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        // SQL already has LIMIT limit+1 injected — fetch_all is safe (bounded to ~1001 rows)
        let result = self.query_sql(sql).await?;
        let has_more = result.rows.len() as u64 > limit;
        let rows = if has_more {
            result.rows.into_iter().take(limit as usize).collect()
        } else {
            result.rows
        };
        Ok((QueryResult { rows, ..result }, has_more))
    }
}

