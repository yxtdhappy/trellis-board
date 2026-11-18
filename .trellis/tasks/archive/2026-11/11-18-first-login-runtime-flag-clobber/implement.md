# 实施计划：首次登录保留运行环境标记 + 环境门增量安装

## Step 1：配置层修复

文件：`packages/desktop/src-tauri/src/config.rs`

- `server_url` 加 `#[serde(default)]`。
- 新增 `python_runtime` 字段（`rename = "python_runtime"`，`alias = "pythonRuntime"`，
  `default`），类型 `Option<serde_json::Value>`。
- 不添加 `schema_version` 的 serde alias。

测试：`config/tests.rs`

- 构造点补 `python_runtime: None`；
- `load_keeps_runtime_flags_without_server_url`：无 `serverUrl`、带三个 flag 的文档
  `load()` 返回 `Some`，flag 一致，`server_url` 为空串；`save()` 后重新 `load()` flag 仍在；
- `save_keeps_python_runtime`：`save`→`load` 后 Python flag 一致；
- 现有 schema 2/BOM 用例保持通过。

## Step 2：登录保存与空 serverUrl

文件：`packages/desktop/src-tauri/src/main.rs`

- `desktop_login` 的 `ClientConfig` 构造增加 `python_runtime`。
- `app_status` 的 `server_url` 加 `.filter(|value| !value.trim().is_empty())`。
- `initial_server_url` 对 `config::load()` 的 `server_url` 同样过滤空串。

## Step 3：探测兜底与盲区修复

文件：`packages/desktop/src-tauri/src/agent/env/probe.rs`

- `fallback_dirs_in` 增加 `app_data.join("npm")`、`local_app_data.join("pnpm")`。
- 新增 Python 候选目录函数：
  - `%LOCALAPPDATA%\Programs\Python\Python*`；
  - `%ProgramFiles%\Python*`；
  - `%SystemDrive%\Python*`。
  在 `resolve_python` 中按“flag → `TRELLIS_PYTHON` → PATH → 常见根目录 → `py -3`”顺序使用。
- `find_in_path` 跳过 0 字节文件（WindowsApps 别名）。
- `resolve_node` 改为 `resolve_node(data_dir, config)`，在 PATH/兜底之后追加
  `<data>/runtime/node/node.exe` 作为最后一个候选；`env::check` 传 `data_dir`。
- `resolve_node` / `resolve_trellis`：flag 文件存在但版本低于下限时，记录 `outdated`
  并继续循环探测；全部失败时返回 `outdated`，不再提前 return。
- `resolve_trellis` 的客户端私有前缀（`<data>/npm-global`）版本过低时同样继续探测
  全局候选，最后才回退到 outdated 状态；解析成功时写回 `trellis_runtime` flag，
  保证 flag 丢失后重启即可自愈。

测试：`agent/env/tests.rs`

- `fallback_dirs_in` 断言包含 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`；
- `finds_python_in_common_install_roots`（纯目录枚举，不执行进程）；
- 更新 `finds_executables_on_provided_path`：把测试文件写成非空内容；新增断言
  0 字节 `node.exe` 不被命中；
- 如可行，补 `resolve_*` 的纯决策测试；需要执行真实进程的用例不进单测。

## Step 4：增量安装

文件：`packages/desktop/src-tauri/src/agent/env/install.rs`

- `install` 签名改为 `install<C: ClientConfigLike>(data_dir, config, on_progress)`。
- 开头调用 `resolve_node` / `resolve_trellis` / `resolve_python`，得到当前状态。
- Node：`ok` 则复用（不发进度事件），否则 `install_node`。
- Trellis：`ok` 则复用（不发进度事件）；否则用已确定 Node 执行 `install_trellis`。
  若该 Node 无相邻 npm 且 PATH 无 `npm.cmd`，先 `install_node` 再用私有 Node 安装。
  安装完成后发 `trellis:validate`。
- Python：`ok` 则复用（不发进度事件），否则 `install_python`。
- 复用时不发 `node:validate` / `trellis:validate` / `python:validate`，避免前端把
  validate 映射成“下载/安装”步骤；最终 `ready` 消息包含三个版本。
- 最终三个 flag 通过 `config.set_node_runtime/set_trellis_runtime/set_python_runtime`
  写入文档。
- 删除 `write_runtime_flags`（无调用方），连同其 snake_case `schema_version` 写入。
- 抽纯函数 `install_plan(&NodeStatus, &TrellisStatus, &PythonStatus) -> InstallPlan`
  用于分支决策。

文件：`packages/desktop/src-tauri/src/runtime_commands.rs`

- `runtime_install` 加载 `document` 后传给 `env::install`，成功后设置
  `document["schemaVersion"]` 并保存同一个 `document`，不再二次读盘。

测试：`agent/env/tests.rs`

- `install_plan`：全就绪时三个安装位都为 false；只缺 Trellis 时只安装 Trellis；
  缺 Node 时 download_node=true；
- 删除/替换原 `write_runtime_flags` 相关测试。

## Step 5：诊断日志

文件：`packages/desktop/src-tauri/src/logging.rs`

- 增加 `pub fn info(message: &str)`，复用现有 `write("info", ...)`。

文件：`packages/desktop/src-tauri/src/runtime_commands.rs`

- `runtime_status` 返回前写摘要：
  - ready：`运行环境检查 state=ready node=<version>/<source> trellis=<version>/<source> python=<version>/<source>`
  - 未就绪：对每个组件写 `missing` 或 `found=<foundVersion>`。
- 不写路径、用户名、密码、令牌。

## Step 6：登录页提示与进度

文件：`packages/web/src/desktop/LoginApp.tsx`

- `needs_setup`：
  - 组装已检测组件版本（Node/Trellis/Python 的 `ok` + `version`），文案改为
    “已检测到 …。Trellis CLI 缺失或版本过低，请先安装运行环境。”；
  - `setRetryVisible(true)`。
- `installRuntime`：删除写死的 `setSteps({ active: 'node:download' })`，改为
  `{ active: null, done: ['node:check','trellis:check','python:check'] }`。

## Step 7：静态契约测试

文件：`packages/desktop/test/desktop-runtime-gate.test.js`（新增）

- `config.rs` 含 `server_url` 的 `#[serde(default)]` 与 `python_runtime` 字段；
- `main.rs` 登录保存包含 `python_runtime`；
- `install.rs` 调用 `resolve_node` / `resolve_trellis` / `resolve_python`，且
  `resolve_*` 位于 `install_node` 之前；
