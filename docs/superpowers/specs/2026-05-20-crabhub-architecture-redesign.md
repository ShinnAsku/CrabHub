# CrabHub 架构升级设计方案

> 目标：对标 DBeaver / Navicat，在性能、简洁性和国产数据库支持上做到更好

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      CrabHub                             │
├────────────────────┬────────────────────────────────────┤
│  React 19          │  Tauri v2 (Rust)                   │
│  TypeScript 5.7    │                                    │
│  shadcn/ui +       │  ┌──────────────────────────────┐  │
│  Tailwind CSS 4    │  │   ConnectionManager           │  │
│  Zustand 5         │  │   ┌────────────────────────┐  │  │
│  Monaco Editor     │  │   │ 原生驱动层             │  │  │
│  @tanstack/virtual │  │   │ ┌────┬────┬────┐       │  │  │
│  ReactFlow         │  │   │ │ PG │MySQL│SQLi│       │  │  │
│  recharts          │  │   │ │    │    │ te │       │  │  │
│                    │  │   ├┼────┼────┼────┤       │  │  │
│  ┌──────────────┐  │  │   │ │PgCompatible  │       │  │  │
│  │ shadcn/ui    │  │  │   │ │ ├─GaussDB   │       │  │  │
│  │  ┌─────────┐ │  │  │   │ │ ├─Kingbase  │       │  │  │
│  │  │ Button  │ │  │  │   │ │ └─Vastbase  │       │  │  │
│  │  │ Dialog  │ │  │  │   │ │MyCompatible  │       │  │  │
│  │  │ Table   │ │  │  │   │ │ ├─OceanBase │       │  │  │
│  │  │ Tabs    │ │  │  │   │ │ ├─TiDB      │       │  │  │
│  │  │ Menu    │ │  │  │   │ │ └─TDSQL     │       │  │  │
│  │  │ Sheet   │ │  │  │   │ │OdbcBridge   │       │  │  │
│  │  │ Select  │ │  │  │   │ │ ├─Oracle   │       │  │  │
│  │  │ Toast   │ │  │  │   │ │ ├─MSSQL    │       │  │  │
│  │  │ ...     │ │  │  │   │ │ ├─达梦     │       │  │  │
│  │  └─────────┘ │  │  │   │ │ └─...      │       │  │  │
│  └──────────────┘  │  │   │ │ClickHouse   │       │  │  │
│                    │  │   │ │Plugins      │       │  │  │
│  ┌──────────────┐  │  │   │ └────────────┘       │  │  │
│  │ AI Agent     │  │  │   └────────────────────────┘  │  │
│  │  ┌─────────┐ │  │  │   ┌────────────────────────┐  │  │
│  │  │ReAct    │ │  │  │   │   AI Agent Runtime      │  │  │
│  │  │ Loop    │ │  │  │   │   ┌──────────────────┐  │  │  │
│  │  │ Tool    │ │  │  │   │   │ Tool Registry    │  │  │  │
│  │  │ Registry│ │  │  │   │   │ Safety Gate      │  │  │  │
│  │  │ Safety  │ │  │  │   │   │ Context Builder  │  │  │  │
│  │  │ Gate    │ │  │  │   │   └──────────────────┘  │  │  │
│  │  └─────────┘ │  │  │   └────────────────────────┘  │  │
│  └──────────────┘  │                                    │
└────────────────────┴────────────────────────────────────┘
```

## 2. 驱动层 —— 从平铺改为继承体系

### 2.1 当前问题

每个驱动完全独立实现 `DatabaseConnection` trait，GaussDB 997 行代码跟 PostgreSQL 驱动零共享。新增 Kingbase 要再写近 1000 行。

### 2.2 目标结构

```
DatabaseConnection (trait)
├── PostgresConnection              # PG 标准驱动，完整实现 trait
├── MySQLConnection                 # MySQL 标准驱动，完整实现 trait
├── PgCompatibleConnection          # PG 协议兼容驱动（新增，继承层）
│   ├── GaussDBConnection           #  只覆盖差异部分
│   ├── KingbaseConnection          #  同上
│   └── VastbaseConnection          #  同上
├── MySQLCompatibleConnection       # MySQL 协议兼容驱动（新增，继承层）
│   ├── OceanBaseConnection
│   ├── TiDBConnection
│   └── TDSQLConnection
├── OdbcConnection                  # ODBC 桥接驱动（新增）
├── ClickHouseConnection            # HTTP / TCP 原生
├── SQLiteConnection                # 文件型
└── PluginDriver                    # Tabularis 插件桥
```

### 2.3 实现模式：组合 + 委托

```rust
// PgCompatibleConnection 持有一个 PostgresConnection 实例
// 所有 trait 方法默认委托给 inner，子驱动只覆盖差异
pub struct PgCompatibleConnection {
    inner: PostgresConnection,        // PG 标准驱动
    dialect: DialectConfig,           // 方言配置
}

