# CrabHub

轻量级、开源的通用数据库管理工具，桌面 + Web 双形态，内置 AI 助手。兼容 Tabularis 插件生态。

## 功能

- **数据库连接** — 17 个内置连接选项，支持程度不同。Oracle、达梦、崖山和 GBase 默认使用 Rust 原生适配路径，JDBC 为显式备选。见 [原生客户端安装](packages/native-clients/README.md) 和 [JDBC 安装](packages/jdbc-bridge/README.md)。
- **Web 版 / Docker 部署** — 同一套 UI 跑在浏览器里，单二进制 `crabhub-server` + Docker 镜像，自带密码登录（PBKDF2 + 暴破退避），见 [Web 版部署](#web-版部署)
- **MCP 接入** — 内置 MCP Server，Claude Code / Cursor / VS Code 等 AI 客户端可直接使用 CrabHub 已配置的连接查库
- **CLI** — `crabhub connections/tables/columns/query` 命令行直接查库，复用应用内连接，支持 `--json` 输出
- **插件系统** — 兼容 Tabularis 协议，社区插件（DuckDB、Redis、CSV 等），支持 JSON-RPC 2.0 over stdio
- **AI 助手** — 支持 DeepSeek / Qwen / Ollama / OpenAI，自然语言生成 SQL、执行计划分析、优化建议
- **SQL 编辑器** — 基于 Monaco Editor，语法高亮、schema 感知自动补全（列信息按需加载，无表数上限）、格式化、多语句执行
- **数据浏览与编辑** — Navicat 风格表格视图、行内编辑、分页、导入导出（CSV/JSON/SQL/XLSX）
- **流式导出** — Rust 侧分批拉取直写文件，内存恒定，任意大小表可导出，带进度与取消
- **查询取消** — 新会话在 PostgreSQL/MySQL 上按物理租约定向取消；取消请求不等于写入已回滚，提交状态未知时不自动重试
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

## SQL 执行模式

编辑器保留旧模式为默认，并为已适配的 SQLite 文件库、PostgreSQL 和 MySQL 提供显式脚本会话及独立只读模式。脚本使用固定物理连接，事务需要明确选择；CSV/JSON 导入可选参数化批量写入，数据迁移在已支持的目标上按页使用 bulk。

支持逐语句渐进结果、主机密钥校验的 SSH、定向取消和故障开关。GaussDB 新会话与原生多结果集批处理仍未启用；大结果是预览而非完整导出。

交互式事务由后端持有固定物理会话，按编辑器页签保存句柄，支持 SQLite 文件库、PostgreSQL 和 MySQL。事务中仅允许已分类的查询和 DML；MySQL 写入要求可见的 InnoDB 表且无触发器。提交、回滚、执行错误、取消、关闭页签、断连或连续闲置五分钟后释放会话，全局最多 16 个。事务内结果仍为有界预览，表格直接编辑和导入不能绕过事务会话。网络错误后的写入结果可能未知，不会自动重试。

普通连接池入口拒绝独立的 `BEGIN`、`COMMIT`、`ROLLBACK` 等事务控制；完整事务脚本应使用脚本会话。事务占用连接池名额，池满只报告等待超时，不触发重连或自动扩大连接数。自定义 TLS 证书配置可保存和回填，其中私钥加密存储；当前运行时未接入自定义证书校验，显式使用时返回不支持，不会静默忽略。

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript 5.7 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 (modular stores: tab, ui, connection, history) |
| 编辑器 | Monaco Editor |
| 流程图 | ReactFlow (ER 图) |
| 数据库驱动 | SQLx (PG/MySQL/SQLite), gaussdb-rs, Tiberius, ClickHouse HTTP, Rust 原生客户端适配器 |
| 插件通信 | JSON-RPC 2.0 over stdio (Tabularis 兼容) |
| AI | reqwest SSE streaming, DeepSeek/OpenAI API 兼容 |
| 构建 | Vite 6 + Rust/Cargo |

## 快速开始

### 环境要求

- **Node.js** ≥ 18
- **Rust** 1.95（由 rust-toolchain.toml 固定）
- **Windows**: Visual Studio Build Tools 2022 (C++ 桌面开发)
- **macOS**: Xcode Command Line Tools
- **Linux**: build-essential, libwebkit2gtk, libgtk-3-dev

Windows 构建前在同一个 PowerShell 会话运行 `./deploy/setup-windows-openssl.ps1`，配置所需的静态 OpenSSL。Linux/macOS 构建还需要 unixODBC。

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
| `npm run architecture:check` | 核心依赖、功能归属和导入资源边界检查 |

## 项目结构

```text
src/
  app/                     应用级跨功能生命周期协调
  components/              布局、导航和共享 UI
  features/
    connections/           连接表单、配置转换、仓储、连接状态
    editor/                查询控制器、查询视图、结果表格、事务、笔记本
    explorer/              对象树、表数据浏览、对象选择与元数据状态
    schema/                表设计、ER 图、结构比较
    transfer/              数据迁移与导入导出
    ai/                    AI 界面、客户端及状态
    docker/                Docker 管理
    plugins/               插件管理界面
    updates/               更新界面
  stores/                  全局 UI 偏好、页签和历史记录
  lib/                     传输、数据库 API、SQL 工具、日志和国际化
  types/                   共享契约
  styles/                  主题和布局样式
src-tauri/
  crates/crabhub-core/     无桌面依赖的独立 Rust 核心库
    src/db/               连接生命周期、驱动创建、查询与元数据服务
    src/connection_store/ 配置持久化、迁移与加密
    src/ai/               AI 执行、安全检查与上下文
    src/plugins/          插件发现、加载和协议
    src/ssh/              SSH 传输
  src/                    桌面命令、HTTP/RPC 适配与启动入口
packages/                 CLI、MCP、JDBC 桥和原生客户端安装
deploy/                   部署文件、构建准备和架构门禁
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
| YashanDB | 原生 | Rust yashandb + yascli | 1688 |
| OceanBase | 内置 | MySQL 兼容 (SQLx) | 3306 |
| TiDB | 内置 | MySQL 兼容 (SQLx) | 4000 |
| TDSQL | 内置 | MySQL 兼容 (SQLx) | 3306 |
| Oracle | 原生 | Rust oracle + Oracle Instant Client | 1521 |
| SQL Server | 内置 | tiberius TDS | 1433 |
| DaMeng | 原生 | tokio-dameng 协议适配（完整厂商验收未完成） | 5236 |
| GBase | 原生 | Rust odbc-api + GBase 8s ODBC（需安装客户端） | 5258 |
| Redis | 内置 | redis-rs 原生异步（查询编辑器直接写 Redis 命令） | 6379 |
| MongoDB | 内置 | mongodb 官方驱动（mongo-shell 语法：`db.coll.find({...})`，支持 `mongodb+srv://` URI） | 27017 |
| DuckDB/CSV/... | 插件 | Tabularis JSON-RPC 协议（仅桌面版） | 插件定义 |

## 架构

当前按模块化单体渐进收敛，保留 React、Zustand、Tauri 和 Rust：

- [src/lib/transport.ts](src/lib/transport.ts) 只负责桌面、Web、Mock 路由与认证头；旧数据库命令导出保持兼容。
- [src/features/connections/profile.ts](src/features/connections/profile.ts) 统一连接配置转换，[src/features/connections/repository.ts](src/features/connections/repository.ts) 封装持久化调用；运行状态更新不写配置，保存失败不更新本地列表。
- [src-tauri/crates/crabhub-core/src/connection_store/mod.rs](src-tauri/crates/crabhub-core/src/connection_store/mod.rs) 负责兼容迁移与凭据加密；不再新增前端安全存储副本。旧副本仅在没有配置密码时用于迁移兼容。
- [src-tauri/crates/crabhub-core/src/db/transactions.rs](src-tauri/crates/crabhub-core/src/db/transactions.rs) 负责事务会话、调用者隔离、资源限制与清理；桌面和 Web 使用同一请求协议。
- [src-tauri/crates/crabhub-core/src/db/metadata_cache.rs](src-tauri/crates/crabhub-core/src/db/metadata_cache.rs) 统一元数据缓存的 60 秒有效期及按连接失效规则。
- [src-tauri/crates/crabhub-core/src/db/manager.rs](src-tauri/crates/crabhub-core/src/db/manager.rs) 保留连接生命周期和兼容门面；[connector.rs](src-tauri/crates/crabhub-core/src/db/connector.rs) 管理驱动与 SSH 创建，[query_service.rs](src-tauri/crates/crabhub-core/src/db/query_service.rs) 管理查询和执行策略，[metadata_service.rs](src-tauri/crates/crabhub-core/src/db/metadata_service.rs) 管理目录、元数据和表数据访问。
- [src/features/editor/transaction-store.ts](src/features/editor/transaction-store.ts) 只保存后端返回的页签事务句柄；[useQueryEditor.tsx](src/features/editor/useQueryEditor.tsx) 管理编辑器状态和操作，[QueryEditor.tsx](src/features/editor/QueryEditor.tsx) 与 [ResultTable.tsx](src/features/editor/ResultTable.tsx) 分别负责查询界面和结果展示。
- [src/features/explorer/store.ts](src/features/explorer/store.ts) 拥有对象选择和元数据状态，全局 UI store 只保留主题、语言与界面偏好；[src/app/connection-lifecycle.ts](src/app/connection-lifecycle.ts) 协调断连后的事务和对象状态清理。
- RPC 失败使用标准 JSON-RPC `error`，成功数据格式保持兼容；运行时能力查询由连接管理器统一提供给桌面和 Web。
- Rust 默认启用 `desktop`，保持原桌面构建。`cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin crabhub-server` 只构建无桌面服务端，依赖图不含 Tauri、GTK 或 WebKit；Docker 和 CI 使用这条路径，仍需原生数据库客户端及 ODBC 等相应运行依赖。

核心已经物理拆为独立的 `crabhub-core` crate，不引用 Tauri；应用层保留桌面、HTTP 和 RPC 适配。前端按 connections、editor、explorer、schema、transfer、ai、docker、plugins、updates 分组。公共组件只放跨功能 UI，跨功能生命周期由应用层协调。CI 运行 `npm run architecture:check` 和 workspace Clippy，禁止将桌面依赖重新引入核心。

Rust 回归使用 `cargo test --manifest-path src-tauri/Cargo.toml --workspace --lib`。实库事务契约 `live_transaction_contract` 默认跳过；设置 `CRABHUB_TRANSACTION_TEST_CONFIG` 为隔离数据库的运行配置 JSON 后，通过 `cargo test --manifest-path src-tauri/Cargo.toml -p crabhub-core --lib live_transaction_contract -- --ignored` 单独运行。不要将真实凭据提交到仓库。PostgreSQL/MySQL 隔离实例已验证提交、回滚、错误清理、调用者隔离和断连释放。

2026-09-07 本机验证：Windows workspace 103 项回归通过，实库契约分别在 PostgreSQL/MySQL 通过；桌面与无桌面 Clippy、前端类型和生产构建通过。独立 Edge 验证登录、保存重载、查询结果、事务回滚、断连清理、语言切换、1280px/390px 操作和未登录拒绝。Linux Docker 构建受 Docker Hub CDN 与 Debian 软件源连接超时阻塞，未完成镜像运行验收；macOS/Linux 发布验证需在 CI 对应平台执行，不能以 Windows 编译结果替代。

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
