# 设计：首次登录保留运行环境标记 + 环境门增量安装

## 1. 边界与原则

- 改动集中在客户端本地配置层、环境门 Rust 模块与本地登录页：
  - `packages/desktop/src-tauri/src/config.rs`
  - `packages/desktop/src-tauri/src/main.rs`
  - `packages/desktop/src-tauri/src/runtime_commands.rs`
  - `packages/desktop/src-tauri/src/agent/env.rs`
  - `packages/desktop/src-tauri/src/agent/env/probe.rs`
  - `packages/desktop/src-tauri/src/agent/env/install.rs`
  - `packages/web/src/desktop/LoginApp.tsx`
  - 对应 `config/tests.rs`、`agent/env/tests.rs`、`packages/desktop/test/`
- 保持既有契约：`runtime_status` 是唯一的探测入口，Agent 侧只读 `client.json` flag；
  本次不新增探测入口。
- `client.json` schema 3 不变，仍使用 `schemaVersion` + 三个 snake_case `*_runtime` 键。
- 安装仍然只写客户端私有目录 `<data>/npm-global` 与 `<data>/runtime/node`；变化只在
  “是否需要下载/安装”，不改变落盘位置。

## 2. 根因 A：首次登录覆盖 flag

`config::load()` 是全量反序列化：`serverUrl` 必填。登录前 `runtime_status` 写出的文档
没有 `serverUrl`，因此解析失败被当成“没有配置”；`desktop_login` 随后的保存以 `None`
的 flag 覆盖文件，形成“探测成功 → 登录后丢失 → 初始化误报”的确定性链路。

### 修复

1. `ClientConfig`：
   - `server_url` 加 `#[serde(default)]`；
   - 新增 `python_runtime` 字段（snake_case，与其他 flag 一致）。
2. `desktop_login` 保存时带上 `previous_config.python_runtime`。
3. `app_status` / `initial_server_url` 把空 `serverUrl` 视为未配置。
4. **不给 `schema_version` 加 serde alias**：已安装环境可能同时存在 `schemaVersion`
   与遗留 `schema_version`，alias 会触发 serde 重复字段错误。

## 3. 根因 B：检测/安装体验误导

证据（详见 `prd.md` 的“运行环境检测排查”）：

- Python 实际被检测到；Node 在 PATH 与 `%ProgramFiles%\nodejs` 兜底内；
- 但 `env::install` 只检查私有 `runtime/node/node.exe`，缺失就整套下载，从不复用
  `resolve_node`；
- 登录页安装前写死 `steps.active = 'node:download'`；
- 全局 Trellis 在客户端私有 runtime 安装 8 分钟后才出现，不在当时搜索范围内；
- flag 版本过低时 Node/Trellis 不再探测其它候选；WindowsApps 0 字节别名可能被命中；
- 检查结果没有日志。

## 4. 方案

### 4.1 探测兜底（`probe.rs`）

- `fallback_dirs_in` 增加：
  - `%APPDATA%\npm`（Windows 默认 npm 全局前缀）；
  - `%LOCALAPPDATA%\pnpm`（pnpm 全局 bin）。
- 新增 Python 候选目录：
  - `%LOCALAPPDATA%\Programs\Python\Python*` 的每个子目录；
  - `%ProgramFiles%\Python*`；
  - `%SystemDrive%\Python*`（覆盖 `C:\Python314` 这类自定义安装）。
  仍保持顺序：flag → `TRELLIS_PYTHON` → PATH → 常见安装根目录 → `py -3`。
- `find_in_path` 对 0 字节文件视为不可用（跳过 WindowsApps App Execution Alias）。
  Node/Trellis 的真实可执行文件不会为 0 字节，跳过不影响现有行为。
- `resolve_node` 签名改为 `resolve_node(data_dir, config)`，候选顺序为
  flag → PATH/版本管理器/常见前缀 → `<data>/runtime/node/node.exe`。这样上次安装
  留下的私有 Node 即使 flag 丢失（例如首次登录覆盖 bug 或安装中断）也不会被重复下载。
  `env::check` 传递 `data_dir`。