#[async_trait]
impl DatabaseConnection for PgCompatibleConnection {
    // 默认委托
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        self.inner.query_sql(sql).await
    }
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        self.inner.execute_sql(sql).await
    }

    // 元数据查询使用方言配置中的 SQL 模板
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = &self.dialect.metadata_queries.list_tables;
        self.inner.query_sql(sql).await.map(|r| /* parse */)
    }

    fn db_type(&self) -> DatabaseType {
        self.dialect.db_type.clone()
    }
}

// GaussDB 只需覆盖真正不同的地方
pub struct GaussDBConnection {
    inner: PgCompatibleConnection,
}
impl DatabaseConnection for GaussDBConnection {
    fn db_type(&self) -> DatabaseType { DatabaseType::GaussDB }
    // 大部分方法委托给 PgCompatible，只覆盖 GaussDB 特有行为
}
```

### 2.4 继承层级与调用链

```
新增一个 PG 兼容的国产数据库只需要：
1. 声明 DatabaseType 变体
2. 填写 DialectConfig（端口、标识符引用符、元数据 SQL 模板）
3. 注册 capabilities

不需要写一行 SQL 执行逻辑。
```

## 3. ODBC 桥接器 —— 解锁 30+ 数据库

### 3.1 设计目标

写一次 ODBC 适配器，支持所有提供 ODBC 驱动的数据库：

Oracle、SQL Server、DB2、达梦 DM、GBase 8a/8t、神通 OSCAR、Sybase、Informix、Teradata、Hive、Impala、Vertica、Snowflake、BigQuery 等。

### 3.2 实现方案

```rust
use odbc_api;  // Rust ODBC 库，跨平台

pub struct OdbcConnection {
    dsn: String,                   // 系统 DSN 名称
    conn_string: String,           // 连接字符串
    capabilities: DriverCapabilities,
    dialect: DialectConfig,
}

impl DatabaseConnection for OdbcConnection {
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        // 1. 建立 ODBC 连接
        let env = odbc_api::Environment::new()?;
        let conn = env.connect_with_connection_string(&self.conn_string)?;

        // 2. 执行 SQL，流式读取结果
        let cursor = conn.execute(sql, ())?;
        let columns = Self::extract_columns(&cursor);
        let rows = Self::fetch_rows_streaming(cursor, 500); // 分批读取

        // 3. 转换为统一 QueryResult
        Ok(QueryResult { columns, rows })
    }
}
```

### 3.3 ODBC 驱动注册

用户界面上选择"ODBC 连接"，填写系统 DSN 或连接字符串。应用自动探测数据库类型和 capabilities。

```
ODBC 连接流程：
用户填连接信息 → 尝试连接 → 探测 metadata（数据库名、版本）
→ 匹配已知方言配置表 → 确定 capabilities
→ 如果匹配失败，使用默认 ODBC 能力集（保守模式）
```

### 3.4 方言配置与自动探测

维护一个 `ODBC_DIALECT_MAP`：

```rust
const ODBC_DIALECT_MAP: &[(/* driver keyword */ &str, DialectConfig)] = &[
    ("Oracle",  DialectConfig { identifier_quote: QuoteStyle::Double, .. }),
    ("SQL Server", DialectConfig { identifier_quote: QuoteStyle::Bracket, .. }),
    ("DM",      DialectConfig { identifier_quote: QuoteStyle::Double, /* 达梦 */ .. }),
    ("GBase",   DialectConfig { identifier_quote: QuoteStyle::Double, .. }),
    // ...
];
```

连接后根据驱动关键词自动匹配方言配置，用户无感。

## 4. 方言配置表 —— 元数据查询统一管理

### 4.1 当前问题

`get_tables()`、`get_columns()` 等方法的 SQL 硬编码在每个驱动的 `.rs` 文件中。同一套 PG 兼容库的 SQL 完全一样，却要复制粘贴。

### 4.2 目标结构

```rust
pub struct DialectConfig {
    // 基础信息
    pub db_type: DatabaseType,
    pub default_port: u16,
    pub identifier_quote: QuoteStyle,  // Double | Backtick | Bracket

    // 分页语法
    pub limit_syntax: LimitSyntax,     // LimitOffset | FetchNext | TopN

    // 元数据 SQL（每个数据库系统表不同）
    pub metadata_queries: MetadataQueries,

    // 函数映射
    pub function_map: HashMap<String, String>,
}

