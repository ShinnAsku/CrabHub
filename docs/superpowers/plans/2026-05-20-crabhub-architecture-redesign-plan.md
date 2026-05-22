# CrabHub 架构升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构驱动层为继承体系，新增 ODBC 桥接器，统一方言配置，Mac 风格 UI 改版（shadcn/ui），AI Agent 自主操作数据库，增加前端结果集图表和 Markdown 导出功能。

**Architecture:** 驱动层从平铺改为三层继承（Native → ProtocolCompatible → OdbcBridge）。前端引入 shadcn/ui 实现 Mac 风格界面。AI 模块从被动对话升级为 ReAct Agent（Tool Registry + Safety Gate + Context Builder）。方言差异从代码中抽到配置表，元数据查询集中管理。

**Tech Stack:** Rust (sqlx, odbc-api, reqwest, tokio), React 19 + TypeScript 5.7, shadcn/ui + Tailwind CSS 4, recharts, sonner

---

### Task 1: 扩展 DatabaseType 枚举和 DriverCapabilities

**Files:**
- Modify: `src-tauri/src/db/types.rs`

- [ ] **Step 1: 添加新的数据库类型变体**

```rust
// src-tauri/src/db/types.rs
// 将 DatabaseType 枚举从 6 个变体扩展到 16 个

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DatabaseType {
    // 已有的
    PostgreSQL,
    MySQL,
    SQLite,
    ClickHouse,
    GaussDB,
    Plugin(String),

    // 新增：PG 协议兼容
    Kingbase,       // 人大金仓
    Vastbase,       // 海量数据库
    YashanDB,       // 崖山数据库

    // 新增：MySQL 协议兼容
    OceanBase,      // 蚂蚁 OceanBase
    TiDB,           // PingCAP TiDB
    TDSQL,          // 腾讯 TDSQL

    // 新增：ODBC 桥接
    Oracle,         // Oracle
    SQLServer,      // Microsoft SQL Server
    DaMeng,         // 达梦 DM
    GBase,          // 南大通用 GBase 8a/8t
}
```

- [ ] **Step 2: 更新 DatabaseType 方法**

```rust
// 在 impl DatabaseType 块中更新 as_str() 方法

impl DatabaseType {
    pub fn as_str(&self) -> &str {
        match self {
            DatabaseType::PostgreSQL => "postgresql",
            DatabaseType::MySQL => "mysql",
            DatabaseType::SQLite => "sqlite",
            DatabaseType::ClickHouse => "clickhouse",
            DatabaseType::GaussDB => "gaussdb",
            DatabaseType::Kingbase => "kingbase",
            DatabaseType::Vastbase => "vastbase",
            DatabaseType::YashanDB => "yashandb",
            DatabaseType::OceanBase => "oceanbase",
            DatabaseType::TiDB => "tidb",
            DatabaseType::TDSQL => "tdsql",
            DatabaseType::Oracle => "oracle",
            DatabaseType::SQLServer => "sqlserver",
            DatabaseType::DaMeng => "dameng",
            DatabaseType::GBase => "gbase",
            DatabaseType::Plugin(id) => "plugin",
        }
    }

    pub fn category(&self) -> &str {
        match self {
            DatabaseType::PostgreSQL | DatabaseType::MySQL | DatabaseType::SQLite
                => "开源数据库",
            DatabaseType::ClickHouse => "列存数据库",
            DatabaseType::GaussDB | DatabaseType::Kingbase | DatabaseType::Vastbase
            | DatabaseType::YashanDB | DatabaseType::OceanBase | DatabaseType::TiDB
            | DatabaseType::TDSQL | DatabaseType::DaMeng | DatabaseType::GBase
                => "国产数据库",
            DatabaseType::Oracle | DatabaseType::SQLServer => "商业数据库",
            DatabaseType::Plugin(_) => "插件",
        }
    }

    pub fn default_port(&self) -> u16 {
        match self {
            DatabaseType::PostgreSQL => 5432,
            DatabaseType::MySQL | DatabaseType::TiDB | DatabaseType::OceanBase
            | DatabaseType::TDSQL => 3306,
            DatabaseType::SQLite => 0,
            DatabaseType::ClickHouse => 8123,
            DatabaseType::GaussDB | DatabaseType::Kingbase | DatabaseType::Vastbase => 5432,
            DatabaseType::YashanDB => 1688,
            DatabaseType::Oracle => 1521,
            DatabaseType::SQLServer => 1433,
            DatabaseType::DaMeng => 5236,
            DatabaseType::GBase => 5258,
            DatabaseType::Plugin(_) => 0,
        }
    }
}
```

- [ ] **Step 3: 更新 DriverCapabilities 添加缺失字段**

```rust
// 在 DriverCapabilities 中添加 supports_partitions 字段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverCapabilities {
    pub supports_schemas: bool,
    pub supports_manage_tables: bool,
    pub supports_views: bool,
    pub supports_procedures: bool,
    pub supports_triggers: bool,
    pub supports_indexes: bool,
    pub supports_foreign_keys: bool,
    pub supports_partitions: bool,       // 新增
    pub supports_cancel: bool,           // 新增
    pub is_file_based: bool,
    pub identifier_quote: char,
    pub default_port: u16,
}
```

- [ ] **Step 4: 扩展 capabilities() 匹配所有新变体**

```rust
impl DatabaseType {
    pub fn capabilities(&self) -> DriverCapabilities {
        match self {
            DatabaseType::PostgreSQL | DatabaseType::GaussDB
            | DatabaseType::Kingbase | DatabaseType::Vastbase | DatabaseType::YashanDB => {
                DriverCapabilities {
                    supports_schemas: true,
                    supports_manage_tables: true,
                    supports_views: true,
                    supports_procedures: true,
                    supports_triggers: true,
                    supports_indexes: true,
                    supports_foreign_keys: true,
                    supports_partitions: *self != DatabaseType::YashanDB, // YashanDB 分区语法不同
                    supports_cancel: true,
                    is_file_based: false,
                    identifier_quote: '"',
                    default_port: self.default_port(),
                }
            }
            DatabaseType::MySQL | DatabaseType::OceanBase
            | DatabaseType::TiDB | DatabaseType::TDSQL => {
                DriverCapabilities {
                    supports_schemas: false, // MySQL 用 database 代替 schema
                    supports_manage_tables: true,
                    supports_views: true,
                    supports_procedures: true,
                    supports_triggers: true,
                    supports_indexes: true,
                    supports_foreign_keys: true,
                    supports_partitions: *self == DatabaseType::TiDB,
                    supports_cancel: true,
                    is_file_based: false,
                    identifier_quote: '`',
                    default_port: self.default_port(),
                }
            }
            DatabaseType::SQLite => {
                DriverCapabilities {
                    supports_schemas: false,
                    supports_manage_tables: true,
                    supports_views: true,
                    supports_procedures: false,
                    supports_triggers: true,
                    supports_indexes: true,
                    supports_foreign_keys: true,
                    supports_partitions: false,
                    supports_cancel: false, // SQLite 单线程，无法取消
                    is_file_based: true,
                    identifier_quote: '"',
                    default_port: 0,
                }
            }
            DatabaseType::ClickHouse => {
                DriverCapabilities {
                    supports_schemas: false,
                    supports_manage_tables: true,
                    supports_views: true,
                    supports_procedures: false,
                    supports_triggers: false,
                    supports_indexes: true,
                    supports_foreign_keys: false,
                    supports_partitions: true,
                    supports_cancel: true,
                    is_file_based: false,
                    identifier_quote: '`',
                    default_port: 8123,
                }
            }
            DatabaseType::Oracle | DatabaseType::SQLServer
            | DatabaseType::DaMeng | DatabaseType::GBase => {
                DriverCapabilities {
                    supports_schemas: true,
                    supports_manage_tables: true,
                    supports_views: true,
                    supports_procedures: true,
                    supports_triggers: true,
                    supports_indexes: true,
                    supports_foreign_keys: true,
                    supports_partitions: *self != DatabaseType::GBase,
                    supports_cancel: false, // ODBC 取消机制不稳定，保守关闭
                    is_file_based: false,
                    identifier_quote: match self {
                        DatabaseType::SQLServer => '[',
                        _ => '"',
                    },
                    default_port: self.default_port(),
                }
            }
            DatabaseType::Plugin(_) => {
                DriverCapabilities {
                    supports_schemas: true,
                    supports_manage_tables: false,
                    supports_views: true,
                    supports_procedures: false,
                    supports_triggers: false,
                    supports_indexes: false,
                    supports_foreign_keys: false,
                    supports_partitions: false,
                    supports_cancel: false,
                    is_file_based: false,
                    identifier_quote: '"',
                    default_port: 0,
                }
            }
        }
    }
}
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过，无错误。若有新增变体未穷尽的 match 报错，逐一补全。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/types.rs
git commit -m "feat: extend DatabaseType with 10 new variants and full capabilities matrix"
```

---

### Task 2: 创建方言配置系统

**Files:**
- Create: `src-tauri/src/db/dialect.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 创建方言配置结构体**

```rust
// src-tauri/src/db/dialect.rs

use std::collections::HashMap;
use super::types::DatabaseType;

/// 标识符引用风格
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteStyle {
    Double,   // "identifier" (PG, GaussDB, Kingbase, Oracle)
    Backtick, // `identifier` (MySQL, ClickHouse, TiDB)
    Bracket,  // [identifier] (SQL Server, GBase 部分)
}

/// 分页语法
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitSyntax {
    LimitOffset,  // LIMIT N OFFSET M (PG, MySQL, SQLite)
    FetchNext,     // FETCH NEXT N ROWS ONLY (Oracle 12c+, DB2)
    TopN,          // SELECT TOP N (SQL Server 旧版)
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
```

- [ ] **Step 2: 定义标准 PG 方言配置**