- `LoginApp.tsx` 的 `needs_setup` 含“重新检查”和已检测版本展示，`installRuntime`
  不再出现 `active: 'node:download'`；
- `runtime_commands.rs` 调用 `logging::info`。

## Step 8：验证

```bash
# Node 静态测试（无需 node_modules）
node --test packages/desktop/test/*.test.js packages/web/test/*.test.js

# 仓库守卫
rg -n '^mod tests \{' packages/desktop/src-tauri/src
git ls-files --eol | rg 'i/crlf'

# 有 Rust 工具链时
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

- 本机当前未找到 `cargo`，Rust 用例预计由 CI `windows.yml` 执行；任务记录中必须如实
  注明未本地执行。
- `LoginApp.tsx` 的 TypeScript 编译需要 `yarn install` 后的 `node_modules`；本机未安装
  依赖时只能做静态检查，需在记录中注明。

## Step 9：Spec 更新（Phase 3.3）

文件：`.trellis/spec/backend/desktop-agent-runtime.md`

- 环境门一节改为“增量安装”：先复用 `resolve_*` 结果，只安装缺失组件；不再描述为
  总是下载私有 Node。
- 补充探测兜底：`%APPDATA%\npm`、pnpm 前缀、常见 Python 根目录、0 字节别名跳过、
  outdated flag 继续探测。
- 补充登录页 `needs_setup` 展示已检测版本与“重新检查”。

## 审查要点

- `ClientConfig` 的所有构造点都补了 `python_runtime`。
- `env::install` 不再直接写 `client.json`；只有 `runtime_commands` 负责持久化。
- 增量安装失败时不保存文档，保持原有配置不变。
- 没有新增 `schema_version` alias。
- `probe.rs` / `install.rs` 行数仍低于 1200；测试布局保持 `env/tests.rs`。

## 验证记录（2026-11-18）

- `node --test packages/desktop/test/desktop-runtime-gate.test.js`：5/5 通过。
- `node --test packages/web/test/*.test.js`：86 通过、1 失败；失败原因是本机未安装
  `node_modules`（`highlight.js` 缺失），与本次改动无关。
- `node --test packages/desktop/test/desktop-ui-build.test.js`：失败于
  `packages/desktop/ui/index.html` 不存在（未执行 `yarn build:desktop`，本机无
  `node_modules`），同样与本次改动无关。
- `rg -n '^mod tests \{' packages/desktop/src-tauri/src`：无输出。
- `git diff --check`：通过（无空白错误；新增/修改文件均为 LF）。
- JetBrains IDE 静态检查（errors only）：改动文件无错误/警告（仅 LoginApp 既有的
  HTTP 示例链接弱警告）。
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：**未执行**，
  本机 `where cargo` 无结果；由 CI `windows.yml` 的 `desktop-build`/cargo test 验证。
- TypeScript 编译未执行（缺 `node_modules`）；`LoginApp.tsx` 仅改状态文案和初始步骤。

## 回滚点

- Step 1 + Step 2 必须成对。
- Step 3 与 Step 4 可独立回滚；回滚 Step 4 时恢复 `write_runtime_flags` 与旧的
  私有 Node 安装流程。
- Step 6 可单独回滚，不影响后端修复。
