use std::collections::HashMap;
use super::types::DatabaseType;

/// 标识符引用风格
//
// `Bracket` is reserved for future SQL Server / GBase support; not currently
// constructed but kept on the enum for forward compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum QuoteStyle {
    Double,   // "identifier" (PG, GaussDB, Kingbase, Oracle)
    Backtick, // `identifier` (MySQL, ClickHouse, TiDB)
    Bracket,  // [identifier] (SQL Server, GBase)
}

/// 分页语法
//
// `FetchNext` is set by the Oracle template (reserved for future driver); `TopN`
// is reserved for SQL Server. Both stay on the enum even though no driver
// currently dispatches on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum LimitSyntax {
    LimitOffset,  // LIMIT N OFFSET M (PG, MySQL, SQLite)
    FetchNext,    // FETCH NEXT N ROWS ONLY (Oracle 12c+, DB2)
    TopN,         // SELECT TOP N (SQL Server legacy)
}

/// 元数据查询 SQL 模板
/// 使用 $1, $2 作为参数占位符，由驱动层绑定参数
#[derive(Debug, Clone)]
pub struct MetadataQueries {
    /// 查询数据库列表（MySQL: SHOW DATABASES，PG: information_schema.schemata）
    pub list_databases: &'static str,
    /// 查询 schema 列表
    pub list_schemas: &'static str,
    /// 查询表列表（参数: schema, 或 database）
    pub list_tables: &'static str,
    /// 查询视图列表
    pub list_views: &'static str,
    /// 查询列信息（参数: schema, table）
    pub list_columns: &'static str,
    /// 查询索引（参数: schema, table）
    pub list_indexes: &'static str,
    /// 查询外键（参数: schema, table）
    pub list_foreign_keys: &'static str,
    /// 查询存储过程
    pub list_procedures: &'static str,
    /// 查询触发器（参数: schema, table）
    pub list_triggers: &'static str,
    /// 查询表行数（参数: schema, table）
    pub table_row_count: &'static str,
    /// EXPLAIN 查询（参数: sql）
    pub explain_query: &'static str,
}

#[derive(Debug, Clone)]
pub struct DialectConfig {
    pub db_type: DatabaseType,
    pub default_port: u16,
    pub identifier_quote: QuoteStyle,
    pub limit_syntax: LimitSyntax,
    pub metadata_queries: MetadataQueries,
    /// 函数名映射: 标准 SQL 函数 → 数据库特有函数
    /// 例如: {"NOW()": "SYSDATE", "CURRENT_DATE": "CURDATE"}
    pub function_map: HashMap<&'static str, &'static str>,
}