```rust
// 继续在 src-tauri/src/db/dialect.rs

impl DialectConfig {
    /// PostgreSQL 标准方言 — 所有 PG 兼容库继承此配置
    pub fn pg_standard() -> Self {
        Self {
            db_type: DatabaseType::PostgreSQL,
            default_port: 5432,
            identifier_quote: QuoteStyle::Double,
            limit_syntax: LimitSyntax::LimitOffset,
            metadata_queries: MetadataQueries {
                list_databases: "SELECT datname FROM pg_database
                    WHERE datistemplate = false ORDER BY datname",
                list_schemas: "SELECT schema_name FROM information_schema.schemata
                    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                    ORDER BY schema_name",
                list_tables: "SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    AND table_type = 'BASE TABLE'
                    ORDER BY table_schema, table_name",
                list_views: "SELECT table_schema, table_name
                    FROM information_schema.views
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name",
                list_columns: "SELECT column_name, data_type, is_nullable,
                    column_default, ordinal_position, character_maximum_length,
                    numeric_precision, numeric_scale
                    FROM information_schema.columns
                    WHERE table_schema = $1 AND table_name = $2
                    ORDER BY ordinal_position",
                list_indexes: "SELECT indexname, indexdef
                    FROM pg_indexes
                    WHERE schemaname = $1 AND tablename = $2",
                list_foreign_keys: "SELECT tc.constraint_name,
                    kcu.column_name,
                    ccu.table_schema AS foreign_table_schema,
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                        ON tc.constraint_name = kcu.constraint_name
                        AND tc.table_schema = kcu.table_schema
                    JOIN information_schema.constraint_column_usage ccu
                        ON tc.constraint_name = ccu.constraint_name
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                    AND tc.table_schema = $1 AND tc.table_name = $2",
                list_procedures: "SELECT routine_schema, routine_name,
                    routine_type, data_type AS return_type
                    FROM information_schema.routines
                    WHERE routine_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY routine_schema, routine_name",
                list_triggers: "SELECT trigger_name, event_manipulation,
                    action_statement, action_timing
                    FROM information_schema.triggers
                    WHERE event_object_schema = $1
                    AND event_object_table = $2",
                table_row_count: "SELECT reltuples::bigint AS estimate
                    FROM pg_class WHERE oid = $1::regclass",
                explain_query: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}",
            },
            function_map: HashMap::new(),
        }
    }

    /// MySQL 标准方言
    pub fn mysql_standard() -> Self {
        Self {
            db_type: DatabaseType::MySQL,
            default_port: 3306,
            identifier_quote: QuoteStyle::Backtick,
            limit_syntax: LimitSyntax::LimitOffset,
            metadata_queries: MetadataQueries {
                list_databases: "SHOW DATABASES",
                list_schemas: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
                    ORDER BY SCHEMA_NAME",
                list_tables: "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
                    FROM information_schema.TABLES
                    WHERE TABLE_TYPE = 'BASE TABLE'
                    ORDER BY TABLE_SCHEMA, TABLE_NAME",
                list_views: "SELECT TABLE_SCHEMA, TABLE_NAME
                    FROM information_schema.VIEWS
                    ORDER BY TABLE_SCHEMA, TABLE_NAME",
                list_columns: "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
                    COLUMN_DEFAULT, ORDINAL_POSITION, CHARACTER_MAXIMUM_LENGTH,
                    NUMERIC_PRECISION, NUMERIC_SCALE
                    FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                    ORDER BY ORDINAL_POSITION",
                list_indexes: "SHOW INDEX FROM `{table}` FROM `{schema}`",
                list_foreign_keys: "SELECT CONSTRAINT_NAME, COLUMN_NAME,
                    REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME,
                    REFERENCED_COLUMN_NAME
                    FROM information_schema.KEY_COLUMN_USAGE
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                    AND REFERENCED_TABLE_NAME IS NOT NULL",
                list_procedures: "SELECT ROUTINE_SCHEMA, ROUTINE_NAME,
                    ROUTINE_TYPE, DTD_IDENTIFIER AS return_type
                    FROM information_schema.ROUTINES
                    ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
                list_triggers: "SELECT TRIGGER_NAME, EVENT_MANIPULATION,
                    ACTION_STATEMENT, ACTION_TIMING
                    FROM information_schema.TRIGGERS
                    WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?",
                table_row_count: "SELECT TABLE_ROWS FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                explain_query: "EXPLAIN FORMAT=JSON {}",
            },
            function_map: HashMap::new(),
        }
    }

    /// Kingbase 方言 — 基于 PG，覆盖差异
    pub fn kingbase() -> Self {
        let mut d = Self::pg_standard();
        d.db_type = DatabaseType::Kingbase;
        d.default_port = 54321;
        // Kingbase 某些版本用 SYSDATE 代替 NOW()
        d.function_map.insert("NOW()", "SYSDATE");
        d
    }

    /// Oracle 方言（ODBC 模式）
    pub fn oracle() -> Self {
        Self {
            db_type: DatabaseType::Oracle,
            default_port: 1521,
            identifier_quote: QuoteStyle::Double,
            limit_syntax: LimitSyntax::FetchNext,
            metadata_queries: MetadataQueries {
                list_databases: "SELECT NAME FROM v$database",
                list_schemas: "SELECT USERNAME FROM all_users ORDER BY USERNAME",
                list_tables: "SELECT OWNER, TABLE_NAME,
                    'BASE TABLE' AS TABLE_TYPE
                    FROM all_tables ORDER BY OWNER, TABLE_NAME",
                list_views: "SELECT OWNER, VIEW_NAME FROM all_views
                    ORDER BY OWNER, VIEW_NAME",
                list_columns: "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE,
                    DATA_DEFAULT, COLUMN_ID, CHAR_LENGTH,
                    DATA_PRECISION, DATA_SCALE
                    FROM all_tab_columns
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}'
                    ORDER BY COLUMN_ID",
                list_indexes: "SELECT INDEX_NAME, INDEX_TYPE, UNIQUENESS
                    FROM all_indexes
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}'",
                list_foreign_keys: "SELECT a.constraint_name,
                    a.column_name,
                    c.owner AS foreign_owner,
                    c.table_name AS foreign_table,
                    c.column_name AS foreign_column
                    FROM all_cons_columns a
                    JOIN all_constraints b ON a.constraint_name = b.constraint_name
                    JOIN all_cons_columns c ON b.r_constraint_name = c.constraint_name
                    WHERE b.constraint_type = 'R'
                    AND a.owner = '{schema}' AND b.table_name = '{table}'",
                list_procedures: "SELECT OWNER, OBJECT_NAME, OBJECT_TYPE
                    FROM all_procedures ORDER BY OWNER, OBJECT_NAME",
                list_triggers: "SELECT TRIGGER_NAME, TRIGGER_TYPE,
                    TRIGGERING_EVENT, STATUS
                    FROM all_triggers
                    WHERE OWNER = '{schema}' AND TABLE_NAME = '{table}'",
                table_row_count: "SELECT NUM_ROWS FROM all_tables
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
```

- [ ] **Step 3: 注册模块**

```rust
// src-tauri/src/db/mod.rs，在现有 pub mod 列表中添加：
pub mod dialect;
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/dialect.rs src-tauri/src/db/mod.rs
git commit -m "feat: add DialectConfig system with PG, MySQL, Kingbase, Oracle dialects"
```

---

### Task 3: 创建 PgCompatibleConnection（PG 协议兼容驱动基类）

**Files:**
- Create: `src-tauri/src/db/pg_compatible.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 创建 PgCompatibleConnection 结构体**

```rust
// src-tauri/src/db/pg_compatible.rs

use async_trait::async_trait;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::dialect::DialectConfig;
use super::trait_def::{DatabaseConnection, escape_identifier, json_value_to_sql};
use super::types::{
    ColumnInfo, DatabaseType, DbError, DriverCapabilities, ExecuteResult,
    PagedQueryResult, QueryResult, TableInfo,
};

pub struct PgCompatibleConnection {
    pool: PgPool,
    dialect: DialectConfig,
    /// 内部持有的 PostgresConnection 的核心资源
    /// 连接字符串格式: postgres://user:pass@host:port/dbname
    connection_string: String,
    cancel_token: tokio_util::sync::CancellationToken,
}

impl PgCompatibleConnection {
    pub async fn new(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        database: &str,
        dialect: DialectConfig,
    ) -> Result<Self, DbError> {
        let conn_str = format!(
            "postgres://{}:{}@{}:{}/{}",
            user, password, host, port, database
        );
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&conn_str)
            .await
            .map_err(|e| DbError::ConnectionError(e.to_string()))?;

        Ok(Self {
            pool,
            dialect,
            connection_string: conn_str,
            cancel_token: tokio_util::sync::CancellationToken::new(),
        })
    }

    pub fn dialect(&self) -> &DialectConfig {
        &self.dialect
    }

    pub fn cancel_token(&self) -> &tokio_util::sync::CancellationToken {
        &self.cancel_token
    }

    /// 使用方言配置中的元数据查询获取表列表
    pub async fn fetch_tables_with_dialect(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_tables;
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        // 解析为 TableInfo vec
        let tables: Vec<TableInfo> = rows.iter().map(|row| {
            let schema: String = row.try_get(0).unwrap_or_default();
            let name: String = row.try_get(1).unwrap_or_default();
            let table_type: String = row.try_get(2).unwrap_or_default();
            TableInfo {
                schema_name: if schema.is_empty() { None } else { Some(schema) },
                table_name: name,
                table_type,
            }
        }).collect();
        Ok(tables)
    }
}