pub struct MetadataQueries {
    pub list_schemas: &'static str,
    pub list_tables: &'static str,
    pub list_views: &'static str,
    pub list_columns: &'static str,
    pub list_indexes: &'static str,
    pub list_foreign_keys: &'static str,
    pub list_procedures: &'static str,
    pub list_triggers: &'static str,
    pub table_row_count: &'static str,
    pub explain_query: &'static str,
}
```

### 4.3 PG 兼容方言配置（示例）

```rust
// 所有 PG 兼容库共享同一套配置，只需覆盖不同的字段
pub fn pg_compatible_dialect(db_type: DatabaseType) -> DialectConfig {
    DialectConfig {
        db_type,
        default_port: 5432,
        identifier_quote: QuoteStyle::Double,
        limit_syntax: LimitSyntax::LimitOffset,
        metadata_queries: MetadataQueries {
            list_schemas: "SELECT schema_name FROM information_schema.schemata
                WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
                ORDER BY schema_name",
            list_tables: "SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name",
            list_columns: "SELECT column_name, data_type, is_nullable,
                column_default, ordinal_position
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position",
            list_indexes: "SELECT indexname, indexdef FROM pg_indexes
                WHERE schemaname = $1 AND tablename = $2",
            list_foreign_keys: "SELECT tc.constraint_name,
                kcu.column_name,
                ccu.table_schema AS foreign_table_schema,
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                JOIN information_schema.constraint_column_usage ccu
                    ON tc.constraint_name = ccu.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = $1 AND tc.table_name = $2",
            // ... 其余
        },
        function_map: HashMap::new(),
    }
}

// Kingbase 可能有些函数名不同
pub fn kingbase_dialect() -> DialectConfig {
    let mut d = pg_compatible_dialect(DatabaseType::Kingbase);
    d.default_port = 54321;  // Kingbase 默认端口不同
    d.function_map.insert("NOW()".into(), "SYSDATE".into());
    d
}
```

## 5. 查询引擎 —— 大数据量性能策略（保留 + 增强）

### 5.1 三层防护（保持现有方案，增加细节）

```
第 1 层：SQL 自动改写
  用户: SELECT * FROM orders
  引擎: SELECT * FROM orders LIMIT 501 OFFSET 0
  → 多查 1 行判断 has_more，不查全量

第 2 层：Token 游标分页（替代 OFFSET 对大表的性能问题）
  第一页: SELECT * FROM orders ORDER BY id LIMIT 500
  返回: { rows, next_token: "id>500" }
  第二页: SELECT * FROM orders WHERE id>500 ORDER BY id LIMIT 500
  → 每页速度恒定，不受页数影响

第 3 层：查询取消
  Rust 侧: CancellationToken，cancel() 被调用后驱动立即中断
  前端侧: AbortController，翻页时取消上一页的网络请求
  → 用户快速翻页只加载最终页
```

### 5.2 Token 分页实现细节

```rust
// 在 trait_def.rs 中添加
pub struct PagedQueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub has_more: bool,
    pub next_token: Option<String>,  // 新增：游标 token
}

// 在 Postgres 驱动中实现 token 分页
async fn query_sql_paged_token(
    &self,
    sql: &str,
    limit: u64,
    after_token: Option<&str>,
) -> Result<PagedQueryResult, DbError> {
    let sql = if let Some(token) = after_token {
        // WHERE id > last_seen_id ORDER BY id LIMIT limit+1
        inject_where_clause(sql, token, limit + 1)
    } else {
        inject_limit(sql, limit + 1)
    };
    // ... 执行并返回结果 + next_token
}
```

### 5.3 ClickHouse 连接池

```rust
// 当前：每次查询 new reqwest::post() → TCP 握手开销
// 改为：
pub struct ClickHouseConnection {
    client: reqwest::Client,  // 自带连接池，复用 TCP 连接
    base_url: String,
    // ...
}
// 所有查询通过 self.client.post() 发送，自动复用连接
```

## 6. 前端改进

### 6.1 结果集右键图表（新功能）

```
触发：在结果表格中选中列 → 右键 → "生成图表"
行为：
  1. 自动推断图表类型：
     两列数字      → 散点图
     字符串 + 数字  → 柱状图
     日期 + 数字    → 折线图
     字符串 + 计数  → 饼图
  2. 弹出轻量 ChartPanel，使用已有的 recharts 组件
  3. 用户可切换图表类型、调整列映射
  4. 支持复制图表为图片
```

实现复用已有的 `SqlCell.tsx` 中的图表组件，抽取为独立组件后在结果面板中调用。

### 6.2 复制为 Markdown 表格（新功能）

```
触发：结果表格中选中行 → 右键 → "复制为 Markdown"
输出：
  | id | name  | email          |
  |----|-------|----------------|
  | 1  | Alisa | a@example.com  |
  | 2  | Bob   | b@example.com  |
