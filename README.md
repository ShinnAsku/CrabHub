# OpenDB

一款轻量级、开源的通用数据库管理工具，内置 AI 助手。

## 特性

- 🪶 **轻量高效** — 基于 Tauri v2，安装包 < 15MB
- 🎯 **极简 UI** — 极简设计风格，告别"驾驶舱"式复杂界面
- 🤖 **AI 驱动** — 内置 AI 助手，支持自然语言建表、查询、SQL 解释
- 🗄️ **多数据库** — 支持 PostgreSQL、MySQL、SQLite、MSSQL、GaussDB、ClickHouse
- 🔒 **安全可靠** — OS Keyring 存储凭证，TLS 加密连接
- 🌙 **深色主题** — 默认深色主题，支持亮色/深色切换
- 📦 **离线安装** — 支持完全离线安装和运行

## 技术栈

- **桌面框架**: Tauri v2 (Rust)
- **前端**: React 19 + TypeScript
- **样式**: Tailwind CSS 4
- **状态管理**: Zustand
- **构建工具**: Vite

## 开发

```bash
# 安装依赖
pnpm install

# 前端开发 (仅前端)
pnpm dev

# Tauri 桌面开发 (前端 + Rust)
pnpm tauri dev

# 构建
pnpm tauri build
```

## 项目结构

```
opendb/
├── src/                    # React 前端
│   ├── components/         # UI 组件
│   │   ├── MainLayout.tsx  # 主布局
│   │   ├── Toolbar.tsx     # 顶部工具栏
│   │   ├── Sidebar.tsx     # 侧边栏
│   │   ├── TabBar.tsx      # 标签栏
│   │   ├── EditorPanel.tsx # 编辑器面板
│   │   └── AIPanel.tsx     # AI 助手面板
│   ├── stores/             # Zustand 状态管理
│   └── styles/             # CSS 变量和主题
├── src-tauri/              # Tauri Rust 后端
│   ├── src/                # Rust 源码
│   ├── capabilities/       # 权限配置
│   └── tauri.conf.json     # Tauri 配置
└── package.json
```

## License

MIT