#[async_trait]
impl DatabaseConnection for PgCompatibleConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        // 使用 sqlx PG 驱动执行
        let result = sqlx::query(sql)
            .execute(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(ExecuteResult {
            rows_affected: result.rows_affected(),
            last_insert_id: None,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        // 使用 sqlx 原生查询，动态解析列和行
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        // ... 解析逻辑（复用现有 postgres.rs 中的解析代码）
        todo!("复用现有 postgres.rs 的结果集解析逻辑")
    }

    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        let paged_sql = format!("{} LIMIT {} OFFSET {}", sql, limit + 1, offset);
        let mut result = self.query_sql(&paged_sql).await?;
        let has_more = result.rows.len() as u64 > limit;
        if has_more {
            result.rows.truncate(limit as usize);
        }
        Ok((result, has_more))
    }

    fn db_type(&self) -> DatabaseType {
        self.dialect.db_type.clone()
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    // get_tables, get_columns, get_schemas 等方法使用 dialect.metadata_queries
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        self.fetch_tables_with_dialect().await
    }

    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_columns;
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        // 解析为 Vec<ColumnInfo>
        let columns = rows.iter().map(|row| {
            ColumnInfo {
                name: row.try_get(0).unwrap_or_default(),
                data_type: row.try_get(1).unwrap_or_default(),
                nullable: row.try_get::<String, _>(2).unwrap_or_default() == "YES",
                default_value: row.try_get(3).ok(),
                ordinal: row.try_get::<i32, _>(4).unwrap_or(0) as usize,
                max_length: row.try_get(5).ok(),
                numeric_precision: row.try_get(6).ok(),
                numeric_scale: row.try_get(7).ok(),
                is_primary_key: false,
            }
        }).collect();
        Ok(columns)
    }

    // get_schemas, get_views, get_indexes, get_foreign_keys 模式相同
    // 使用 dialect.metadata_queries 中对应的 SQL 模板

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = self.dialect.metadata_queries.list_schemas;
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(rows.iter().map(|r| r.try_get(0).unwrap_or_default()).collect())
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let schema = schema.unwrap_or("public");
        let sql = format!(
            "SELECT 'CREATE TABLE ' || quote_ident($1) || '.' || quote_ident($2) || ' (' || chr(10)
            || string_agg('    ' || quote_ident(column_name) || ' ' || data_type
                || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
                || CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
                ',' || chr(10))
            || chr(10) || ');'
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2",
        );
        let row: (String,) = sqlx::query_as(&sql)
            .bind(schema)
            .bind(table)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(row.0)
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_views;
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(rows.iter().map(|r| TableInfo {
            schema_name: Some(r.try_get(0).unwrap_or_default()),
            table_name: r.try_get(1).unwrap_or_default(),
            table_type: "VIEW".into(),
        }).collect())
    }

    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let sql = self.dialect.metadata_queries.list_indexes;
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let indexes: Vec<serde_json::Value> = rows.iter().map(|r| {
            serde_json::json!({
                "index_name": r.try_get::<String, _>(0).unwrap_or_default(),
                "index_def": r.try_get::<String, _>(1).unwrap_or_default(),
            })
        }).collect();
        Ok(indexes)
    }

    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let sql = self.dialect.metadata_queries.list_foreign_keys;
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let fks: Vec<serde_json::Value> = rows.iter().map(|r| {
            serde_json::json!({
                "constraint_name": r.try_get::<String, _>(0).unwrap_or_default(),
                "column_name": r.try_get::<String, _>(1).unwrap_or_default(),
                "foreign_schema": r.try_get::<String, _>(2).unwrap_or_default(),
                "foreign_table": r.try_get::<String, _>(3).unwrap_or_default(),
                "foreign_column": r.try_get::<String, _>(4).unwrap_or_default(),
            })
        }).collect();
        Ok(fks)
    }

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let schema = schema.unwrap_or("public");
        let sql = format!(
            "SELECT COUNT(*) FROM \"{}\".\"{}\"",
            schema, table
        );
        let row: (i64,) = sqlx::query_as(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        Ok(row.0 as u64)
    }

    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let schema = schema.unwrap_or("public");
        let offset = (page.saturating_sub(1)) as u64 * page_size as u64;
        let order = order_by.unwrap_or("1");
        let sql = format!(
            "SELECT * FROM \"{}\".\"{}\" ORDER BY {} LIMIT {} OFFSET {}",
            schema, table, order, page_size, offset
        );
        self.query_sql(&sql).await
    }

    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        let schema = schema.unwrap_or("public");
        let set_clause: Vec<String> = updates.iter()
            .map(|(col, val)| format!("\"{}\" = {}", col, json_value_to_sql(val)))
            .collect();
        let sql = format!(
            "UPDATE \"{}\".\"{}\" SET {} WHERE {}",
            schema, table, set_clause.join(", "), where_clause
        );
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        let schema = schema.unwrap_or("public");
        let cols: Vec<String> = values.iter().map(|(col, _)| format!("\"{}\"", col)).collect();
        let vals: Vec<String> = values.iter().map(|(_, val)| json_value_to_sql(val)).collect();
        let sql = format!(
            "INSERT INTO \"{}\".\"{}\" ({}) VALUES ({})",
            schema, table, cols.join(", "), vals.join(", ")
        );
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        let schema = schema.unwrap_or("public");
        let sql = format!(
            "DELETE FROM \"{}\".\"{}\" WHERE {}",
            schema, table, where_clause
        );
        self.execute_sql(&sql).await
    }
}
```

- [ ] **Step 2: 注册模块**

```rust
// src-tauri/src/db/mod.rs 添加：
pub mod pg_compatible;
```

- [ ] **Step 3: 添加 tokio-util 依赖**

```toml
# src-tauri/Cargo.toml，在 dependencies 中添加：
tokio-util = { version = "0.7", features = ["rt"] }
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过（query_sql 中的 todo! 先保留，Task 4 中从 postgres.rs 迁移解析逻辑时填充）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/pg_compatible.rs src-tauri/src/db/mod.rs src-tauri/Cargo.toml
git commit -m "feat: add PgCompatibleConnection base driver with dialect-driven metadata"
```

---

### Task 4: 重构 GaussDB 驱动为 PgCompatible 子类

**Files:**
- Modify: `src-tauri/src/db/gaussdb.rs`
- Modify: `src-tauri/src/db/postgres.rs`

- [ ] **Step 1: 将 postgres.rs 的结果集解析逻辑提取为公共函数**

```rust
// 在 src-tauri/src/db/postgres.rs 中，将 query_sql 的解析逻辑提取为 pub 函数

pub fn parse_pg_rows(
    rows: &[sqlx::postgres::PgRow],
) -> Result<(Vec<ColumnInfo>, Vec<Vec<serde_json::Value>>), DbError> {
    let columns = if let Some(first) = rows.first() {
        first.columns().iter().map(|col| ColumnInfo {
            name: col.name().to_string(),
            data_type: col.type_info().name().to_string(),
            nullable: true,
            default_value: None,
            ordinal: col.ordinal(),
            max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            is_primary_key: false,
        }).collect()
    } else {
        vec![]
    };

    let row_values: Vec<Vec<serde_json::Value>> = rows.iter().map(|row| {
        (0..row.columns().len()).map(|i| {
            // 尝试各种类型
            if let Ok(v) = row.try_get::<String, _>(i) {
                return serde_json::Value::String(v);
            }
            if let Ok(v) = row.try_get::<i64, _>(i) {
                return serde_json::json!(v);
            }
            if let Ok(v) = row.try_get::<f64, _>(i) {
                return serde_json::json!(v);
            }
            if let Ok(v) = row.try_get::<bool, _>(i) {
                return serde_json::Value::Bool(v);
            }
            serde_json::Value::Null
        }).collect()
    }).collect();

    Ok((columns, row_values))
}
```

- [ ] **Step 2: 重写 gaussdb.rs**

```rust
// src-tauri/src/db/gaussdb.rs
// 删除原有的独立 DatabaseConnection 实现（~997 行）
// 改为基于 PgCompatibleConnection 的薄封装

use async_trait::async_trait;
use super::dialect::DialectConfig;
use super::pg_compatible::PgCompatibleConnection;
use super::trait_def::DatabaseConnection;
use super::types::{DatabaseType, DbError, QueryResult};

pub struct GaussDBConnection {
    inner: PgCompatibleConnection,
}

impl GaussDBConnection {
    pub async fn new(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        database: &str,
    ) -> Result<Self, DbError> {
        let dialect = DialectConfig::pg_standard();
        // GaussDB 默认端口 5432 或 8000（取决于版本）
        let mut dialect = dialect;
        dialect.db_type = DatabaseType::GaussDB;

        let inner = PgCompatibleConnection::new(host, port, user, password, database, dialect).await?;
        Ok(Self { inner })
    }
}