```

### 6.3 Schema 感知补全（保持现有实现，增强）

CrabHub 已有基于连接上下文的 schema→table→column 补全链。增强点：

- 新增 JOIN 建议：输入 `JOIN u` 时，根据外键关系推荐关联表
- 新增聚合建议：`SELECT name, COUNT(|` 时自动补全可聚合的列

### 6.4 渲染策略分级

```
数据量 < 1000 行:  DOM 渲染，全部交互可用（编辑、排序、筛选）
1000~5 万行:       虚拟滚动 DOM，保留编辑和排序
5 万~10 万行:      虚拟滚动 + 只读
> 10 万行:         强制分页限制 + 提醒用户加 WHERE 条件
```

## 7. 数据库注册表 —— 统一管理方言与能力

```rust
// db/registry.rs（新增文件）
// 所有支持的数据库在此注册，自动生成前端的数据库选择列表

pub struct DatabaseRegistry {
    entries: Vec<DatabaseEntry>,
}

pub struct DatabaseEntry {
    pub db_type: DatabaseType,
    pub display_name: &'static str,    // "GaussDB"
    pub category: &'static str,         // "国产数据库" | "开源数据库" | "商业数据库"
    pub driver_kind: DriverKind,        // 用什么驱动
    pub build_fn: fn() -> Box<dyn DatabaseConnection>,
}

pub enum DriverKind {
    NativePostgres,           // 原生 PG 驱动
    NativeMySQL,              // 原生 MySQL 驱动
    NativeSQLite,             // 原生 SQLite
    PgCompatible(DialectConfig),   // PG 协议兼容
    MySQLCompatible(DialectConfig), // MySQL 协议兼容
    Odbc(DialectConfig),      // ODBC 桥接
    ClickHouse,
    Plugin,
}
```

## 8. 新增一个数据库的流程

以「人大金仓 Kingbase」为例：

```
1. 在 types.rs 中添加 DatabaseType::Kingbase 变体
2. 在 registry.rs 中注册：
   DatabaseEntry {
       db_type: DatabaseType::Kingbase,
       display_name: "Kingbase (人大金仓)",
       category: "国产数据库",
       driver_kind: DriverKind::PgCompatible(kingbase_dialect()),
       build_fn: || Box::new(GaussDBConnection::new(kingbase_dialect())),
   }
3. 如果 Kingbase 有特殊行为，在 gaussdb.rs 中新增 3-5 行覆盖

预计耗时：15-30 分钟
```

以「达梦 DM」为例：

```
1. DatabaseType::DaMeng
2. driver_kind: DriverKind::Odbc(dameng_odbc_config())
3. 无需写 Rust 驱动代码

预计耗时：10 分钟
```

---

## 9. Mac 风格 UI 设计（shadcn/ui）

### 9.1 选型理由

选择 **shadcn/ui** 而非 Ant Design / Element Plus：

| 维度 | shadcn/ui | Ant Design | Element Plus |
|------|-----------|------------|--------------|
| 与 Tailwind 4 共存 | ✅ 天生一对 | ⚠️ CSS-in-JS 冲突 | ❌ 需完全替换 |
| 组件代码归属 | 复制到你的仓库，随便改 | npm 依赖，覆盖样式困难 | npm 依赖 |
| Mac 风格可控性 | ⭐⭐⭐⭐⭐ 完全自定义 | ⭐⭐ 需大量覆盖 | ⭐⭐ 企业风格固化 |
| 按需引入 | 只用 14 个组件 | 全量或 treeshaking | 全量或 treeshaking |
| 包体积 | 无额外依赖 | ~150KB | ~200KB |
| React 19 兼容 | ✅ | ✅ | ⚠️ 社区版滞后 |

### 9.2 设计语言：Apple HIG 风格

```
色彩系统 (浅色):
  background:        #f5f5f7 (Apple 灰)
  card:              #ffffff + backdrop-blur
  sidebar:           rgba(255,255,255,0.72) + blur(20px)
  foreground:        #1d1d1f
  muted-foreground:  #86868b
  primary:           #0071e3 (Apple Blue)
  border:            rgba(0,0,0,0.06)

色彩系统 (深色):
  background:        #1c1c1e
  card:              #2c2c2e + backdrop-blur
  sidebar:           rgba(44,44,46,0.8) + blur(20px)
  foreground:        #f5f5f7
  primary:           #339af0

圆角系统:
  sm:   0.375rem (6px)   — Button, Input, Badge
  md:   0.5rem  (8px)   — Card, DropdownMenu
  lg:   0.75rem (12px)  — Dialog, Sheet
  xl:   1rem    (16px)  — 大面板

阴影系统 (多层柔和阴影):
  sm:  0 1px 2px rgba(0,0,0,0.04)
  md:  0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)
  lg:  0 4px 6px rgba(0,0,0,0.04), 0 12px 24px rgba(0,0,0,0.06)