impl DialectConfig {
    /// PostgreSQL 标准方言 — 所有 PG 兼容库继承此配置
    pub fn pg_standard() -> Self {
        Self {
            db_type: DatabaseType::PostgreSQL,
            default_port: 5432,
            identifier_quote: QuoteStyle::Double,
            limit_syntax: LimitSyntax::LimitOffset,
            metadata_queries: MetadataQueries {
                list_databases: "SELECT datname FROM pg_database \
                    WHERE datistemplate = false ORDER BY datname",
                list_schemas: "SELECT schema_name FROM information_schema.schemata \
                    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
                    ORDER BY schema_name",
                list_tables: "SELECT table_schema, table_name, table_type \
                    FROM information_schema.tables \
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                    AND table_type = 'BASE TABLE' \
                    ORDER BY table_schema, table_name",
                list_views: "SELECT table_schema, table_name \
                    FROM information_schema.views \
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                    ORDER BY table_schema, table_name",
                list_columns: "SELECT column_name, data_type, is_nullable, \
                    column_default, ordinal_position, character_maximum_length, \
                    numeric_precision, numeric_scale \
                    FROM information_schema.columns \
                    WHERE table_schema = $1 AND table_name = $2 \
                    ORDER BY ordinal_position",
                list_indexes: "SELECT indexname, indexdef \
                    FROM pg_indexes \
                    WHERE schemaname = $1 AND tablename = $2",
                list_foreign_keys: "SELECT tc.constraint_name, \
                    kcu.column_name, \
                    ccu.table_schema AS foreign_table_schema, \
                    ccu.table_name AS foreign_table_name, \
                    ccu.column_name AS foreign_column_name \
                    FROM information_schema.table_constraints tc \
                    JOIN information_schema.key_column_usage kcu \
                        ON tc.constraint_name = kcu.constraint_name \
                        AND tc.table_schema = kcu.table_schema \
                    JOIN information_schema.constraint_column_usage ccu \
                        ON tc.constraint_name = ccu.constraint_name \
                    WHERE tc.constraint_type = 'FOREIGN KEY' \
                    AND tc.table_schema = $1 AND tc.table_name = $2",
                list_procedures: "SELECT routine_schema, routine_name, \
                    routine_type, data_type AS return_type \
                    FROM information_schema.routines \
                    WHERE routine_schema NOT IN ('pg_catalog', 'information_schema') \
                    ORDER BY routine_schema, routine_name",
                list_triggers: "SELECT trigger_name, event_manipulation, \
                    action_statement, action_timing \
                    FROM information_schema.triggers \
                    WHERE event_object_schema = $1 \
                    AND event_object_table = $2",
                table_row_count: "SELECT reltuples::bigint AS estimate \
                    FROM pg_class WHERE oid = $1::regclass",
                explain_query: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}",
            },
            function_map: HashMap::new(),
        }
    }

    /// MySQL 标准方言
    /// Standard MySQL profile (reserved for future MySQL-fork drivers; not
    /// currently dispatched to).
    #[allow(dead_code)]
    pub fn mysql_standard() -> Self {
        Self {
            db_type: DatabaseType::MySQL,
            default_port: 3306,
            identifier_quote: QuoteStyle::Backtick,
            limit_syntax: LimitSyntax::LimitOffset,
            metadata_queries: MetadataQueries {
                list_databases: "SHOW DATABASES",
                list_schemas: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
                    ORDER BY SCHEMA_NAME",
                list_tables: "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE \
                    FROM information_schema.TABLES \
                    WHERE TABLE_TYPE = 'BASE TABLE' \
                    ORDER BY TABLE_SCHEMA, TABLE_NAME",
                list_views: "SELECT TABLE_SCHEMA, TABLE_NAME \
                    FROM information_schema.VIEWS \
                    ORDER BY TABLE_SCHEMA, TABLE_NAME",
                list_columns: "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, \
                    COLUMN_DEFAULT, ORDINAL_POSITION, CHARACTER_MAXIMUM_LENGTH, \
                    NUMERIC_PRECISION, NUMERIC_SCALE \
                    FROM information_schema.COLUMNS \
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                    ORDER BY ORDINAL_POSITION",
                list_indexes: "SHOW INDEX FROM `{table}` FROM `{schema}`",
                list_foreign_keys: "SELECT CONSTRAINT_NAME, COLUMN_NAME, \
                    REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, \
                    REFERENCED_COLUMN_NAME \
                    FROM information_schema.KEY_COLUMN_USAGE \
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                    AND REFERENCED_TABLE_NAME IS NOT NULL",
                list_procedures: "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, \
                    ROUTINE_TYPE, DTD_IDENTIFIER AS return_type \
                    FROM information_schema.ROUTINES \
                    ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
                list_triggers: "SELECT TRIGGER_NAME, EVENT_MANIPULATION, \
                    ACTION_STATEMENT, ACTION_TIMING \
                    FROM information_schema.TRIGGERS \
                    WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?",
                table_row_count: "SELECT TABLE_ROWS FROM information_schema.TABLES \
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                explain_query: "EXPLAIN FORMAT=JSON {}",
            },
            function_map: HashMap::new(),
        }
    }

    /// GaussDB 方言 — 基于 PG，默认端口 8000
    pub fn gaussdb() -> Self {
        let mut d = Self::pg_standard();
        d.db_type = DatabaseType::GaussDB;
        d.default_port = 8000;
        d
    }

    /// Kingbase 方言 — 基于 PG，覆盖差异
    /// Reserved for future Kingbase driver support.
    #[allow(dead_code)]
    pub fn kingbase() -> Self {
        let mut d = Self::pg_standard();
        d.db_type = DatabaseType::Kingbase;
        d.default_port = 54321;
        // Kingbase 某些版本用 SYSDATE 代替 NOW()
        d.function_map.insert("NOW()", "SYSDATE");
        d
    }

    /// Oracle 方言（ODBC 模式）
    /// Reserved for future Oracle driver support.
    #[allow(dead_code)]
    pub fn oracle() -> Self {
        Self {
            db_type: DatabaseType::Oracle,
            default_port: 1521,
            identifier_quote: QuoteStyle::Double,
            limit_syntax: LimitSyntax::FetchNext,
            metadata_queries: MetadataQueries {
                list_databases: "SELECT NAME FROM v$database",
                list_schemas: "SELECT USERNAME FROM all_users ORDER BY USERNAME",
                list_tables: "SELECT OWNER, TABLE_NAME, \
                    'BASE TABLE' AS TABLE_TYPE \
                    FROM all_tables ORDER BY OWNER, TABLE_NAME",
                list_views: "SELECT OWNER, VIEW_NAME FROM all_views \
                    ORDER BY OWNER, VIEW_NAME",
                list_columns: "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, \
                    DATA_DEFAULT, COLUMN_ID, CHAR_LENGTH, \
                    DATA_PRECISION, DATA_SCALE \
                    FROM all_tab_columns \
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}' \
                    ORDER BY COLUMN_ID",
                list_indexes: "SELECT INDEX_NAME, INDEX_TYPE, UNIQUENESS \
                    FROM all_indexes \
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}'",
                list_foreign_keys: "SELECT a.constraint_name, \
                    a.column_name, \
                    c.owner AS foreign_owner, \
                    c.table_name AS foreign_table, \
                    c.column_name AS foreign_column \
                    FROM all_cons_columns a \
                    JOIN all_constraints b ON a.constraint_name = b.constraint_name \
                    JOIN all_cons_columns c ON b.r_constraint_name = c.constraint_name \
                    WHERE b.constraint_type = 'R' \
                    AND a.owner = '{schema}' AND b.table_name = '{table}'",
                list_procedures: "SELECT OWNER, OBJECT_NAME, OBJECT_TYPE \
                    FROM all_procedures ORDER BY OWNER, OBJECT_NAME",
                list_triggers: "SELECT TRIGGER_NAME, TRIGGER_TYPE, \
                    TRIGGERING_EVENT, STATUS \
                    FROM all_triggers \
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}'",
                table_row_count: "SELECT NUM_ROWS FROM all_tables \
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}'",
                explain_query: "EXPLAIN PLAN FOR {}",
            },
            function_map: HashMap::from([
                ("NOW()", "SYSDATE"),
                ("CURRENT_DATE", "SYSDATE"),
                ("LIMIT", "FETCH FIRST"),
            ]),
        }
    }
}