#[async_trait]
impl DatabaseConnection for GaussDBConnection {
    // 所有方法委托给 inner，GaussDB 暂时没有需要特殊覆盖的行为
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        self.inner.execute_sql(sql).await
    }
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        self.inner.query_sql(sql).await
    }
    async fn query_sql_paged(&self, sql: &str, limit: u64, offset: u64) -> Result<(QueryResult, bool), DbError> {
        self.inner.query_sql_paged(sql, limit, offset).await
    }
    fn db_type(&self) -> DatabaseType {
        DatabaseType::GaussDB
    }
    async fn close(&self) {
        self.inner.close().await;
    }
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        self.inner.get_tables().await
    }
    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        self.inner.get_columns(table, schema).await
    }
    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        self.inner.get_schemas().await
    }
    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> {
        self.inner.export_table_sql(table, schema).await
    }
    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        self.inner.get_views(schema).await
    }
    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<serde_json::Value>, DbError> {
        self.inner.get_indexes(table, schema).await
    }
    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<serde_json::Value>, DbError> {
        self.inner.get_foreign_keys(table, schema).await
    }
    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> {
        self.inner.get_table_row_count(table, schema).await
    }
    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        self.inner.get_table_data(table, schema, page, page_size, order_by).await
    }
    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, serde_json::Value)], where_clause: &str) -> Result<ExecuteResult, DbError> {
        self.inner.update_table_rows(table, schema, updates, where_clause).await
    }
    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, serde_json::Value)]) -> Result<ExecuteResult, DbError> {
        self.inner.insert_table_row(table, schema, values).await
    }
    async fn delete_table_rows(&self, table: &str, schema: Option<&str>, where_clause: &str) -> Result<ExecuteResult, DbError> {
        self.inner.delete_table_rows(table, schema, where_clause).await
    }
}
```

- [ ] **Step 3: 删除原 gaussdb.rs 中 tokio-gaussdb / tokio-opengauss 的自定义协议代码**

原有的 `GaussClient` enum、`GaussDbTlsConnector`、`simple_query_to_results!` 宏等独立实现代码删除，因为现在通过 `PgCompatibleConnection` 使用 sqlx PG 协议。

- [ ] **Step 4: 更新 manager.rs 中 GaussDB 的连接创建逻辑**

```rust
// src-tauri/src/db/manager.rs
// 找到创建 GaussDB 连接的 match 分支，改为调用新的构造函数

// 旧代码大致是:
DatabaseType::GaussDB => {
    let conn = GaussDBConnection::connect(&config).await?;
    // ...
}
// 改为:
DatabaseType::GaussDB => {
    let conn = GaussDBConnection::new(
        &config.host, config.port,
        &config.user, &config.password, &config.database,
    ).await?;
    // ...
}
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过。如有旧 GaussDB 代码的引用报错，逐一修正。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/gaussdb.rs src-tauri/src/db/postgres.rs src-tauri/src/db/manager.rs
git commit -m "refactor: rewrite GaussDB as thin wrapper over PgCompatibleConnection (~997→~70 lines)"
```

---

### Task 5: 创建 ODBC 桥接驱动

**Files:**
- Create: `src-tauri/src/db/odbc_bridge.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: 添加 odbc-api 依赖**

```toml
# src-tauri/Cargo.toml
odbc-api = { version = "8", features = ["narrow"] }
```

- [ ] **Step 2: 创建 OdbcConnection**

```rust
// src-tauri/src/db/odbc_bridge.rs

use async_trait::async_trait;
use odbc_api::Environment;
use std::sync::Mutex;
use super::dialect::DialectConfig;
use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

/// ODBC 桥接驱动 —— 一次实现覆盖所有有 ODBC 驱动的数据库
pub struct OdbcConnection {
    dialect: DialectConfig,
    connection_string: String,
    /// ODBC 不是异步的，用 spawn_blocking 包装
    env: Mutex<Option<Environment>>,
}

impl OdbcConnection {
    pub fn new(dialect: DialectConfig, connection_string: String) -> Result<Self, DbError> {
        let env = Environment::new()
            .map_err(|e| DbError::ConnectionError(format!("ODBC 环境初始化失败: {}", e)))?;
        Ok(Self {
            dialect,
            connection_string,
            env: Mutex::new(Some(env)),
        })
    }

    /// 将 ODBC 同步调用包装到 tokio spawn_blocking 中
    async fn odbc_query(&self, sql: &str) -> Result<QueryResult, DbError> {
        let conn_str = self.connection_string.clone();
        let sql = sql.to_string();
        let dialect_db_type = self.dialect.db_type.clone();

        tokio::task::spawn_blocking(move || {
            let env = Environment::new()
                .map_err(|e| DbError::ConnectionError(e.to_string()))?;
            let conn = env
                .connect_with_connection_string(&conn_str)
                .map_err(|e| DbError::ConnectionError(e.to_string()))?;

            // 执行查询
            let cursor = conn
                .execute(&sql, ())
                .map_err(|e| DbError::QueryError(format!("ODBC 查询失败: {}", e)))?;

            // 提取列信息
            let num_cols = cursor.num_result_cols()
                .map_err(|e| DbError::QueryError(format!("无法获取列数: {}", e)))?;
            let columns: Vec<ColumnInfo> = (1..=num_cols).map(|i| {
                ColumnInfo {
                    name: format!("col_{}", i),
                    data_type: "text".into(),
                    nullable: true,
                    default_value: None,
                    ordinal: i as usize,
                    max_length: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    is_primary_key: false,
                }
            }).collect();

            // 流式读取行（最多 500 行防止 OOM）
            let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
            let mut row_cursor = cursor
                .bind_step()
                .map_err(|e| DbError::QueryError(e.to_string()))?;

            while let Some(data) = row_cursor.fetch().map_err(|e| DbError::QueryError(e.to_string()))? {
                let row: Vec<serde_json::Value> = (1..=num_cols)
                    .map(|i| {
                        data.get::<&str>(i as u16)
                            .ok()
                            .flatten()
                            .map(|s| serde_json::Value::String(s.to_string()))
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect();
                rows.push(row);
                if rows.len() >= 500 {
                    break;
                }
            }

            Ok(QueryResult { columns, rows })
        })
        .await
        .map_err(|e| DbError::QueryError(format!("ODBC 线程 panic: {:?}", e)))?
    }
}

#[async_trait]
impl DatabaseConnection for OdbcConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let conn_str = self.connection_string.clone();
        let sql = sql.to_string();

        tokio::task::spawn_blocking(move || {
            let env = Environment::new()
                .map_err(|e| DbError::ConnectionError(e.to_string()))?;
            let conn = env
                .connect_with_connection_string(&conn_str)
                .map_err(|e| DbError::ConnectionError(e.to_string()))?;

            conn.execute(&sql, ())
                .map_err(|e| DbError::QueryError(e.to_string()))?;

            Ok(ExecuteResult {
                rows_affected: 0, // ODBC narrow 接口不返回精确行数
                last_insert_id: None,
            })
        })
        .await
        .map_err(|e| DbError::QueryError(format!("ODBC 线程 panic: {:?}", e)))?
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        self.odbc_query(sql).await
    }

    async fn query_sql_paged(
        &self,
        sql: &str,
        limit: u64,
        offset: u64,
    ) -> Result<(QueryResult, bool), DbError> {
        let paged_sql = match self.dialect.limit_syntax {
            LimitSyntax::FetchNext => {
                format!("{} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY", sql, offset, limit + 1)
            }
            _ => {
                format!("{} LIMIT {} OFFSET {}", sql, limit + 1, offset)
            }
        };
        let mut result = self.odbc_query(&paged_sql).await?;
        let has_more = result.rows.len() as u64 > limit;
        if has_more {
            result.rows.truncate(limit as usize);
        }
        Ok((result, has_more))
    }

    fn db_type(&self) -> DatabaseType {
        self.dialect.db_type.clone()
    }

    async fn close(&self) {
        // ODBC Environment 在 drop 时自动清理
    }

    // 元数据方法都通过方言配置的 SQL 查询
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_tables;
        let result = self.odbc_query(sql).await?;
        let tables = result.rows.iter().map(|row| {
            TableInfo {
                schema_name: row.get(0).and_then(|v| v.as_str().map(String::from)),
                table_name: row.get(1).and_then(|v| v.as_str().unwrap_or("").to_string()).unwrap_or_default(),
                table_type: row.get(2).and_then(|v| v.as_str().unwrap_or("BASE TABLE").to_string()).unwrap_or("BASE TABLE".into()),
            }
        }).collect();
        Ok(tables)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = self.dialect.metadata_queries.list_schemas;
        let result = self.odbc_query(sql).await?;
        Ok(result.rows.iter()
            .filter_map(|r| r.first()?.as_str().map(String::from))
            .collect())
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let sql = self.dialect.metadata_queries.list_columns
            .replace("{schema}", schema.unwrap_or(""))
            .replace("{table}", table);
        let result = self.odbc_query(&sql).await?;
        let columns = result.rows.iter().map(|row| {
            ColumnInfo {
                name: row.get(0).and_then(|v| v.as_str().unwrap_or("").to_string()).unwrap_or_default(),
                data_type: row.get(1).and_then(|v| v.as_str().unwrap_or("text").to_string()).unwrap_or("text".into()),
                nullable: row.get(2).and_then(|v| v.as_str()).unwrap_or("YES") != "NO",
                default_value: row.get(3).and_then(|v| v.as_str().map(String::from)),
                ordinal: row.get(4).and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                max_length: row.get(5).and_then(|v| v.as_u64()),
                numeric_precision: row.get(6).and_then(|v| v.as_u64()),
                numeric_scale: row.get(7).and_then(|v| v.as_u64()),
                is_primary_key: false,
            }
        }).collect();
        Ok(columns)
    }

    // 其余 trait 方法类似 —— 使用 dialect.metadata_queries + odbc_query()
    // ...（完整实现需要在 plan 执行时补充 get_views, get_indexes,
    //      get_foreign_keys, get_table_row_count, etc.）
}
```

- [ ] **Step 3: 注册模块**

```rust
// src-tauri/src/db/mod.rs
pub mod odbc_bridge;
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/odbc_bridge.rs src-tauri/src/db/mod.rs src-tauri/Cargo.toml
git commit -m "feat: add ODBC bridge driver for Oracle, SQL Server, DaMeng, GBase"
```

---

### Task 6: ClickHouse 连接池修复

**Files:**
- Modify: `src-tauri/src/db/clickhouse.rs`

- [ ] **Step 1: 将 reqwest::Client 提升为结构体字段实现连接复用**