字体:
  界面: system-ui, -apple-system (SF Pro 在 macOS 上)
  代码: 'JetBrains Mono', 'Cascadia Code', monospace
  数据: 等宽数字 tabular-nums
```

### 9.3 组件映射：shadcn/ui 替换 CrabHub 现有组件

| shadcn/ui 组件 | 替换 CrabHub 现有 | 效果 |
|----------------|-------------------|------|
| `Button` | 手写 `<button>` | 统一 variant（default/ghost/outline/destructive）、size（sm/default/lg）、loading 态 |
| `Input` | 手写 `<input>` | 统一 focus ring、错误态、前后缀图标 |
| `Dialog` | `ConnectionDialog`, `SchemaDiffDialog` | 毛玻璃 backdrop、动画出入、ESC 关闭 |
| `DropdownMenu` | 工具栏菜单、表头菜单 | 动画弹出、键盘导航、分隔线 |
| `ContextMenu` | 表格右键菜单、侧边栏右键 | 原生右键体验、子菜单支持 |
| `Tabs` | `TabBar` | 底部指示器动画、关闭按钮 |
| `Tooltip` | 各处 hover 提示 | 延迟出现、箭头、多方向 |
| `Sheet` | `AIPanel`, `SnippetPanel` | 侧边滑出、拖拽调整宽度 |
| `Select` | 数据库类型选择、排序字段选择 | 搜索过滤、键盘导航 |
| `Table` | 结果表格表头 | 排序图标、列宽拖拽手柄 |
| `ScrollArea` | 侧边栏、结果区 | 原生滚动条美化、hover 显示 |
| `Separator` | 工具栏分隔线 | 统一间距 |
| `Badge` | 数据库类型标签、状态标签 | 彩色标签、dot 变体 |
| `Skeleton` | 加载占位 | 骨架屏动画 |
| `Toast` | 操作提示（用 Sonner） | 右上角堆叠、自动消失、操作按钮 |

### 9.4 shadcn/ui 初始化与主题配置

```bash
# 1. 初始化 shadcn/ui（在已有 Tailwind 4 项目上叠加）
npx shadcn@latest init

# 配置选项：
#  Style: New York
#  Base color: Neutral
#  CSS variables: Yes (用于深色/浅色切换)

# 2. 逐个添加需要的组件
npx shadcn@latest add button
npx shadcn@latest add input
npx shadcn@latest add dialog
npx shadcn@latest add dropdown-menu
npx shadcn@latest add context-menu
npx shadcn@latest add tabs
npx shadcn@latest add tooltip
npx shadcn@latest add sheet
npx shadcn@latest add select
npx shadcn@latest add table
npx shadcn@latest add scroll-area
npx shadcn@latest add separator
npx shadcn@latest add badge
npx shadcn@latest add skeleton

# 3. 额外安装 sonner (Toast 替代)
npm install sonner
```

### 9.5 CSS 变量覆盖为 Mac 风格

```css
/* src/styles/index.css 或 globals.css */

@layer base {
  :root {
    /* Apple 浅色主题 */
    --background: 240 5% 96%;          /* #f5f5f7 */
    --foreground: 240 2% 10%;           /* #1d1d1f */
    --card: 0 0% 100%;
    --card-foreground: 240 2% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 2% 10%;
    --primary: 211 100% 45%;            /* #0071e3 Apple Blue */
    --primary-foreground: 0 0% 100%;
    --secondary: 240 5% 92%;
    --secondary-foreground: 240 2% 10%;
    --muted: 240 5% 92%;
    --muted-foreground: 240 4% 54%;     /* #86868b */
    --accent: 240 5% 92%;
    --accent-foreground: 240 2% 10%;
    --destructive: 0 84% 52%;
    --border: 240 4% 90%;
    --input: 240 4% 90%;
    --ring: 211 100% 45%;
    --radius: 0.625rem;                 /* 10px 全局圆角 */

    /* 侧边栏毛玻璃 */
    --sidebar-background: 0 0% 100% / 0.72;
    --sidebar-blur: 20px;
  }

  .dark {
    --background: 240 3% 11%;           /* #1c1c1e */
    --foreground: 240 5% 96%;
    --card: 240 3% 16%;                 /* #2c2c2e */
    --card-foreground: 240 5% 96%;
    --popover: 240 3% 16%;
    --popover-foreground: 240 5% 96%;
    --primary: 210 79% 56%;             /* #339af0 */
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

    --sidebar-background: 240 3% 16% / 0.8;
  }
}
```

### 9.6 自定义标题栏（无边框窗口）

在 Tauri 配置中禁用系统标题栏，用 React 实现 macOS 风格标题栏：

```json
// src-tauri/tauri.conf.json
{
  "app": {
    "windows": [
      {
        "decorations": false,       // 去掉系统标题栏
        "transparent": true,        // 窗口透明（毛玻璃效果）
        "titleBarStyle": "Overlay"  // macOS 红绿灯叠加
      }
    ]
  }
}
```

```tsx
// src/components/TitleBar.tsx
// macOS 风格：左侧红绿灯 + 中间标题 + 右侧窗口控制
export function TitleBar() {
  return (
    <div data-tauri-drag-region
      className="h-10 flex items-center justify-between px-3
        bg-background/80 backdrop-blur-xl border-b">
      <div className="flex items-center gap-2 pl-[70px]">
        {/* macOS 红绿灯由 Tauri 自动渲染 */}
        <span className="text-xs font-medium text-muted-foreground">
          CrabHub
        </span>
      </div>
      <div className="flex items-center gap-1">
        {/* 自定义操作按钮 */}
      </div>
    </div>
  );
}
```

### 9.7 毛玻璃侧边栏

```tsx
// src/components/Sidebar.tsx 改造
<aside className="h-full flex flex-col
  bg-white/70 dark:bg-gray-900/70
  backdrop-blur-xl backdrop-saturate-150
  border-r border-border/50
  transition-all duration-200">
  {/* 连接树、历史、收藏 */}