- `resolve_node` / `resolve_trellis`：flag 指向的文件存在但版本低于下限时，记录
  `outdated` 并继续探测 PATH/兜底；全部不合格时再返回 `outdated`。与 Python 现有行为
  对齐，且不会清空有效 flag（探测成功会覆盖，失败才写回/返回旧状态）。
- `resolve_trellis` 的客户端私有前缀分支同样处理：`<data>/npm-global` 里的 CLI 版本
  过低时继续探测全局候选，而不是直接返回 outdated；解析成功时也要写回
  `trellis_runtime` flag。否则 flag 丢失（首次登录 bug）后，重启只能恢复 Node/Python，
  Trellis 仍为空，项目初始化继续报错。

### 4.2 增量安装（`env/install.rs` + `runtime_commands.rs`）

`env::install` 改为接收配置文档，先复用环境门结果，只对缺失项执行安装：

```rust
pub async fn install<C: ClientConfigLike>(
    data_dir: &Path,
    config: &mut C,
    on_progress: ...,
) -> AgentResult<RuntimeInstallResult>
```

流程：

1. `node = resolve_node(data_dir, config).await`、
   `trellis = resolve_trellis(data_dir, config).await`、
   `python = resolve_python(config).await`。
   复用 flag 命中（source=`client`）时保留原 flag 的 source，避免把 “downloaded”
   改写成 “client”；新探测/新安装的组件使用实际来源。
2. Node：
   - `node.ok` → 直接复用 `node.path` / `node.version` / `node.source`，**不发进度事件**
     （前端把 `node:validate` 映射到“下载 Node.js”，复用时会误导）；
   - 否则 → `install_node` 下载私有 Node，source = `downloaded`。
3. Trellis：
   - `trellis.ok` → 复用 `cli_path` / `version` / `source`，**不发进度事件**；
   - 否则 → 用第 2 步确定的 Node 执行 `install_trellis`（仍装到私有
     `<data>/npm-global`），source = `client-prefix`；安装后发 `trellis:validate`；
   - 若所选系统 Node 没有相邻 npm（`node_modules/npm/bin/npm-cli.js`）且 PATH 里也
     没有 `npm.cmd`，先下载私有 Node 再安装 Trellis，保证安装可完成。
4. Python：
   - `python.ok` → 复用 `path` / `version` / `source`，**不发进度事件**；
   - 否则 → `install_python`（内部发 `python:download`/`python:install`/
     `python:validate`），source = `installed`。
   - 最终 `ready` 事件的消息包含三个版本，未安装的组件不会出现下载/安装步骤。
5. 把最终三个 flag 通过 `ClientConfigLike::set_*_runtime` 写入 `config`；由
   `runtime_commands::runtime_install` 统一 `save_client_document`（同时写入
   `schemaVersion`）。
6. `write_runtime_flags` 失去唯一调用方，删除；其写 snake_case `schema_version` 的
   缺陷随实现一起消失。

`runtime_commands::runtime_install` 改为把同一个 `document` 传给 `env::install`，成功后
保存该文档，不再重新读取磁盘。

### 4.3 登录页（`LoginApp.tsx`）

- `needs_setup`：
  - 汇总 `node.ok` / `trellis.ok` / `python.ok` 的版本，状态文案改为
    “已检测到 Node.js x、Python y。Trellis CLI 缺失或版本过低，请先安装运行环境。”
  - 版本过低时展示 `foundVersion` 与后端返回的最低要求（`minVersion` /
    `requiredVersion`），避免只显示“缺失”。
  - `retryVisible` 设为 `true`，外部装好依赖后可直接“重新检查”。
- `installRuntime`：
  - 删除 `setSteps({ active: 'node:download' })`，初始为
    `{ active: null, done: ['node:check','trellis:check','python:check'] }`；
  - 实际阶段完全由 `runtime-progress` 事件驱动。
- 组件版本展示只使用现有 `RuntimeStatus` 字段，不新增命令/返回结构。

### 4.4 诊断日志（`logging.rs` + `runtime_commands.rs`）

