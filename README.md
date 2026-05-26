# CrabHub

轻量级、开源的通用数据库管理桌面工具，内置 AI 助手。兼容 Tabularis 插件生态。

## 功能

- **多数据库支持** — 15 种数据库：PostgreSQL、MySQL、SQLite、ClickHouse、GaussDB、Kingbase、Vastbase、YashanDB、OceanBase、TiDB、TDSQL、Oracle、SQL Server、DaMeng、GBase
- **插件系统** — 兼容 Tabularis 协议，社区插件（DuckDB、Redis、CSV 等），支持 JSON-RPC 2.0 over stdio
- **AI 助手** — 支持 DeepSeek / Qwen / Ollama / OpenAI，自然语言生成 SQL、执行计划分析、优化建议
- **SQL 编辑器** — 基于 Monaco Editor，语法高亮、自动补全、格式化、多语句执行
- **数据浏览与编辑** — Navicat 风格表格视图、行内编辑、分页、导入导出（CSV/JSON/SQL）
- **ER 图** — 可视化表关系和外键，自动布局
- **表设计器** — 字段、索引、外键、触发器设计，DDL 预览
- **结构对比** — Schema Diff，生成迁移 SQL
- **数据迁移** — 跨库表结构和数据迁移
- **SQL 笔记本** — 类 Jupyter，SQL + Markdown 混合
- **可视化查询构建器** — 拖拽式建表、JOIN、筛选
- **深色/浅色主题** — 中英双语，自适应窗口缩放
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
│   │   │   ├── manager.rs            # 连接管理器（心跳、重连、DDL）
│   │   │   ├── types.rs              # 连接配置、查询结果、错误类型
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
│   │   ├── rpc/                      # jsonrpsee RPC 服务器
│   │   └── testing/                  # 测试工具（mock 数据 + benchmark）
│   ├── icons/                        # 螃蟹图标 (ico/icns/png/svg, 40+ 平台)
│   └── tauri.conf.json               # Tauri 配置
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
| DuckDB/Redis/CSV/... | 插件 | Tabularis JSON-RPC 协议 | 插件定义 |

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
│                    │  └──────────────────────────────────────┘  │
└────────────────────┴────────────────────────────────────────────┘
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

## 安全设计

- **凭证存储**: OS Keyring (Windows Credential Manager / macOS Keychain / Linux Secret Service)
- **传输加密**: TLS 1.2+ (native-tls) / SSH 隧道 (ssh2)
- **SQL 注入防护**: SQL tokenizer + LIMIT 注入 + 多语句拦截
- **AI 安全门**: DDL/DML 操作需确认，多语句 SQL 直接拒绝，DROP/TRUNCATE 二次确认
- **插件安全**: ZIP 解压时 Zip Slip 路径穿越防护，可选 SHA-256 校验和验证

## License

MIT