</aside>
```

---

## 10. AI Agent —— 自主操作数据库

### 10.1 现状

CrabHub 当前 AI 模块是**被动式对话**：
- 用户输入文字 → 调用 LLM Chat API → 返回文本回复
- 用户得自己把 AI 生成的 SQL 复制粘贴到编辑器执行
- AI 对当前连接的数据库一无所知（除非用户手动描述）

### 10.2 目标

AI 从"问答机器人"升级为**数据库助理 DBA**，能**自主调用数据库工具**完成任务：

```
用户: "帮我看看为什么 orders 表查询特别慢，并优化一下"

AI 自动执行:
  1. get_table_info("orders")          → 了解表结构（15列，50万行）
  2. get_indexes("orders")             → 查看现有索引（只有主键索引）
  3. explain_query("SELECT * FROM orders WHERE status='pending' ORDER BY created_at")
                                       → 发现 Seq Scan，cost=15420
  4. 分析结论: 缺少 (status, created_at) 复合索引
  5. 建议: CREATE INDEX idx_orders_status_created ON orders(status, created_at)
  6. 等待用户确认 → 用户点"执行"
  7. 再次 EXPLAIN 验证效果 → cost 降到 120
  8. 汇报: "查询耗时从 2.3s 降到 0.02s"
```

### 10.3 架构：ReAct 模式 + Function Calling

```
┌──────────────────────────────────────────────────┐
│                AI Agent Runtime (Rust)            │
│                                                  │
│  ┌────────────┐  ┌───────────┐  ┌────────────┐  │
│  │Tool Registry│  │Safety Gate│  │ReAct Loop  │  │
│  │            │  │           │  │            │  │
│  │Tool 1:     │  │Safe ──▶ 放行│  │Think → Act │  │
│  │get_schema  │  │ReadOnly ─▶ │  │→ Observe → │  │
│  │            │  │      放行  │  │Think → ... │  │
│  │Tool 2:     │  │           │  │            │  │
│  │execute_sql │  │Destructive │  │max_iter: 10│  │
│  │            │  │  ──▶ 确认  │  │            │  │
│  │Tool 3:     │  │           │  │            │  │
│  │explain_qry │  │           │  │            │  │
│  │            │  │           │  │            │  │
│  │Tool 4:     │  │           │  │            │  │
│  │get_indexes │  │           │  │            │  │
│  └────────────┘  └───────────┘  └────────────┘  │
│                                                  │
│  ┌─────────────────────────────────────────┐     │
│  │         Context Builder                 │     │
│  │  自动注入: Schema 摘要 + 表列表 +       │     │
│  │  索引信息 + 慢查询日志 + 错误历史       │     │
│  └─────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

### 10.4 工具注册表（Tool Registry）

AI 可调用的数据库操作工具列表：

