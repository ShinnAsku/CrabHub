# CrabHub

轻量级、开源的通用数据库管理工具，桌面 + Web 双形态，内置 AI 助手。兼容 Tabularis 插件生态。

## 功能

- **多数据库支持** — 17 种数据库：PostgreSQL、MySQL、SQLite、ClickHouse、GaussDB、Kingbase、Vastbase、YashanDB、OceanBase、TiDB、TDSQL、Oracle、SQL Server、DaMeng、GBase、Redis、MongoDB（Redis/MongoDB 为原生 Rust 驱动，桌面 / Web / MCP / CLI 全通道可用）
- **Web 版 / Docker 部署** — 同一套 UI 跑在浏览器里，单二进制 `crabhub-server` + Docker 镜像，自带密码登录（PBKDF2 + 暴破退避），见 [Web 版部署](#web-版部署)
- **MCP 接入** — 内置 MCP Server，Claude Code / Cursor / VS Code 等 AI 客户端可直接使用 CrabHub 已配置的连接查库
- **CLI** — `crabhub connections/tables/columns/query` 命令行直接查库，复用应用内连接，支持 `--json` 输出
- **插件系统** — 兼容 Tabularis 协议，社区插件（DuckDB、Redis、CSV 等），支持 JSON-RPC 2.0 over stdio
- **AI 助手** — 支持 DeepSeek / Qwen / Ollama / OpenAI，自然语言生成 SQL、执行计划分析、优化建议
- **SQL 编辑器** — 基于 Monaco Editor，语法高亮、schema 感知自动补全（列信息按需加载，无表数上限）、格式化、多语句执行
- **数据浏览与编辑** — Navicat 风格表格视图、行内编辑、分页、导入导出（CSV/JSON/SQL/XLSX）
- **流式导出** — Rust 侧分批拉取直写文件，内存恒定，任意大小表可导出，带进度与取消
- **服务端查询取消** — 取消真正终止服务器上的查询（pg_cancel_backend / KILL QUERY / 协议级 CancelRequest），连接池不被幽灵查询占用
- **ER 图** — 可视化表关系和外键，自动布局
- **表设计器** — 字段、索引、外键、触发器设计，DDL 预览
- **结构对比** — Schema Diff，生成迁移 SQL
- **数据迁移** — 跨库表结构和数据迁移
- **SQL 方言转换** — 编辑器右键一键转换 SQL 方言（PG ↔ MySQL ↔ GaussDB ↔ SQLite 等），类型映射与迁移功能共用一套规则，不确定的转换以警告注释标出
- **原生 DDL 预览** — 各数据库贴合自身语法生成 DDL（精确类型长度、DEFAULT、PRIMARY KEY、COMMENT ON、二级索引），MySQL 直接用 SHOW CREATE TABLE
- **SQL 笔记本** — 类 Jupyter，SQL + Markdown 混合
- **可视化查询构建器** — 拖拽式建表、JOIN、筛选
- **性能** — 连接级锁粒度（慢查询不阻塞其他连接）、IPC 行数据数组化（宽表负载减半）、元数据 TTL 缓存、查询超时可配置（0 = 不限时）
- **7 套主题** — Light / Dark / Solarized Light / Nord / Dracula / One Dark / Midnight，中英双语，自适应窗口缩放
- **安全** — OS Keyring 凭证存储，AES-256-GCM 加密，TLS/SSH 隧道，SQL 注入防护

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript 5.7 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 (modular stores: tab, ui, connection, history) |
| 编辑器 | Monaco Editor |
| 流程图 | ReactFlow (ER 图) |
| 数据库驱动 | SQLx (PG/MySQL/SQLite), ShinnAsku/gaussdb-rs, tiberius (MSSQL), clickhouse-rs, ssh2 (SSH) |
| 插件通信 | JSON-RPC 2.0 over stdio (Tabularis 兼容) |
| AI | reqwest SSE streaming, DeepSeek/OpenAI API 兼容 |
| 构建 | Vite 6 + Rust/Cargo |
| 测试 | Vitest (前端), cargo test (Rust) |

## 快速开始

### 环境要求

- **Node.js** ≥ 18
- **Rust** ≥ 1.77.2
- **Windows**: Visual Studio Build Tools 2022 (C++ 桌面开发)
- **macOS**: Xcode Command Line Tools
- **Linux**: build-essential, libwebkit2gtk, libgtk-3-dev

### 开发

```bash
# 安装依赖
npm install

# 纯前端开发 (Mock 模式)
npm run dev:mock

# Tauri 桌面开发 (前端 + Rust)
npm run tauri dev

# 构建
npm run tauri build
```

### 命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动前端开发服务器 |
| `npm run dev:mock` | Mock 模式（无需数据库） |
| `npm run tauri dev` | 启动桌面应用开发 |
| `npm run tauri build` | 生产构建 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run test:unit` | 前端单元测试 (Vitest) |
| `npm run rust:test` | Rust 单元测试 (cargo test) |
| `npm run test:all` | 全部检查（TS + Rust + 测试） |

## 项目结构

```
crabhub/
├── src/                              # React 前端
│   ├── components/                   # UI 组件
│   │   ├── MainLayout.tsx            # 主布局（缩放、视图切换）
│   │   ├── TitleBar.tsx              # 自定义标题栏（窗口控制 + 螃蟹图标）
│   │   ├── Toolbar.tsx               # 工具栏操作
│   │   ├── Sidebar.tsx               # 侧边栏（连接树 + schema 浏览器）
│   │   ├── EditorPanel.tsx           # SQL 编辑器 + 页签内容分发
│   │   ├── CrabHubMainPanel.tsx      # Navicat 风格数据库浏览器
│   │   ├── main-panel/
│   │   │   ├── MainPanelTabBar.tsx   # 双层 Tab 栏（编辑器 / 数据）
│   │   │   ├── ObjectListView.tsx    # 对象列表（表 + 列预览 + DDL）
│   │   │   ├── TableDataView.tsx     # 表数据视图（分页 + CRUD）
│   │   │   └── TableContextMenu.tsx  # 表右键菜单
│   │   ├── AIPanel.tsx               # AI 助手浮动面板
│   │   ├── WelcomeScreen.tsx         # 欢迎页
│   │   ├── ConnectionDialog.tsx      # 新建/编辑连接
│   │   ├── PluginManager.tsx         # 插件管理
│   │   ├── TableDesigner.tsx         # 表设计器
│   │   ├── ERDiagram.tsx             # ER 图 (ReactFlow)
│   │   ├── SchemaDiffDialog.tsx      # 结构对比
│   │   ├── DataMigration.tsx         # 数据迁移
│   │   ├── ImportExportDialog.tsx    # 导入导出
│   │   ├── notebook/                 # SQL 笔记本
│   │   └── query-builder/            # 可视化查询构建器
│   ├── stores/                       # Zustand 状态管理 (modular)
│   ├── lib/                          # 工具库 (i18n, DDL, 导出, 命令, 日志)
│   ├── types/                        # TypeScript 类型
│   └── styles/                       # CSS 主题变量
│
├── src-tauri/                        # Tauri Rust 后端
│   ├── src/
│   │   ├── db/                       # 数据库驱动层
│   │   │   ├── trait_def.rs          # DatabaseConnection trait
│   │   │   ├── manager.rs            # 连接管理器（心跳、重连、取消、元数据缓存）
│   │   │   ├── types.rs              # 连接配置、查询结果（含 IPC wire 类型）、错误类型
│   │   │   ├── export.rs             # 流式导出（CSV/JSON/SQL/XLSX + 进度事件）
│   │   │   ├── dialect.rs            # SQL 方言配置（PG/MySQL/Oracle/...）
│   │   │   ├── sql_limiter.rs        # SQL 注入防护（tokenizer + LIMIT 注入）
│   │   │   ├── postgres.rs           # PostgreSQL 驱动 (SQLx)
│   │   │   ├── mysql.rs              # MySQL 驱动 (SQLx)
│   │   │   ├── sqlite.rs             # SQLite 驱动 (SQLx + rusqlite)
│   │   │   ├── clickhouse.rs         # ClickHouse 驱动 (HTTP)
│   │   │   ├── gauss_rs.rs           # GaussDB 驱动 (tokio-gaussdb wire protocol)
│   │   │   ├── pg_compatible.rs      # PG 兼容驱动 (Kingbase/Vastbase/YashanDB)
│   │   │   ├── sqlserver.rs          # SQL Server 驱动 (tiberius TDS)
│   │   │   ├── odbc_bridge.rs        # ODBC 桥接 (Oracle/DaMeng/GBase 保留)
│   │   │   └── smoke_tests.rs        # 冒烟测试
│   │   ├── connection_store/         # 连接持久化 (SQLite + AES-256-GCM 加密)
│   │   ├── plugins/                  # 插件系统
│   │   │   ├── manager.rs            # 插件管理器（发现、加载、生命周期）
│   │   │   ├── driver.rs             # PluginDriver (DatabaseConnection → JSON-RPC)
│   │   │   ├── rpc.rs                # RpcClient (stdio JSON-RPC 2.0)
│   │   │   ├── installer.rs          # 插件安装器（下载 + ZIP + SHA-256 校验）
│   │   │   ├── registry.rs           # 插件注册表（本地 + 远程）
│   │   │   └── commands.rs           # Tauri 命令
│   │   ├── ai/                       # AI 模块
│   │   │   ├── agent.rs              # Agent 循环（LLM ↔ 工具执行）
│   │   │   ├── client.rs             # HTTP 客户端（SSE 流式 + 重试）
│   │   │   ├── safety.rs             # SQL 安全门（多语句检测、DDL/DML 确认）
│   │   │   ├── optimizer.rs          # SQL 静态分析优化建议
│   │   │   ├── tools.rs              # AI 工具定义
│   │   │   ├── types.rs              # AI 类型
│   │   │   ├── commands.rs           # AI 相关 Tauri 命令
│   │   │   └── context.rs            # AI 上下文构建
│   │   ├── ssh/                      # SSH 隧道（ssh2）
│   │   ├── rpc/                      # jsonrpsee RPC 服务器（127.0.0.1:3030，MCP/CLI 后端）
│   │   ├── server/                   # axum Web 服务器（认证 + /api/invoke 命令分发）
│   │   ├── bin/crabhub-server.rs     # Web 版独立二进制入口
│   │   └── testing/                  # 测试工具（mock 数据 + benchmark）
│   ├── icons/                        # 螃蟹图标 (ico/icns/png/svg, 40+ 平台)
│   └── tauri.conf.json               # Tauri 配置
│
├── packages/
│   ├── mcp-server/                   # MCP Server（stdio → 本地 RPC 桥，零依赖）
│   └── cli/                          # CLI（connections/tables/columns/query，零依赖）
│
├── deploy/                           # Web 版部署（Dockerfile + docker-compose.yml）
│
├── test/                             # 前端测试
│   ├── unit/                         # 单元测试（stores, i18n, utils, commands）
│   └── mock/                         # Mock 数据
└── package.json
```

## 数据库驱动

| 驱动 | 类型 | 实现 | 默认端口 |
|------|------|------|---------|
| PostgreSQL | 内置 | SQLx async | 5432 |
| MySQL | 内置 | SQLx async | 3306 |
| SQLite | 内置 | SQLx + rusqlite | — |
| ClickHouse | 内置 | HTTP REST | 8123 |
| GaussDB | 内置 | tokio-gaussdb wire protocol | 8000 |
| Kingbase | 内置 | PG 兼容 (SQLx) | 54321 |
| Vastbase | 内置 | PG 兼容 (SQLx) | 5432 |
| YashanDB | 内置 | PG 兼容 (SQLx) | 1688 |
| OceanBase | 内置 | MySQL 兼容 (SQLx) | 3306 |
| TiDB | 内置 | MySQL 兼容 (SQLx) | 3306 |
| TDSQL | 内置 | MySQL 兼容 (SQLx) | 3306 |
| Oracle | ODBC | ODBC 桥接 | 1521 |
| SQL Server | 内置 | tiberius TDS | 1433 |
| DaMeng | ODBC | ODBC 桥接 | 5236 |
| GBase | ODBC | ODBC 桥接 | 5258 |
| Redis | 内置 | redis-rs 原生异步（查询编辑器直接写 Redis 命令） | 6379 |
| MongoDB | 内置 | mongodb 官方驱动（mongo-shell 语法：`db.coll.find({...})`，支持 `mongodb+srv://` URI） | 27017 |
| DuckDB/CSV/... | 插件 | Tabularis JSON-RPC 协议（仅桌面版） | 插件定义 |

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         CrabHub                                  │
├────────────────────┬────────────────────────────────────────────┤
│  React 19          │  Tauri v2 (Rust)                           │
│  TypeScript 5.7    │                                            │
│  Tailwind CSS 4    │  ┌──────────────────────────────────────┐  │
│  Zustand 5 (mod)   │  │  ConnectionManager                   │  │
│  Monaco Editor     │  │  ┌────────┬────────┬────────┬──────┐│  │
│  ReactFlow         │  │  │ PG     │ MySQL  │ SQLite │Click ││  │
│                    │  │  ├────────┼────────┼────────┼──────┤│  │
│  ┌──────────────┐  │  │  │GaussDB │Kingbase│Vastbase│Yashan││  │
│  │ MainPanel    │  │  │  ├────────┼────────┼────────┼──────┤│  │
│  │ TabBar (2层) │  │  │  │OceanB. │ TiDB   │ TDSQL  │MSSQL ││  │
│  │ ┌──────────┐ │  │  │  ├────────┼────────┼────────┼──────┤│  │
│  │ │编辑器Tab │ │  │  │  │Oracle  │ DaMeng │ GBase  │Plugin││  │
│  │ │query/ER/ │ │  │  │  └────────┴────────┴────────┴──────┘│  │
│  │ │notebook  │ │  │  └──────────────────────────────────────┘  │
│  │ ├──────────┤ │  │  ┌──────────────────────────────────────┐  │
│  │ │数据Tab   │ │  │  │  PluginManager                       │  │
│  │ │Objects/  │ │  │  │  JSON-RPC 2.0 stdio                  │  │
│  │ │Table/    │ │  │  │  Tabularis 兼容                      │  │
│  │ │Designer  │ │  │  │  Registry (local + remote)           │  │
│  │ └──────────┘ │  │  └──────────────────────────────────────┘  │
│  ├──────────────┤  │  ┌──────────────────────────────────────┐  │
│  │ 内容区       │  │  │  AI Agent                            │  │
│  │ ObjectList/  │  │  │  ToolExecutor → SQL → LLM → 建议     │  │
│  │ TableData/   │  │  │  SafetyGate (DDL/DML 拦截)           │  │
│  │ EditorPanel  │  │  │  SSE Streaming                       │  │
│  └──────────────┘  │  └──────────────────────────────────────┘  │
│                    │  ┌──────────────────────────────────────┐  │
│  IPC ──────────────│──│  SS / SSH Tunnel / Auto-Reconnect    │  │
│                    │  │  AES-256-GCM 凭证加密                 │  │
│                    │  └──────────────────────────────────────┘  ││                    │  ┌──────────────────────────────────────┐  │
│  MCP 客户端 ───────│──│  RPC Server (127.0.0.1:3030)         │  │
│  (Claude/Cursor)   │  │  ← packages/mcp-server (stdio 桥)    │  │
│                    │  └──────────────────────────────────────┘  │└────────────────────┴────────────────────────────────────────────┘
```

## 快捷键

| 快捷键 | 操作 |
|------|------|
| `Ctrl+N` | 新建连接 |
| `Ctrl+Shift+N` | 新建查询 |
| `Ctrl+W` | 关闭当前页签 |
| `Ctrl+Enter` | 执行 SQL |
| `Ctrl+B` | 切换侧边栏 |
| `Ctrl+J` | 切换 AI 面板 |
| `F5` | 执行查询 |

## 插件系统

兼容 [Tabularis](https://github.com/TabularisDB/tabularis) 插件协议。插件通过 JSON-RPC 2.0 over stdio 与主进程通信，支持任意语言开发。

```bash
# 插件目录
Windows: %APPDATA%/com.crabhub.app/plugins/
macOS:   ~/Library/Application Support/com.crabhub.app/plugins/
Linux:   ~/.local/share/crabhub/plugins/
```

插件安装后重启应用即可在新建连接下拉列表中看到（插件类型会用分隔线标注）。

> 注意：插件依赖本地子进程，仅桌面版可用。Web 版请使用内置驱动（Redis / MongoDB 已内置，无需插件）。

## Web 版部署

CrabHub 提供独立的 Web 服务器二进制 `crabhub-server`：同一套前端 UI 跑在浏览器里，功能与桌面版基本一致（连接管理、SQL 编辑器、表数据 CRUD、ER 图、表设计器、AI 助手、导入导出等）。

### 方式一：Docker（推荐）

```bash
# 构建镜像（仓库根目录）
docker build -t crabhub -f deploy/Dockerfile .

# 运行
docker run -d -p 4224:4224 \
  -e CRABHUB_WEB_PASSWORD=change-me \
  -e CRABHUB_MASTER_KEY=change-me-too-16ch \
  -v crabhub-data:/app/data \
  crabhub
```

或使用 docker-compose：

```bash
cd deploy
CRABHUB_WEB_PASSWORD=change-me CRABHUB_MASTER_KEY=change-me-too-16ch docker compose up -d
```

浏览器打开 `http://<host>:4224`，用 `CRABHUB_WEB_PASSWORD` 设定的密码登录即可。

### 方式二：直接运行二进制

```bash
# 构建前端静态资源 + 服务器二进制
npm install && npm run build
cd src-tauri && cargo build --release --bin crabhub-server

# 启动
CRABHUB_WEB_PASSWORD=change-me \
CRABHUB_STATIC_DIR=./dist \
./src-tauri/target/release/crabhub-server
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CRABHUB_WEB_PORT` | `4224` | 监听端口 |
| `CRABHUB_BIND` | `127.0.0.1` | 绑定地址；绑定非回环地址（如 `0.0.0.0`）时**必须**设置登录密码，否则拒绝启动 |
| `CRABHUB_WEB_PASSWORD` | — | Web UI 登录密码（≥8 位）。仅首次启动时作为种子写入，之后可在存储中轮换；未设置且首次访问时，页面会引导设置初始密码 |
| `CRABHUB_MASTER_KEY` | — | ≥16 字符，用于加密存储的连接凭据（容器内没有 OS Keyring 时必须提供） |
| `CRABHUB_DATA_DIR` | 系统应用目录 | 连接配置数据库（connections.db）存放目录 |
| `CRABHUB_STATIC_DIR` | — | 前端静态资源目录（`npm run build` 产物 `dist/`） |

### 安全机制

- 密码以 PBKDF2-HMAC-SHA256（10 万次迭代 + 盐）哈希存储，常数时间比较
- 连续登录失败 5 次后指数退避（封顶 300 秒）
- 登录后签发 Bearer token（有效期 24h），前端自动携带，401 自动回到登录页
- 连接凭据用 AES-256-GCM 加密落盘（密钥来自 `CRABHUB_MASTER_KEY` 或 OS Keyring）

### 与桌面版的差异

| 能力 | 桌面 | Web |
|------|------|-----|
| 内置 17 种数据库驱动 | ✅ | ✅ |
| SQL 编辑器 / 数据 CRUD / ER 图 / 表设计器 / AI 助手 | ✅ | ✅ |
| Tabularis 插件 | ✅ | ❌（用内置驱动替代） |
| 流式导出到本地文件 | ✅ | 走浏览器内存导出（大表建议桌面版） |
| MCP / CLI（本地 RPC 3030） | ✅ | ❌（仅桌面进程提供） |
| SQLite 文件浏览 | ✅ | 需服务器可访问的路径 |

> 生产部署建议：置于反向代理（Nginx/Caddy）之后启用 HTTPS；数据库网络与公网隔离，CrabHub 部署在可达数据库的内网。

## CLI

零依赖 Node 脚本（Node ≥ 18），通过本地 RPC（`127.0.0.1:3030`）复用 CrabHub 桌面应用中已打开的连接——凭据不出应用。

```bash
node packages/cli/index.mjs connections list          # 列出已打开的连接
node packages/cli/index.mjs tables <connection-id>    # 列出表
node packages/cli/index.mjs columns <connection-id> <table> [--schema public]
node packages/cli/index.mjs query <connection-id> "SELECT * FROM users LIMIT 10"
```

所有子命令支持 `--json` 输出，便于脚本管道处理。可用 `CRABHUB_RPC_URL` 覆盖 RPC 地址。前提：CrabHub 桌面应用正在运行。

## MCP 接入（AI Agent）

CrabHub 内置 MCP Server，让 Claude Code、Cursor、VS Code 等 MCP 客户端直接使用你在 CrabHub 里已配置的数据库连接——**凭据留在本地，不经过 AI**。

在 MCP 客户端配置（如 `.mcp.json`）中添加：

```json
{
  "mcpServers": {
    "crabhub": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/index.mjs"]
    }
  }
}
```

前提：CrabHub 桌面应用正在运行且已连接数据库（MCP Server 通过本地 RPC `127.0.0.1:3030` 与应用通信，仅监听回环地址）。

提供的工具：

| 工具 | 说明 |
|------|------|
| `list_connections` | 列出应用中已打开的连接（不含凭据） |
| `list_tables` | 列出表（含行数、主键等元数据） |
| `get_columns` | 表的列元数据 |
| `execute_sql` | 执行 SQL（SELECT 返回结果集，DML/DDL 返回影响行数） |

## 安全设计

- **凭证存储**: OS Keyring (Windows Credential Manager / macOS Keychain / Linux Secret Service)；容器/Web 部署用 `CRABHUB_MASTER_KEY`
- **Web 认证**: PBKDF2-HMAC-SHA256 密码哈希、登录失败指数退避、Bearer token TTL 24h、无密码拒绝非回环绑定
- **传输加密**: TLS 1.2+ (native-tls) / SSH 隧道 (ssh2)
- **SQL 注入防护**: SQL tokenizer + LIMIT 注入 + 多语句拦截
- **AI 安全门**: DDL/DML 操作需确认，多语句 SQL 直接拒绝，DROP/TRUNCATE 二次确认
- **插件安全**: ZIP 解压时 Zip Slip 路径穿越防护，可选 SHA-256 校验和验证

## License

MIT
