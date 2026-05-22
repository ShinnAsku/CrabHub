# GaussDB 驱动升级方案：接入 tokio-gaussdb v0.1.1

## 背景

CrabHub 当前 GaussDB 连接走三层回退：
```
Tier 1: gaussdb-rs (自研)    → SASL 认证未完成
Tier 2: sqlx PG 驱动         → GaussDB 自定义 SASL 不支持
Tier 3: tokio-opengauss 0.1  → 能连但慢（文本协议）
```

华为官方 `gaussdb-rust` 仓库已发布 **v0.1.1**（未推 crates.io，仅在 GitHub），包含两个关键修复：
1. **SASL 硬编码绕过** — 不再尝试解析 GaussDB 的 `[00,00,00,02,...]` SASL body 格式，直接使用 `SCRAM-SHA-256`
2. **GaussDB 兼容 SCRAM 解析器** — 容忍尾部垃圾字符

同时 tokio-gaussdb 原生支持 **Extended Query（二进制协议）**，性能对标 DBeaver JDBC。

## 改动范围

### 1. Cargo.toml（依赖变更）

```toml
# 新增：从 GitHub 拉 v0.1.1
tokio-gaussdb = { git = "https://github.com/HuaweiCloudDeveloper/gaussdb-rust" }
gaussdb-protocol = { git = "https://github.com/HuaweiCloudDeveloper/gaussdb-rust" }

# 删除
- tokio-opengauss = "0.1"        # 废弃的社区驱动
- gaussdb-rs = { path = "D:/code/crab-gaussdb" }  # 自研驱动（代码保留在磁盘）
```

### 2. gauss_rs.rs（重写适配器）

当前包装 `gaussdb_rs::Client`。改为包装 `tokio_gaussdb::Client`：

- **连接**：`tokio_gaussdb::Config::new().host().port().user().password().dbname().connect(NoTls)`
- **查询**：`client.query(sql, &[])` → Extended Query 二进制协议
- **执行**：`client.execute(sql, &[])` → Extended Query 二进制协议
- **元数据查询**：同上，直接用参数化 query

关键变化：从 Simple Query（文本）切换到 Extended Query（二进制）。

### 3. manager.rs（连接策略）

```
之前：
  GaussDB → gaussdb-rs → sqlx → tokio-opengauss

之后：
  GaussDB → tokio-gaussdb (v0.1.1) → sqlx (fallback)
```

删除 `tokio-opengauss` 回退层，`GaussDBConnection` 不再被引用。

### 4. mod.rs（模块注册）

移除 `pub mod gaussdb;`（tokio-opengauss 驱动，不再需要编译）。

文件保留在磁盘，`#[cfg(feature = "legacy")]` 或直接注释掉模块引用。

### 5. gaussdb.rs（旧驱动）

文件保留不删除，但不再被 `mod.rs` 引用（不参与编译）。

### 6. gaussdb-rs（自研驱动）

Cargo.toml 中移除 `gaussdb-rs = { path = ... }`。

`D:\code\gaussdb-rs` 整个目录保留在磁盘，作为参考代码。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/Cargo.toml` | 修改 | 加 tokio-gaussdb git dep，删 tokio-opengauss 和 gaussdb-rs |
| `src-tauri/src/db/gauss_rs.rs` | 重写 | 适配器改为包装 tokio_gaussdb Client |
| `src-tauri/src/db/manager.rs` | 修改 | GaussDB 连接改为 tokio-gaussdb → sqlx |
| `src-tauri/src/db/mod.rs` | 修改 | 注释掉 `pub mod gaussdb;` |
| `src-tauri/src/db/gaussdb.rs` | 保留不编译 | 旧的 tokio-opengauss 驱动 |
| `D:\code\gaussdb-rs/` | 保留 | 自研驱动，不参与编译 |

## 连接策略变更

```
之前（4 层）：
  Tier 1: gaussdb-rs (自研)       → SASL bug，未完成
  Tier 2: tokio-gaussdb v0.1.0    → SASL body 解析失败
  Tier 3: sqlx                     → SASL 不支持
  Tier 4: tokio-opengauss          → 能连但慢

之后（2 层）：
  Tier 1: tokio-gaussdb v0.1.1    → SASL 修复 + 二进制协议 ✅
  Tier 2: sqlx                     → 兜底
```

## 预期效果

| 指标 | 之前 | 之后 |
|------|------|------|
| SASL 认证 | ❌ 3 层回退才通过 | ✅ 一次通过 |
| 查询协议 | 文本（Simple Query） | **二进制（Extended Query）** |
| 查询速度 | 比 DBeaver 慢很多 | **对标 DBeaver JDBC** |
| 连接驱动数 | 4 个（gaussdb-rs + tokio-gaussdb + sqlx + tokio-opengauss） | 2 个（tokio-gaussdb + sqlx） |
| Cargo 依赖 | 3 个 GaussDB 相关 crate | 1 个（tokio-gaussdb） |

## 风险

1. **GitHub 依赖**：`git = "https://github.com/..."` 需要网络访问，CI/CD 环境需确认可连通
2. **v0.1.1 未发布 crates.io**：等华为推送后改成 `version = "0.1.1"` 即可
3. **SASL 硬编码**：tokio-gaussdb 的修复是硬编码 `SCRAM-SHA-256`，不是真正解析 GaussDB body——如果未来 GaussDB 换机制名，会再次失败
4. **Extended Query 兼容性**：GaussDB 的商业版可能不完全支持 Extended Query 的所有特性，需实测验证

## 验证步骤

1. `cargo check` — 编译通过
2. `npm run tauri dev` — 桌面应用启动
3. 连接 GaussDB — 日志显示 `GaussDB connected via tokio-gaussdb v0.1.1`
4. 执行查询 — 速度对比 DBeaver
5. Schema 加载 — 元数据查询速度