| 工具名 | 描述 | 危险等级 | 需要确认 |
|--------|------|----------|----------|
| `get_schema_summary` | 获取数据库 Schema 摘要（表名+列名+行数估算） | Safe | ❌ |
| `get_table_info` | 获取指定表的列、类型、索引、外键 | Safe | ❌ |
| `get_indexes` | 获取指定表的所有索引 | Safe | ❌ |
| `get_foreign_keys` | 获取外键关系 | Safe | ❌ |
| `execute_select` | 执行 SELECT 查询（只读，自动 LIMIT 500） | ReadOnly | ❌ |
| `explain_query` | 分析 SQL 执行计划 | Safe | ❌ |
| `get_slow_queries` | 获取慢查询日志（如果数据库支持） | Safe | ❌ |
| `get_table_row_count` | 精确行数统计 | Safe | ❌ |
| `execute_sql` | 执行任意 SQL（包括 DDL/DML） | Destructive | ✅ 必须 |
| `create_index` | 创建索引 | Destructive | ✅ 必须 |
| `cancel_query` | 取消正在运行的查询 | Safe | ❌ |

每个工具定义包含 JSON Schema 参数声明，LLM 通过 function calling 自动选择调用。

### 10.5 ReAct 循环（推理-行动-观察）

```rust
// src-tauri/src/ai/agent.rs
struct AgentLoop {
    connection_id: String,
    llm_client: AIClient,
    tools: Vec<AgentTool>,
    safety_gate: SafetyGate,
    max_iterations: u32,  // 最多 10 轮，防止死循环
}

enum LLMResponse {
    ToolCall {
        thought: String,           // AI 的推理过程
        tool_name: String,
        params: serde_json::Value,
    },
    FinalAnswer {
        content: String,
    },
    NeedClarification {
        question: String,
    },
}

impl AgentLoop {
    async fn run(&mut self, user_message: &str) -> AgentResult {
        // 1. 构建 system prompt（注入数据库上下文）
        let system = self.context_builder.build().await;

        // 2. ReAct 循环
        for i in 0..self.max_iterations {
            let response = self.llm_client
                .chat_with_tools(&system, &self.messages, &self.tools)
                .await?;

            match response {
                LLMResponse::ToolCall { thought, tool_name, params } => {
                    // 显示推理过程
                    self.emit_event(AgentEvent::Thinking(thought));

                    // 安全检查
                    let action = self.safety_gate.evaluate(&tool_name, &params);
                    match action {
                        SafetyAction::Allow => {
                            // 执行工具
                            let result = self.execute_tool(&tool_name, &params).await;
                            self.messages.push(ToolResult { tool_name, result });
                            self.emit_event(AgentEvent::ToolExecuted(tool_name, result));
                        }
                        SafetyAction::Confirm => {
                            // 暂停，等待用户确认
                            self.emit_event(AgentEvent::NeedsConfirmation {
                                tool_name,
                                params,
                                reason: self.safety_gate.explain(&tool_name),
                            });
                            let approved = self.wait_for_user_approval().await;
                            if approved {
                                let result = self.execute_tool(&tool_name, &params).await;
                                self.messages.push(ToolResult { tool_name, result });
                            } else {
                                self.messages.push(ToolRejected { tool_name });
                            }
                        }
                        SafetyAction::Deny => {
                            self.messages.push(ToolRejected { tool_name });
                            self.emit_event(AgentEvent::ToolDenied(tool_name));
                        }
                    }
                }
                LLMResponse::FinalAnswer { content } => {
                    return AgentResult::Success(content);
                }
                LLMResponse::NeedClarification { question } => {
                    return AgentResult::NeedInput(question);
                }
            }
        }
        AgentResult::MaxIterationsReached
    }
}
```

### 10.6 安全门禁（五级防护）

```
第 1 级 — 工具级别:
  Safe(获取 schema/索引/执行计划) → 自动放行
  ReadOnly(SELECT 查询)          → 自动放行
  Destructive(DDL/DML)           → 进入第 2 级检查

第 2 级 — SQL 解析:
  解析 SQL 语句类型:
  SELECT → ReadOnly 放行
  INSERT/UPDATE → 进入第 3 级
  DELETE/DROP/TRUNCATE/ALTER → 必须确认

第 3 级 — 关键词检测:
  检测危险关键词: DROP TABLE, TRUNCATE, ALTER SYSTEM, GRANT
  命中 → 警告 + 必须确认

第 4 级 — 影响范围:
  DELETE 无 WHERE → 拒绝（全表删除）
  DELETE 有限制 → 估算影响行数，> 100 行需确认
  ALTER TABLE → 显示变更内容，需确认

第 5 级 — 用户配置:
  用户可设置每个危险等级的默认策略:
  - 总是确认（默认）
  - 连接会话内允许（记住 30 分钟）
  - 始终允许（不推荐）
```

```rust
struct SafetyGate {
    config: UserSafetyConfig,
}

struct UserSafetyConfig {
    auto_approve_select: bool,        // true
    auto_approve_readonly: bool,      // true
    require_confirm_ddl: bool,        // true
    require_confirm_dml: bool,        // true
    require_confirm_drop: bool,       // true
    max_rows_without_confirm: u64,    // 100
}
```

