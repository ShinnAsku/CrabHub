# CrabHub

轻量级、开源的通用数据库管理桌面工具，内置 AI 助手。兼容 Tabularis 插件生态。

## 功能

- **多数据库支持** — PostgreSQL、MySQL、SQLite、ClickHouse、GaussDB
- **插件系统** — 兼容 Tabularis 协议，9 个社区插件（DuckDB、Redis、CSV、Google Sheets 等）
- **AI 助手** — 支持 DeepSeek / Qwen / Ollama / OpenAI，自然语言生成 SQL、优化建议
- **SQL 编辑器** — 基于 Monaco Editor，语法高亮、自动补全、格式化
- **数据浏览与编辑** — 表格视图、行内编辑、导入导出（CSV/JSON/SQL）
- **ER 图** — 可视化表关系，ReactFlow 渲染
- **表设计器** — 字段、索引、外键、触发器，DDL 预览
- **结构对比** — Schema Diff，生成迁移 SQL
- **数据迁移** — 跨库表结构和数据迁移
- **SQL 笔记本** — 类 Jupyter，SQL + Markdown 混合
- **可视化查询构建器** — 拖拽式建表、JOIN、筛选
- **查询性能分析** — EXPLAIN 执行计划可视化
- **深色/浅色主题** — 中英双语，自适应窗口缩放
- **安全** — OS Keyring 凭证存储，AES-256-GCM 加密，TLS/SSH 隧道

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript 5.7 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 |
| 编辑器 | Monaco Editor |
| 流程图 | ReactFlow |
| 后端数据库驱动 | SQLx (PG/MySQL/SQLite), tokio-gaussdb, 自定义 ClickHouse |
| 插件通信 | JSON-RPC 2.0 over stdio |
| 构建 | Vite 6 |
| 测试 | Vitest |

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
| `npm run test:unit` | 前端单元测试 |
| `npm run test:all` | 全部检查（TS + Rust + 测试） |

## 项目结构

```
crabhub/
├── src/                          # React 前端
│   ├── components/               # UI 组件
│   │   ├── MainLayout.tsx        # 主布局（缩放、视图切换）
│   │   ├── Toolbar.tsx           # 工具栏（螃蟹 Logo + 窗口控制）
│   │   ├── Sidebar.tsx           # 侧边栏（连接树 + 查询历史）
│   │   ├── TabBar.tsx            # 标签栏
│   │   ├── EditorPanel.tsx       # SQL 编辑器 (Monaco)
│   │   ├── OpenDbMainPanel.tsx   # 数据库浏览器（Navicat 风格）
│   │   ├── AIPanel.tsx           # AI 助手浮动面板
│   │   ├── PluginManager.tsx     # 插件管理（Tabularis 风格）
│   │   ├── ConnectionDialog.tsx  # 新建/编辑连接
│   │   ├── TableDesigner.tsx     # 表设计器
│   │   ├── ERDiagram.tsx         # ER 图 (ReactFlow)
│   │   ├── SchemaDiffDialog.tsx  # 结构对比
│   │   ├── DataMigration.tsx     # 数据迁移
│   │   ├── ImportExportDialog.tsx# 导入导出
│   │   ├── QueryAnalyzer.tsx     # 查询性能分析
│   │   ├── notebook/             # SQL 笔记本
│   │   └── query-builder/        # 可视化查询构建器
│   ├── stores/                   # Zustand 状态管理
│   ├── lib/                      # 工具库 (i18n, DDL, 导出, 命令)
│   ├── types/                    # TypeScript 类型
│   └── styles/                   # CSS 主题变量
│
├── src-tauri/                    # Tauri Rust 后端
│   ├── src/
│   │   ├── db/                   # 数据库驱动层
│   │   │   ├── trait_def.rs      # DatabaseConnection trait
│   │   │   ├── manager.rs        # 连接管理器（心跳、重连）
│   │   │   ├── postgres.rs       # PostgreSQL 驱动
│   │   │   ├── mysql.rs          # MySQL 驱动
│   │   │   ├── sqlite.rs         # SQLite 驱动
│   │   │   ├── gaussdb.rs        # GaussDB 驱动 (tokio_gaussdb + tokio_opengauss)
│   │   │   ├── clickhouse.rs     # ClickHouse 驱动
│   │   │   └── types.rs          # 连接配置、查询结果类型
│   │   ├── connection_store/     # 连接持久化 (SQLite + AES-256-GCM 加密)
│   │   ├── plugins/              # 插件系统
│   │   │   ├── manager.rs        # 插件管理器（发现、加载）
│   │   │   ├── driver.rs         # PluginDriver（DatabaseConnection → JSON-RPC 桥）
│   │   │   ├── rpc.rs            # RpcClient（stdio JSON-RPC 2.0）
│   │   │   ├── installer.rs      # 插件安装器（下载 ZIP、解压）
│   │   │   ├── registry.rs       # 插件注册表（本地 + 远程）
│   │   │   └── commands.rs       # Tauri 命令
│   │   ├── ai/                   # AI 模块
│   │   ├── ssh/                  # SSH 隧道
│   │   └── rpc/                  # jsonrpsee RPC 服务器
│   ├── icons/                    # 螃蟹图标 (ico/icns/png/svg)
│   └── tauri.conf.json           # Tauri 配置
│
├── plugins/                      # 插件注册表
│   └── registry.json             # 9 个社区插件
├── test/                         # 测试
└── package.json
```

## 数据库驱动

| 驱动 | 类型 | 实现 |
|------|------|------|
| PostgreSQL | 内置 | SQLx |
| MySQL | 内置 | SQLx |
| SQLite | 内置 | SQLx + rusqlite |
| ClickHouse | 内置 | 自定义适配器 |
| GaussDB | 内置 | tokio-gaussdb + tokio-opengauss |
| DuckDB | 插件 | Tabularis 协议 |
| Redis | 插件 | Tabularis 协议 |
| CSV | 插件 | Tabularis 协议 |
| Google Sheets | 插件 | Tabularis 协议 |
| IBM Db2 | 插件 | Tabularis 协议 |
| Firestore | 插件 | Tabularis 协议 |
| HackerNews | 插件 | Tabularis 协议 |

## 插件系统

兼容 [Tabularis](https://github.com/TabularisDB/tabularis) 插件协议。插件通过 JSON-RPC 2.0 over stdio 与主进程通信，支持任意语言开发。

```bash
# 插件目录
Windows: %APPDATA%/com.crabhub.app/plugins/
macOS:   ~/Library/Application Support/com.crabhub.app/plugins/
Linux:   ~/.local/share/crabhub/plugins/
```

## License

MIT