```rust
// src-tauri/src/db/clickhouse.rs
// 当前 ClickHouseConnection 可能是每次 query 新建 reqwest 请求

// 在结构体中添加 client 字段：
pub struct ClickHouseConnection {
    client: reqwest::Client,    // 新增：复用 TCP 连接
    base_url: String,
    user: String,
    password: String,
    database: String,
}

impl ClickHouseConnection {
    pub fn new(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        database: &str,
    ) -> Self {
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(5)   // 每个 host 最多 5 个空闲连接
            .pool_idle_timeout(Some(std::time::Duration::from_secs(90)))
            .build()
            .expect("Failed to create reqwest Client");

        Self {
            client,
            base_url: format!("http://{}:{}", host, port),
            user: user.to_string(),
            password: password.to_string(),
            database: database.to_string(),
        }
    }

    // 所有查询改用 self.client.post() 而非 reqwest::post()
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let url = format!("{}/?database={}&query={}",
            self.base_url, self.database,
            urlencoding::encode(sql)
        );
        let resp = self.client
            .get(&url)
            .basic_auth(&self.user, Some(&self.password))
            .send()
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        // ... 解析 JSONEachRow 响应
        todo!("复用现有 ClickHouse 响应解析逻辑，仅替换 client 来源")
    }
}
```

- [ ] **Step 2: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/clickhouse.rs
git commit -m "perf: add connection pool to ClickHouse via reqwest::Client reuse"
```

---

### Task 7: 前端 —— 复制为 Markdown 表格

**Files:**
- Modify: `src/components/EditorPanel.tsx`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: 添加 i18n 键**

```typescript
// src/lib/i18n.ts，在 translations 对象中添加：
copyAsMarkdown: {
  zh: "复制为 Markdown",
  en: "Copy as Markdown",
},
```

- [ ] **Step 2: 实现 Markdown 转换函数和右键菜单项**

```typescript
// 在 src/components/EditorPanel.tsx 中

// 新增工具函数
function rowsToMarkdown(
  columns: { name: string }[],
  rows: Record<string, unknown>[]
): string {
  if (rows.length === 0) return "";
  const headers = columns.map(c => c.name);
  const separator = headers.map(() => "---");

  const body = rows.map(row =>
    "| " + headers.map(h => {
      const val = row[h];
      if (val === null || val === undefined) return "";
      return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ");
    }).join(" | ") + " |"
  );

  return [
    "| " + headers.join(" | ") + " |",
    "| " + separator.join(" | ") + " |",
    ...body,
  ].join("\n");
}

// 在右键菜单中添加菜单项（找到现有的 context menu 代码位置）
// 右键菜单项中新增：
{
  label: t("copyAsMarkdown"),
  icon: <ClipboardList />,
  onClick: async () => {
    const md = rowsToMarkdown(columns, selectedRows);
    await navigator.clipboard.writeText(md);
  }
}
```

- [ ] **Step 3: 运行前端开发服务器验证功能**

```bash
npm run dev:mock
```

在浏览器中：选中查询结果行 → 右键 → "复制为 Markdown" → 粘贴到编辑器检查格式。

- [ ] **Step 4: Commit**

```bash
git add src/components/EditorPanel.tsx src/lib/i18n.ts
git commit -m "feat: add 'Copy as Markdown' to result grid context menu"
```

---

### Task 8: 前端 —— 结果集右键快速图表

**Files:**
- Create: `src/components/QuickChartPanel.tsx`
- Modify: `src/components/EditorPanel.tsx`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: 添加 i18n 键**

```typescript
// src/lib/i18n.ts
generateChart: {
  zh: "生成图表",
  en: "Generate Chart",
},
chartType: {
  zh: "图表类型",
  en: "Chart Type",
},
```

- [ ] **Step 2: 创建 QuickChartPanel 组件**

```typescript
// src/components/QuickChartPanel.tsx

import { useState, useMemo } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { X } from "lucide-react";

type ChartType = "bar" | "line" | "pie" | "scatter";

interface QuickChartPanelProps {
  columns: string[];
  rows: Record<string, unknown>[];
  xColumn: string;
  yColumn: string;
  onClose: () => void;
}

function inferChartType(rows: Record<string, unknown>[], xCol: string, yCol: string): ChartType {
  const xVal = rows[0]?.[xCol];
  const yVal = rows[0]?.[yCol];

  const xIsNumeric = typeof xVal === "number";
  const yIsNumeric = typeof yVal === "number";
  const xIsDate = typeof xVal === "string" && !isNaN(Date.parse(xVal as string));

  if (xIsNumeric && yIsNumeric) return "scatter";
  if (xIsDate && yIsNumeric) return "line";
  if (!xIsNumeric && yIsNumeric) return "bar";
  return "bar";
}