### 10.7 上下文构建器

每次 LLM 推理时自动注入数据库上下文：

```rust
struct ContextBuilder {
    connection_id: String,
    connection_manager: Arc<ConnectionManager>,
}

impl ContextBuilder {
    async fn build(&self) -> String {
        let conn = self.connection_manager.get(&self.connection_id);
        let schema = conn.get_schema_summary().await; // 表名列表 + 行数估算
        let recent_errors = conn.get_recent_errors().await;

        format!(r#"你是 CrabHub 的数据库助理 DBA，拥有操作数据库的能力。

## 当前数据库上下文
- 数据库类型: {db_type}
- 数据库版本: {db_version}
- 当前时间: {current_time}

## Schema 摘要
{schema}

## 可用工具
{tools_description}

## 行为准则
1. 分析问题前先了解数据库结构（使用 get_schema_summary / get_table_info）
2. 优化建议必须先 EXPLAIN 验证前后对比
3. 任何修改数据的操作（DDL/DML）必须先征求用户确认
4. 查询自动添加 LIMIT 500 防止大量回传
5. SQL 执行出错时，分析错误信息并自动修正重试（最多 2 次）
6. 思考过程用中文，生成的 SQL 保持英文
7. 每次回答以可操作的建议结束（而非泛泛而谈）
"#)
    }
}
```

### 10.8 前端 UI：Agent 聊天面板

```
┌────────────────────────────────────────────────┐
│  🤖 CrabHub AI Agent                  [−][×]   │
├────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────┐  │
│  │ 连接: prod-postgres (15 表, 230 万行)   │  │ ← 上下文摘要条
│  │ Schema 已注入 · 可执行操作              │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  👤 帮我分析 orders 表为什么查询慢             │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ 💭 思考                                 │  │ ← 可折叠
│  │ 先了解 orders 表的结构和现有索引...      │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ 🔧 get_table_info("orders")      ✓      │  │ ← 工具调用折叠条
│  │    📄 15 列, 500,000 行, 1 个索引(PK)   │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ 🔧 explain_query(...)             ✓      │  │
│  │    ⚠️ Seq Scan on orders  cost=15420     │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  🤖 发现问题：orders 表缺少 (status,           │
│     created_at) 复合索引，导致全表扫描。        │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ 💡 建议执行:                             │  │ ← 操作卡片
│  │ CREATE INDEX idx_orders_status_created    │  │
│  │   ON orders (status, created_at);         │  │
│  │                                          │  │
│  │ [▶ 执行]  [📋 复制]  [❌ 忽略]           │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ > 继续输入...                         📎 │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ⚙️ 模型: DeepSeek V3  ·  连接: prod-pg       │ ← 状态栏
└────────────────────────────────────────────────┘
```

### 10.9 新增文件清单

**Rust 后端：**

| 文件 | 内容 | 行数估算 |
|------|------|----------|
| `src-tauri/src/ai/agent.rs` | ReAct 循环、工具调度、事件发射 | ~400 |
| `src-tauri/src/ai/tools.rs` | 工具注册表、每个工具的 handler | ~300 |
| `src-tauri/src/ai/safety.rs` | 安全门禁（五级检查） | ~150 |
| `src-tauri/src/ai/context.rs` | Schema 摘要构建、prompt 模板 | ~100 |
| `src-tauri/src/ai/commands.rs` | `agent_run`, `agent_confirm`, `agent_cancel` Tauri 命令 | 增量 ~100 |

**前端：**

| 文件 | 内容 | 行数估算 |
|------|------|----------|
| `src/components/AgentPanel.tsx` | Agent 聊天面板、思考/工具调用/结果渲染 | ~500 |
| `src/components/AgentToolCall.tsx` | 工具调用的折叠展示组件 | ~100 |
| `src/components/AgentConfirmDialog.tsx` | 危险操作确认对话框 | ~80 |

### 10.10 推荐的 LLM 模型

Agent 模式需要支持 **function calling / tool use**：

| 模型 | Function Calling | 推荐度 | 备注 |
|------|-----------------|--------|------|
| DeepSeek V3 | ✅ | ⭐⭐⭐ | 性价比最高，中文好 |
| GPT-4o | ✅ | ⭐⭐⭐ | 推理最强 |
| Claude 4 Sonnet | ✅ | ⭐⭐⭐ | 代码/数据库场景最强 |
| Qwen-Max | ✅ | ⭐⭐⭐ | 国产首选 |
| Ollama (Qwen2.5:14B+) | ✅ | ⭐⭐ | 本地部署，推理偏弱 |

---

*设计文档版本: 2.0*
*日期: 2026-05-21*