- `logging` 增加 `info`。
- `runtime_status` 成功后写一条摘要：
  `运行环境检查 state=ready node=v24.13.0/path trellis=0.6.17/global python=3.14.3/path`；
  未就绪时写 `missing`/`foundVersion`。
- 只记录版本、source 和 ok，不记录绝对路径、用户名、密码或令牌。

## 5. 数据流（修复后）

```
runtime_status → env::check → probe 成功
  → document: {schemaVersion, node_runtime, trellis_runtime, python_runtime}
  → save_client_document（无 serverUrl）

login → desktop_login
  → config::load() = Some({server_url: "", flags...})   // default 生效
  → config::save({serverUrl, username, password, flags...})
  → 三个 flag 原样保留

runtime_install（只缺 Trellis 时）
  → resolve_node = ok (C:\Program Files\nodejs\node.exe)
  → resolve_trellis = missing
  → 不下载 Node；用已解析 Node 安装私有 Trellis
  → 保存文档：node 复用 + trellis 私有 + python 复用

initialize_pending_project → trellis_runtime() → 读到 node/trellis flag → 正常初始化
```

## 6. 兼容性与迁移

- 新客户端读取旧文件：缺少 `python_runtime` 时为 `None`；旧 flag 仍被识别。
- 旧客户端读取新文件：键名与 schema 版本未变。
- 已受影响用户：升级并重启客户端后，登录页重新执行 `runtime_status`，探测结果写回；
  自动登录使用已有 `serverUrl`，flag 不再被覆盖。无需手工改文件。
- 已有私有 runtime 的用户：`resolve_node` 优先读 flag，仍命中私有 Node，不会切换。
- schema 2 → 3 迁移路径不受影响。

## 7. 取舍

- 增量安装 vs 总是准备私有运行时：选择增量，避免“只缺 Trellis 却下载 90 MB Node”的
  误导和等待；代价是安装分支更多，且依赖系统 npm 时可执行性需要兜底（见 4.2.3）。
- 探测兜底只加“常见安装前缀”，不扫描整盘；不承诺覆盖仅在 shell profile 中注入 PATH
  的安装方式。
- 不在 Agent 侧自愈重探测：环境门仍是唯一探测入口。
- 日志写摘要而非完整路径，遵循脱敏约束并保留足够诊断信息。

## 8. 验证

- `config/tests.rs`：
  - 无 `serverUrl` 的运行时文档 `load()` 返回 `Some`，三个 flag 保留；
  - `load()` → `save()` 往返保留 `python_runtime`；
  - schema 2 迁移与 BOM 用例保持通过。
- `agent/env/tests.rs`：
  - `fallback_dirs_in` 含 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`；
  - Python 候选目录覆盖 `C:\Python314` 形式，0 字节 `python.exe` 被跳过；
  - 安装计划纯函数：全就绪不安装；只缺 Trellis 时不下载 Node；缺 Node 时下载。
- `packages/desktop/test/` 静态契约：
  - `config.rs` 的 `server_url` 带 `#[serde(default)]`，且存在 `python_runtime`；
  - `install.rs` 调用 `resolve_node` / `resolve_trellis` / `resolve_python`，不无条件
    `install_node`；
  - `LoginApp.tsx` 在 `needs_setup` 展示已检测版本、提供“重新检查”，且不预设
    `node:download`。
- 静态守卫：`rg -n '^mod tests \{' packages/desktop/src-tauri/src` 无输出；
  `git ls-files --eol | rg 'i/crlf'` 无输出。
- 本机无 Rust 工具链时记录未执行；由 CI `windows.yml` 的 cargo test 兜底。Node 静态
  测试可直接用系统 Node 运行。

## 9. 回滚

- 4.1（兜底）与 4.2（增量安装）可独立回滚；回滚安装策略时保留登录页提示与配置修复。
- 4.3（登录页）与 4.4（日志）独立。
- 配置层修复（第 2 节）必须与 `python_runtime` 字段成对; 只回滚 `server_url` 默认值
  会恢复“首次登录覆盖 flag”的旧行为，不建议。