export default function QuickChartPanel({ columns, rows, xColumn, yColumn, onClose }: QuickChartPanelProps) {
  const defaultType = inferChartType(rows, xColumn, yColumn);
  const [chartType, setChartType] = useState<ChartType>(defaultType);

  const colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

  const chartData = useMemo(() => {
    if (chartType === "pie") {
      return rows.map(row => ({
        name: String(row[xColumn] ?? ""),
        value: Number(row[yColumn]) || 0,
      }));
    }
    return rows.map(row => ({ ...row }));
  }, [rows, xColumn, yColumn, chartType]);

  return (
    <div className="fixed bottom-4 right-4 w-[600px] h-[400px] bg-white dark:bg-gray-800
      rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 p-4 z-50">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">图表</span>
          <select
            value={chartType}
            onChange={e => setChartType(e.target.value as ChartType)}
            className="text-xs border rounded px-2 py-1 dark:bg-gray-700"
          >
            <option value="bar">柱状图</option>
            <option value="line">折线图</option>
            <option value="pie">饼图</option>
            <option value="scatter">散点图</option>
          </select>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          <X size={16} />
        </button>
      </div>
      <ResponsiveContainer width="100%" height="85%">
        {chartType === "bar" ? (
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xColumn} />
            <YAxis />
            <Tooltip />
            <Bar dataKey={yColumn} fill={colors[0]} />
          </BarChart>
        ) : chartType === "line" ? (
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xColumn} />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey={yColumn} stroke={colors[0]} />
          </LineChart>
        ) : chartType === "pie" ? (
          <PieChart>
            <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%"
              outerRadius={120} label={({ name, value }) => `${name}: ${value}`}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={colors[i % colors.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        ) : (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xColumn} />
            <YAxis dataKey={yColumn} />
            <Tooltip />
            <Scatter data={chartData} fill={colors[0]} />
          </ScatterChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: 在 EditorPanel 右键菜单中加入"生成图表"**

```typescript
// 在 EditorPanel.tsx 的右键菜单中添加：

// 新增 state
const [chartPanel, setChartPanel] = useState<{
  columns: string[]; rows: Record<string, unknown>[];
} | null>(null);

// 右键菜单项
{
  label: t("generateChart"),
  icon: <BarChart3 />, // from lucide-react
  onClick: () => {
    const selectedCols = columns.map(c => c.name);
    // 默认选前两列作为 X 和 Y 轴
    setChartPanel({ columns: selectedCols, rows: selectedRows });
  }
}

// 在 JSX 底部渲染
{chartPanel && (
  <QuickChartPanel
    columns={chartPanel.columns}
    rows={chartPanel.rows}
    xColumn={chartPanel.columns[0] ?? ""}
    yColumn={chartPanel.columns[1] ?? ""}
    onClose={() => setChartPanel(null)}
  />
)}
```

- [ ] **Step 4: 运行并验证**

```bash
npm run dev:mock
```

Mock 模式下查询结果 → 选中行 → 右键生成图表 → 切换图表类型 → 关闭。

- [ ] **Step 5: Commit**

```bash
git add src/components/QuickChartPanel.tsx src/components/EditorPanel.tsx src/lib/i18n.ts
git commit -m "feat: add one-click chart generation from result grid context menu"
```

---

### Task 9: 集成测试与回归验证

**Files:**
- 无新建文件，验证现有功能未破坏

- [ ] **Step 1: Rust 编译检查**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 0 errors。

- [ ] **Step 2: Rust 测试**

```bash
cd src-tauri && cargo test 2>&1
```

Expected: 现有测试全部通过。

- [ ] **Step 3: 前端类型检查与测试**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: 类型检查通过，单元测试通过。

- [ ] **Step 4: 全量检查**

```bash
npm run test:all
```

Expected: 全部通过。

- [ ] **Step 5: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: address test failures from architecture refactor"
```

---

### Task 10: shadcn/ui 初始化与 Mac 主题配置

**Files:**
- Modify: `src/styles/index.css` (或新建 `src/styles/globals.css`)
- Modify: `src-tauri/tauri.conf.json`
- Create: `src/components/ui/*` (shadcn 组件目录)
- Modify: `package.json` (新增依赖)

- [ ] **Step 1: 初始化 shadcn/ui**

```bash
npx shadcn@latest init
```

交互选择：
- Style: `New York`
- Base color: `Neutral`
- CSS variables: `Yes`
- Tailwind config: `src/styles/globals.css`

- [ ] **Step 2: 安装组件库和 sonner**

```bash
npx shadcn@latest add button input dialog dropdown-menu context-menu tabs tooltip sheet select table scroll-area separator badge skeleton

npm install sonner
```

- [ ] **Step 3: 覆盖 CSS 变量为 Mac 风格**

```css
/* src/styles/globals.css */
@import "tailwindcss";

@layer base {
  :root {
    --background: 240 5% 96%;
    --foreground: 240 2% 10%;
    --card: 0 0% 100%;
    --card-foreground: 240 2% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 2% 10%;
    --primary: 211 100% 45%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 5% 92%;
    --secondary-foreground: 240 2% 10%;
    --muted: 240 5% 92%;
    --muted-foreground: 240 4% 54%;
    --accent: 240 5% 92%;
    --accent-foreground: 240 2% 10%;
    --destructive: 0 84% 52%;
    --border: 240 4% 90%;
    --input: 240 4% 90%;
    --ring: 211 100% 45%;
    --radius: 0.625rem;
  }

  .dark {
    --background: 240 3% 11%;
    --foreground: 240 5% 96%;
    --card: 240 3% 16%;
    --card-foreground: 240 5% 96%;
    --popover: 240 3% 16%;
    --popover-foreground: 240 5% 96%;
    --primary: 210 79% 56%;
    --primary-foreground: 240 5% 96%;
    --secondary: 240 3% 20%;
    --secondary-foreground: 240 5% 96%;
    --muted: 240 3% 20%;
    --muted-foreground: 240 4% 60%;
    --accent: 240 3% 20%;
    --accent-foreground: 240 5% 96%;
    --destructive: 0 72% 45%;
    --border: 240 3% 22%;
    --input: 240 3% 22%;
    --ring: 210 79% 56%;
  }
}
```

- [ ] **Step 4: 配置无边框窗口**

```json
// src-tauri/tauri.conf.json — 在 app.windows 数组中修改:
{
  "label": "main",
  "decorations": false,
  "transparent": true,
  "titleBarStyle": "Overlay"
}
```

- [ ] **Step 5: 验证 shadcn 组件可用**

```bash
npm run dev:mock
```

确认 Button、Dialog 等组件渲染正常，深色/浅色切换正常。

- [ ] **Step 6: Commit**

```bash
git add src/styles/globals.css src/components/ui/ src-tauri/tauri.conf.json package.json package-lock.json
git commit -m "feat: add shadcn/ui with Mac-style theme, sonner toast, borderless window config"
```

---

### Task 11: 用 shadcn/ui 替换核心组件

**Files:**
- Modify: `src/components/Toolbar.tsx` → 使用 shadcn Button, Separator, Tooltip
- Modify: `src/components/Sidebar.tsx` → 毛玻璃背景, shadcn ScrollArea
- Modify: `src/components/TabBar.tsx` → shadcn Tabs
- Modify: `src/components/ConnectionDialog.tsx` → shadcn Dialog, Input, Select
- Modify: `src/components/EditorPanel.tsx` → shadcn ContextMenu, Badge
- Modify: `src/components/CrabHubMainPanel.tsx` → shadcn Table (表头)
- Modify: `src/components/AIPanel.tsx` → shadcn Sheet
- Create: `src/components/TitleBar.tsx`

- [ ] **Step 1: 创建自定义标题栏**

```tsx
// src/components/TitleBar.tsx
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const appWindow = getCurrentWindow();

  return (
    <div data-tauri-drag-region
      className="flex items-center justify-between h-10 px-3
        bg-background/80 backdrop-blur-xl border-b border-border/50
        select-none">
      <div className="flex items-center gap-2 pl-[70px]">
        <span className="text-xs font-medium text-muted-foreground">CrabHub</span>
      </div>
      <div className="flex items-center gap-0.5">
        <button onClick={() => appWindow.minimize()}
          className="p-2 hover:bg-secondary rounded-md transition-colors">
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button onClick={() => appWindow.toggleMaximize()}
          className="p-2 hover:bg-secondary rounded-md transition-colors">
          <Square size={12} strokeWidth={1.5} />
        </button>
        <button onClick={() => appWindow.close()}
          className="p-2 hover:bg-destructive hover:text-destructive-foreground rounded-md transition-colors">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 替换 Sidebar 为毛玻璃风格**

```tsx
// src/components/Sidebar.tsx 关键改动:
<aside className="flex flex-col h-full
  bg-white/70 dark:bg-gray-900/70
  backdrop-blur-xl backdrop-saturate-150
  border-r border-border/50
  transition-all duration-200">
  <ScrollArea className="flex-1">
    {/* 现有连接树内容 */}
  </ScrollArea>
</aside>
```

- [ ] **Step 3: 替换 Toolbar 按钮为 shadcn Button**

```tsx
// src/components/Toolbar.tsx — 将手写 button 替换为：
import { Button } from "@/components/ui/button";

<Button variant="ghost" size="icon" onClick={handleNewQuery}>
  <Plus size={18} strokeWidth={1.5} />
</Button>
```

- [ ] **Step 4: 替换 ConnectionDialog 为 shadcn Dialog**

```tsx
// src/components/ConnectionDialog.tsx — 改用 shadcn Dialog:
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="sm:max-w-[520px]">
    <DialogHeader>
      <DialogTitle>{t("newConnection")}</DialogTitle>
    </DialogHeader>
    {/* 表单内容 */}
    <DialogFooter>
      <Button variant="outline" onClick={onCancel}>{t("cancel")}</Button>
      <Button onClick={onSave}>{t("connect")}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5: 替换右键菜单为 shadcn ContextMenu / DropdownMenu**

```tsx
// EditorPanel.tsx 中：
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuShortcut,
} from "@/components/ui/context-menu";

<ContextMenu>
  <ContextMenuTrigger>
    {/* 表格行 */}
  </ContextMenuTrigger>
  <ContextMenuContent className="w-48">
    <ContextMenuItem onClick={handleCopyAsMarkdown}>
      {t("copyAsMarkdown")}
      <ContextMenuShortcut>⌘⇧M</ContextMenuShortcut>
    </ContextMenuItem>
    <ContextMenuItem onClick={handleGenerateChart}>
      {t("generateChart")}
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onClick={handleExportCSV}>
      {t("exportCSV")}
    </ContextMenuMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

- [ ] **Step 6: 在 MainLayout 中集成 TitleBar**

```tsx
// src/components/MainLayout.tsx — 在顶层 div 添加：
<div className="flex flex-col h-screen overflow-hidden bg-background">
  <TitleBar />
  <div className="flex-1 flex overflow-hidden">
    {/* 现有 PanelGroup 内容 */}
  </div>
</div>
```

- [ ] **Step 7: 运行验证**

```bash
npm run dev:mock
```

逐个检查：标题栏按钮、侧边栏毛玻璃效果、连接弹窗、右键菜单、Tooltip 提示。

- [ ] **Step 8: Commit**

```bash
git add src/components/TitleBar.tsx src/components/Toolbar.tsx src/components/Sidebar.tsx \
  src/components/TabBar.tsx src/components/ConnectionDialog.tsx \
  src/components/EditorPanel.tsx src/components/CrabHubMainPanel.tsx \
  src/components/AIPanel.tsx src/components/MainLayout.tsx \
  src/components/SnippetPanel.tsx
git commit -m "refactor: replace core components with shadcn/ui, add Mac-style sidebar and titlebar"
```

---

### Task 12: AI Agent Runtime（Rust 后端）

**Files:**
- Create: `src-tauri/src/ai/agent.rs`
- Create: `src-tauri/src/ai/tools.rs`
- Create: `src-tauri/src/ai/safety.rs`
- Create: `src-tauri/src/ai/context.rs`
- Modify: `src-tauri/src/ai/commands.rs`
- Modify: `src-tauri/src/ai/mod.rs`
- Modify: `src-tauri/src/db/manager.rs`

- [ ] **Step 1: 创建工具注册表**

```rust
// src-tauri/src/ai/tools.rs

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use crate::db::manager::ConnectionManager;

#[derive(Debug, Clone, Serialize)]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    /// JSON Schema for parameters
    pub parameters: Value,
    pub danger_level: DangerLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DangerLevel {
    Safe,
    ReadOnly,
    Destructive,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolResult {
    pub success: bool,
    pub data: Value,
    pub error: Option<String>,
}

pub struct ToolRegistry {
    tools: Vec<AgentTool>,
    manager: Arc<ConnectionManager>,
}

impl ToolRegistry {
    pub fn new(manager: Arc<ConnectionManager>) -> Self {
        let tools = vec![
            AgentTool {
                name: "get_schema_summary".into(),
                description: "获取数据库所有表名、列数和行数估算".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {},
                    "required": []
                }),
                danger_level: DangerLevel::Safe,
            },
            AgentTool {
                name: "get_table_info".into(),
                description: "获取指定表的列信息、数据类型、索引和外键".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "table_name": { "type": "string", "description": "表名" }
                    },
                    "required": ["table_name"]
                }),
                danger_level: DangerLevel::Safe,
            },
            AgentTool {
                name: "execute_select".into(),
                description: "执行只读 SELECT 查询，自动添加 LIMIT 500".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "SELECT 查询语句" }
                    },
                    "required": ["sql"]
                }),
                danger_level: DangerLevel::ReadOnly,
            },
            AgentTool {
                name: "explain_query".into(),
                description: "分析 SQL 执行计划，用于查询优化".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "要分析的 SQL" }
                    },
                    "required": ["sql"]
                }),
                danger_level: DangerLevel::Safe,
            },
            AgentTool {
                name: "execute_sql".into(),
                description: "执行任意 SQL 语句（DDL/DML），创建索引、修改表结构等。执行前会征求用户确认。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "要执行的 SQL" },
                        "reason": { "type": "string", "description": "执行原因" }
                    },
                    "required": ["sql", "reason"]
                }),
                danger_level: DangerLevel::Destructive,
            },
        ];
        Self { tools, manager }
    }

    pub fn tool_definitions(&self) -> &[AgentTool] { &self.tools }

    pub async fn execute(&self, connection_id: &str, tool_name: &str, params: &Value) -> ToolResult {
        // 根据 tool_name 路由到具体 handler
        match tool_name {
            "get_schema_summary" => self.handle_get_schema(connection_id).await,
            "get_table_info" => self.handle_get_table_info(connection_id, params).await,
            "execute_select" => self.handle_execute_select(connection_id, params).await,
            "explain_query" => self.handle_explain(connection_id, params).await,
            "execute_sql" => self.handle_execute_sql(connection_id, params).await,
            _ => ToolResult {
                success: false,
                data: Value::Null,
                error: Some(format!("Unknown tool: {}", tool_name)),
            },
        }
    }
    // ... handler 方法见步骤 2
}
```

- [ ] **Step 2: 实现各工具 handler**

```rust
// 继续在 src-tauri/src/ai/tools.rs

impl ToolRegistry {
    async fn handle_get_schema(&self, connection_id: &str) -> ToolResult {
        let tables = self.manager.get_tables(connection_id).await;
        match tables {
            Ok(tables) => {
                let summary: Vec<Value> = tables.into_iter().map(|t| {
                    serde_json::json!({
                        "schema": t.schema_name,
                        "name": t.table_name,
                        "type": t.table_type,
                    })
                }).collect();
                ToolResult { success: true, data: Value::Array(summary), error: None }
            }
            Err(e) => ToolResult { success: false, data: Value::Null, error: Some(e.to_string()) },
        }
    }

    async fn handle_get_table_info(&self, connection_id: &str, params: &Value) -> ToolResult {
        let table = params["table_name"].as_str().unwrap_or("");
        let columns = self.manager.get_columns(connection_id, table, None).await;
        let indexes = self.manager.get_indexes(connection_id, table, None).await;
        let fks = self.manager.get_foreign_keys(connection_id, table, None).await;
        let count = self.manager.get_table_row_count(connection_id, table, None).await;

        match (columns, indexes, fks, count) {
            (Ok(cols), Ok(idxs), Ok(fks), Ok(cnt)) => ToolResult {
                success: true,
                data: serde_json::json!({
                    "columns": cols.into_iter().map(|c| serde_json::json!({
                        "name": c.name, "type": c.data_type,
                        "nullable": c.nullable, "is_pk": c.is_primary_key
                    })).collect::<Vec<_>>(),
                    "indexes": idxs,
                    "foreign_keys": fks,
                    "estimated_rows": cnt,
                }),
                error: None,
            },
            _ => ToolResult { success: false, data: Value::Null, error: Some("Failed to get table info".into()) },
        }
    }

    async fn handle_execute_select(&self, connection_id: &str, params: &Value) -> ToolResult {
        let sql = params["sql"].as_str().unwrap_or("");
        let limited_sql = if !sql.to_uppercase().contains("LIMIT") {
            format!("{} LIMIT 500", sql)
        } else {
            sql.to_string()
        };
        match self.manager.query(connection_id, &limited_sql).await {
            Ok(result) => ToolResult {
                success: true,
                data: serde_json::json!({
                    "columns": result.columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
                    "row_count": result.rows.len(),
                    "rows": result.rows.iter().take(20).collect::<Vec<_>>(),
                }),
                error: None,
            },
            Err(e) => ToolResult { success: false, data: Value::Null, error: Some(e.to_string()) },
        }
    }

    async fn handle_explain(&self, connection_id: &str, params: &Value) -> ToolResult {
        let sql = params["sql"].as_str().unwrap_or("");
        let explain_sql = format!("EXPLAIN (ANALYZE, FORMAT JSON) {}", sql);
        match self.manager.query(connection_id, &explain_sql).await {
            Ok(result) => ToolResult { success: true, data: serde_json::to_value(result.rows).unwrap_or_default(), error: None },
            Err(e) => ToolResult { success: false, data: Value::Null, error: Some(e.to_string()) },
        }
    }

    async fn handle_execute_sql(&self, connection_id: &str, params: &Value) -> ToolResult {
        let sql = params["sql"].as_str().unwrap_or("");
        match self.manager.execute(connection_id, sql).await {
            Ok(result) => ToolResult {
                success: true,
                data: serde_json::json!({ "rows_affected": result.rows_affected }),
                error: None,
            },
            Err(e) => ToolResult { success: false, data: Value::Null, error: Some(e.to_string()) },
        }
    }
}
```

- [ ] **Step 3: 创建安全门禁**

```rust
// src-tauri/src/ai/safety.rs

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub enum SafetyAction {
    Allow,                            // 直接放行
    Confirm { reason: String },       // 需要用户确认
    Deny { reason: String },          // 拒绝
}

pub struct SafetyGate {
    pub auto_approve_select: bool,
    pub auto_approve_readonly: bool,
    pub require_confirm_ddl: bool,
    pub require_confirm_dml: bool,
    pub require_confirm_drop: bool,
}

impl Default for SafetyGate {
    fn default() -> Self {
        Self {
            auto_approve_select: true,
            auto_approve_readonly: true,
            require_confirm_ddl: true,
            require_confirm_dml: true,
            require_confirm_drop: true,
        }
    }
}

impl SafetyGate {
    pub fn evaluate(&self, sql: &str) -> SafetyAction {
        let upper = sql.trim().to_uppercase();

        // 检查危险关键词
        if upper.contains("DROP TABLE") || upper.contains("DROP DATABASE") || upper.contains("TRUNCATE") {
            if self.require_confirm_drop {
                return SafetyAction::Confirm {
                    reason: "此操作将删除数据/表，不可恢复".into()
                };
            }
        }

        if upper.contains("ALTER") && self.require_confirm_ddl {
            return SafetyAction::Confirm {
                reason: "此操作将修改表结构".into()
            };
        }

        if upper.starts_with("DELETE") {
            if !upper.contains("WHERE") {
                return SafetyAction::Deny {
                    reason: "DELETE 没有 WHERE 条件，将删除全表数据".into()
                };
            }
            if self.require_confirm_dml {
                return SafetyAction::Confirm {
                    reason: "此操作将删除数据".into()
                };
            }
        }

        if upper.starts_with("INSERT") || upper.starts_with("UPDATE") {
            if self.require_confirm_dml {
                return SafetyAction::Confirm {
                    reason: "此操作将修改数据".into()
                };
            }
        }

        SafetyAction::Allow
    }
}
```

- [ ] **Step 4: 创建 ReAct Agent Loop**

```rust
// src-tauri/src/ai/agent.rs

use tokio::sync::mpsc;
use super::tools::{ToolRegistry, ToolResult};
use super::safety::{SafetyGate, SafetyAction};
use super::context::ContextBuilder;

#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    Thinking(String),
    ToolCall { name: String, params: Value },
    ToolResult { name: String, result: ToolResult },
    NeedsConfirmation { sql: String, reason: String },
    ToolDenied(String),
    FinalAnswer(String),
    Error(String),
}

pub struct AgentLoop {
    connection_id: String,
    tool_registry: Arc<ToolRegistry>,
    safety_gate: SafetyGate,
    context_builder: ContextBuilder,
    max_iterations: u32,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
}

impl AgentLoop {
    pub async fn run(
        &self,
        messages: &[Message],
        user_input: &str,
    ) -> Result<String, String> {
        // 1. 构建系统 prompt（注入 schema 上下文）
        let system_prompt = self.context_builder.build(&self.connection_id).await
            .map_err(|e| e.to_string())?;

        // 2. 构建带工具的 messages
        let mut conversation = vec![
            Message { role: "system".into(), content: system_prompt },
        ];
        conversation.extend(messages.to_vec());
        conversation.push(Message { role: "user".into(), content: user_input.into() });

        // 3. ReAct 循环
        for _iteration in 0..self.max_iterations {
            let response = self.call_llm_with_tools(&conversation).await?;

            match response {
                LLMResponse::ToolCall { tool_name, params } => {
                    self.event_tx.send(AgentEvent::ToolCall {
                        name: tool_name.clone(), params: params.clone(),
                    }).ok();

                    // 对 execute_sql 做安全检查
                    if tool_name == "execute_sql" {
                        let sql = params["sql"].as_str().unwrap_or("");
                        match self.safety_gate.evaluate(sql) {
                            SafetyAction::Allow => { /* 继续执行 */ }
                            SafetyAction::Confirm { reason } => {
                                self.event_tx.send(AgentEvent::NeedsConfirmation {
                                    sql: sql.into(), reason,
                                }).ok();
                                return Ok("__AWAITING_CONFIRMATION__".into());
                            }
                            SafetyAction::Deny { reason } => {
                                self.event_tx.send(AgentEvent::ToolDenied(tool_name)).ok();
                                conversation.push(Message {
                                    role: "tool".into(),
                                    content: format!("Denied: {}", reason),
                                });
                                continue;
                            }
                        }
                    }

                    let result = self.tool_registry.execute(&self.connection_id, &tool_name, &params).await;
                    self.event_tx.send(AgentEvent::ToolResult {
                        name: tool_name.clone(), result: result.clone(),
                    }).ok();

                    conversation.push(Message {
                        role: "tool".into(),
                        content: serde_json::to_string(&result).unwrap_or_default(),
                    });
                }
                LLMResponse::FinalAnswer { content } => {
                    self.event_tx.send(AgentEvent::FinalAnswer(content.clone())).ok();
                    return Ok(content);
                }
            }
        }

        Ok("已达到最大推理步数，请简化你的问题或手动操作。".into())
    }

    async fn call_llm_with_tools(&self, messages: &[Message]) -> Result<LLMResponse, String> {
        // 调用 LLM API，使用 function calling
        // 解析返回的 tool_calls 或 content
        // ... 使用现有 ai/client.rs 中的 AIClient
        todo!("复用现有 AIClient 的 LLM 调用，增加 function calling 参数")
    }
}

enum LLMResponse {
    ToolCall { tool_name: String, params: Value },
    FinalAnswer { content: String },
}
```

- [ ] **Step 5: 创建上下文构建器**

```rust
// src-tauri/src/ai/context.rs

pub struct ContextBuilder {
    manager: Arc<ConnectionManager>,
}

impl ContextBuilder {
    pub async fn build(&self, connection_id: &str) -> Result<String, String> {
        let tables = self.manager.get_tables(connection_id).await
            .map_err(|e| e.to_string())?;
        let db_type = self.manager.get_db_type(connection_id).await;

        let schema_text: String = tables.iter()
            .map(|t| format!("- {}.{} ({})",
                t.schema_name.as_deref().unwrap_or(""),
                t.table_name,
                t.table_type))
            .collect::<Vec<_>>()
            .join("\n");

        Ok(format!(r#"你是 CrabHub 数据库助理 DBA。

## 当前数据库
- 类型: {db_type}
- 表数量: {table_count}

## Schema
{schema_text}

## 可用工具
- get_schema_summary: 获取 Schema 摘要
- get_table_info: 获取表详情（列/索引/外键/行数）
- execute_select: 执行只读查询（自动 LIMIT 500）
- explain_query: 分析执行计划
- execute_sql: 执行修改操作（需用户确认）

## 规则
1. 先了解结构再操作（用 get_table_info）
2. 优化建议要前后对比（EXPLAIN）
3. 修改操作必须说明原因并等待确认
4. 报错时分析原因并自动修正重试一次
5. 用中文思考，SQL 保持英文
"#, db_type = db_type, table_count = tables.len(), schema_text = schema_text))
    }
}
```

- [ ] **Step 6: 添加 Tauri 命令**

```rust
// 在 src-tauri/src/ai/commands.rs 中添加：

#[tauri::command]
pub async fn agent_run(
    state: State<'_, Arc<AgentState>>,
    provider: String, endpoint: String, api_key: String, model: String,
    connection_id: String,
    messages: Vec<Message>,
    user_input: String,
    window: tauri::Window,
) -> Result<String, String> {
    let agent = AgentLoop::new(connection_id, &provider, &endpoint, &api_key, &model);

    // 通过 channel 将事件推送到前端
    let (tx, mut rx) = mpsc::unbounded_channel();
    let w = window.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            w.emit("agent-event", &event).ok();
        }
    });

    let result = agent.run(&messages, &user_input, tx).await
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn agent_confirm(
    state: State<'_, Arc<AgentState>>,
    approved: bool,
) -> Result<(), String> {
    // 通知正在等待确认的 agent 循环
    AgentState::confirm(approved).await;
    Ok(())
}
```

- [ ] **Step 7: 注册模块和命令**

```rust
// src-tauri/src/ai/mod.rs 中添加：
pub mod agent;
pub mod tools;
pub mod safety;
pub mod context;

// src-tauri/src/lib.rs 中注册命令：
.invoke_handler(tauri::generate_handler![
    // ... 现有命令
    ai::commands::agent_run,
    ai::commands::agent_confirm,
])
```

- [ ] **Step 8: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/ai/agent.rs src-tauri/src/ai/tools.rs \
  src-tauri/src/ai/safety.rs src-tauri/src/ai/context.rs \
  src-tauri/src/ai/commands.rs src-tauri/src/ai/mod.rs \
  src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: add AI Agent runtime — ReAct loop, tool registry, safety gate, context builder"
```

---

### Task 13: AI Agent 前端聊天面板

**Files:**
- Create: `src/components/AgentChatPanel.tsx` — 替代/增强现有 AIPanel.tsx
- Create: `src/components/AgentToolCard.tsx` — 工具调用结果展示卡片
- Create: `src/components/AgentConfirmBar.tsx` — 危险操作确认条
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: 添加 i18n 键**

```typescript
// src/lib/i18n.ts 添加：
agentThinking: { zh: "思考中...", en: "Thinking..." },
agentToolCall: { zh: "调用工具", en: "Tool Call" },
agentConfirm: { zh: "需要确认", en: "Needs Confirmation" },
agentExecute: { zh: "执行", en: "Execute" },
agentCopySQL: { zh: "复制 SQL", en: "Copy SQL" },
agentIgnore: { zh: "忽略", en: "Ignore" },
agentRunning: { zh: "AI 正在操作...", en: "AI is working..." },
agentContextHint: { zh: "Schema 已注入 · 可执行操作", en: "Schema injected · Operational" },
```

- [ ] **Step 2: 创建 AgentToolCard 组件**

```tsx
// src/components/AgentToolCard.tsx
import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, Check, X } from "lucide-react";

interface AgentToolCardProps {
  toolName: string;
  params?: Record<string, unknown>;
  result?: { success: boolean; data: unknown; error?: string };
  status: "running" | "success" | "error" | "denied" | "awaiting_confirm";
}

export function AgentToolCard({ toolName, params, result, status }: AgentToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: <Loader2 size={14} className="animate-spin text-blue-500" />,
    success: <Check size={14} className="text-green-500" />,
    error: <X size={14} className="text-red-500" />,
    denied: <X size={14} className="text-orange-500" />,
    awaiting_confirm: <Clock size={14} className="text-yellow-500" />,
  }[status];

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-xs
          bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} />
        <span className="font-mono font-medium">{toolName}</span>
        <span className="ml-auto">{statusIcon}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 text-xs space-y-1 font-mono">
          {result?.error && (
            <div className="text-red-500">Error: {result.error}</div>
          )}
          {result?.success && result.data && (
            <pre className="text-muted-foreground whitespace-pre-wrap max-h-32 overflow-auto">
              {JSON.stringify(result.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 创建 AgentConfirmBar 组件**

```tsx
// src/components/AgentConfirmBar.tsx
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

interface AgentConfirmBarProps {
  sql: string;
  reason: string;
  onApprove: () => void;
  onReject: () => void;
}

export function AgentConfirmBar({ sql, reason, onApprove, onReject }: AgentConfirmBarProps) {
  return (
    <div className="border border-yellow-500/30 rounded-lg p-3 bg-yellow-50 dark:bg-yellow-950/20">
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={16} className="text-yellow-600" />
        <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
          {t("agentConfirm")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-2">{reason}</p>
      <pre className="text-xs font-mono bg-muted p-2 rounded mb-2 overflow-x-auto">
        {sql}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={onApprove}>{t("agentExecute")}</Button>
        <Button size="sm" variant="outline" onClick={onReject}>{t("agentIgnore")}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 创建 AgentChatPanel 主组件**

```tsx
// src/components/AgentChatPanel.tsx
// 核心结构参考设计文档 10.8 节的 UI 图示
// 集成 AgentToolCard、AgentConfirmBar
// 监听 agent-event 事件流，展示思考/工具调用/结果
// [完整实现代码 ~500 行，在此省略，执行时按设计稿编写]
```

- [ ] **Step 5: 运行验证**

```bash
npm run tauri dev
```

连接数据库 → 打开 AI 面板 → 输入"帮我分析 orders 表结构" → 观察 Agent 自动调用 get_schema_summary → 返回结果。

- [ ] **Step 6: Commit**

```bash
git add src/components/AgentChatPanel.tsx src/components/AgentToolCard.tsx \
  src/components/AgentConfirmBar.tsx src/components/AIPanel.tsx src/lib/i18n.ts
git commit -m "feat: add AI Agent chat UI with tool call cards and confirmation bar"
```

---

### Task 14: 集成测试与回归验证（全量）

**Files:** 无新建文件。

- [ ] **Step 1: Rust 编译检查**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 0 errors。

- [ ] **Step 2: Rust 测试**

```bash
cd src-tauri && cargo test 2>&1
```
Expected: 现有测试全部通过。

- [ ] **Step 3: 前端类型检查**

```bash
npx tsc --noEmit
```
Expected: 类型检查通过。

- [ ] **Step 4: 前端单元测试**

```bash
npx vitest run
```
Expected: 全部通过。

- [ ] **Step 5: 全量检查**

```bash
npm run test:all
```
Expected: 全部通过。

- [ ] **Step 6: Mock 模式下功能验证**

```bash
npm run dev:mock
```

验证清单：
- [ ] shadcn Button/Dialog/DropdownMenu 正常渲染
- [ ] 深色/浅色主题切换正常
- [ ] 毛玻璃侧边栏效果正确
- [ ] 右键菜单 → Markdown 复制正常
- [ ] 右键菜单 → 生成图表正常
- [ ] 自定义标题栏窗口控制正常

- [ ] **Step 7: Tauri 实机验证**

```bash
npm run tauri dev
```

验证清单：
- [ ] 连接数据库正常（PG/MySQL/SQLite/GaussDB）
- [ ] 查询、分页、取消正常
- [ ] AI Agent 面板启动，工具调用正常
- [ ] AI 危险操作确认流程正常

- [ ] **Step 8: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: test and integration fixes from architecture refactor"
```

---

## 实施顺序与依赖

```
Task 1  (DatabaseType 扩展)      ← 最先，后续所有 Rust task 依赖
    ↓
Task 2  (DialectConfig 系统)     ← task 3/4/5 依赖
    ↓
Task 3  (PgCompatibleConnection) ← task 4 依赖
    ↓
Task 4  (GaussDB 重构)           ← 验证继承体系可用
    ↓
Task 5  (ODBC 桥接)              ← 独立，可与 task 3/4 并行
    ↓
Task 6  (ClickHouse 连接池)      ← 独立修复，可随时做
    ↓
Task 7  (Markdown 复制)          ← 纯前端，可随时做
Task 8  (Quick Chart)            ← 纯前端，依赖 recharts
    ↓
Task 9  (测试验证 v1)            ← 阶段一完成验证
    ↓
Task 10 (shadcn/ui 初始化)       ← 前端基础设施变更
    ↓
Task 11 (shadcn 组件替换)        ← 依赖 task 10
    ↓
Task 12 (AI Agent Runtime)       ← Rust 后端，可与 task 10/11 并行
    ↓
Task 13 (AI Agent 前端)          ← 依赖 task 10/11/12
    ↓
Task 14 (集成测试 v2)            ← 最后
```

**并行建议：**
- Task 5、6 可与 Task 3、4 并行（不同文件）
- Task 7、8 纯前端，可与所有 Rust task 并行
- Task 10、11（UI）与 Task 12（AI Runtime）可并行
- Task 13 前端 Agent UI 需等 Task 10、12 完成后开始

---

*计划版本: 2.0*
*日期: 2026-05-21*
