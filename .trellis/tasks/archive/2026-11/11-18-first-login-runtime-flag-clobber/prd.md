# 修复首次登录覆盖运行环境标记导致误报 Node 未就绪

## Goal

客户端首次登录后，`client.json` 必须保留环境门（`runtime_status`）探测写入的
`node_runtime` / `trellis_runtime` / `python_runtime`；之后点击“初始化缺失的 Trellis 与
Agent 工具”时不能再误报“Node.js 运行环境未就绪”。

## Background

现场证据（2026-11-18，本机 `%LOCALAPPDATA%\TrellisBoard\data\client.json`）：

- `node_runtime: null`、`trellis_runtime: null`，但 `C:\Program Files\nodejs\node.exe`
  存在且 `node -v` 为 `v24.13.0`。
- 同一份配置里 `serverUrl` / `username` / `password` 已写入，说明文件是 `desktop_login`
  的 `config::save` 产物；文件缺少 `python_runtime`，与 `ClientConfig` 的字段集合一致。

已确认的代码链路：

1. 冷启动登录页执行 `runtime_status`（`packages/desktop/src-tauri/src/runtime_commands.rs:35`），
   `env::check` 探测成功后把运行时标记写入原始 JSON 文档：
   - Node：`packages/desktop/src-tauri/src/agent/env/probe.rs:252`
   - Trellis：`packages/desktop/src-tauri/src/agent/env/probe.rs:317`
   - Python：`packages/desktop/src-tauri/src/agent/env/probe.rs:451`
   登录前该文档没有 `serverUrl`（`runtime_commands.rs:19` 的默认文档只有 `schemaVersion`）。
2. 登录成功后 `desktop_login` 调用 `config::load()` 复用旧配置
   （`packages/desktop/src-tauri/src/main.rs:415`）。`ClientConfig::server_url` 是必填
   `String` 且没有 `#[serde(default)]`（`packages/desktop/src-tauri/src/config.rs:12`），
   缺少 `serverUrl` 时整份文档解析失败，`load()` 返回 `None`（`config.rs:61`）。
3. 于是 `config::save` 用 `node_runtime: None, trellis_runtime: None` 写回
   （`main.rs:416-427`），覆盖第 1 步的探测结果；`ClientConfig` 未定义 `python_runtime`
   字段（`config.rs:10-21`），该标记也被一并丢弃。
4. 初始化项目时 `trellis_runtime()` 只读 `client.json` 标记
   （`packages/desktop/src-tauri/src/agent_service.rs:727-754`），读到 `None` 即返回
   `CONFIG_MISSING`“Node.js 运行环境未就绪，请先在登录页完成环境检查”。

附带缺陷：

- `write_runtime_flags` 写入 snake_case 的 `schema_version`
  （`packages/desktop/src-tauri/src/agent/env/install.rs:593`），与 schema 3 的
  `schemaVersion` 键名不一致；安装后依赖 `runtime_commands.rs:60` 再补写 camelCase 键。
  本次改为由 `runtime_commands` 统一保存文档，该函数随之删除。

## 运行环境检测排查（并入本任务）

用户反馈首次安装客户端时“本机已有 Python / Node / Trellis，但客户端似乎没有检测到”。
本机证据与代码对照结论：

### 已确认事实

1. **Python 实际被检测到了。** 客户端首次安装（2026-11-16 22:11）只下载了私有 Node
   和私有 Trellis；本机不存在 `%LOCALAPPDATA%\Programs\Python\Python312`、`C:\Python312`
   等安装器产物。若 `install_python` 执行过一定会有这些目录，因此 Python 校验通过、
   未被安装。当前 `C:\Python314\python.exe`（3.14.3）与 `py -3` 均可用。
2. **Node 很可能也被检测到了，但安装流程仍然下载了私有 Node。**
   `%ProgramFiles%\nodejs` 在机器 PATH 中，同时是 `probe.rs:29-55` 的兜底目录，
   `resolve_node` 能返回系统 Node（24.13.0）。但 `env::install`
   （`packages/desktop/src-tauri/src/agent/env/install.rs:6-21`）只检查
   `<data>/runtime/node/node.exe`，不存在就下载整套私有 Node，从不复用
   `resolve_node` 的结果。首次安装时恰好只缺 Trellis，却仍然出现了“下载 Node.js”，
   这是“客户端没检测到 Node”的最直接来源。
3. **Trellis 当时确实不在客户端的搜索范围内。** 全局
   `%APPDATA%\npm\node_modules\@mindfoldhq` 创建于 2026-11-16 22:19，比客户端私有
   runtime（22:11）晚 8 分钟；客户端只搜索 PATH 前缀、客户端私有前缀和
   fnm/nvm/Volta/`%ProgramFiles%\nodejs` 兜底，不搜索“尚未加入 PATH 的全局 npm 前缀”。
   用户随后（或同时）执行了全局安装，视觉上像是“重装后才被识别”。
4. **安装进度一开始就显示“下载 Node.js”。** `LoginApp.installRuntime`
   在调用 `runtime_install` 前写死 `setSteps({ active: 'node:download' })`
   （`packages/web/src/desktop/LoginApp.tsx:197`），即使 Node 已就绪，界面也会先高亮
   下载步骤，进一步强化“没检测到 Node”的错觉。
5. **首次检查没有可诊断日志。** `logs/` 目录为空；`runtime_status` 不记录任何探测结果，
   无法事后确认当时每个组件是 ok、版本过低还是未找到。
6. **探测存在两个可见盲区：**
   - `resolve_node` / `resolve_trellis` 在 flag 指向的文件存在但版本过低时**直接返回
     失败**，不再尝试 PATH/全局前缀里的其它候选（`probe.rs:200-215`、`probe.rs:286-298`）；
     Python 则会继续探测（`probe.rs:401-467`）。
   - Windows 10/11 的 `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`、`py.exe`
     是 0 字节 App Execution Alias。`find_in_path` 可能先命中它；当前没有跳过 0 字节
     文件的规则，`py -3` 也依赖 PATH 解析。
7. **Trellis/Python 的兜底目录不完整。** `fallback_dirs_in` 只覆盖 fnm/nvm/Volta/
   `%ProgramFiles%\nodejs`（`probe.rs:29-55`），不覆盖 Windows 默认 npm 全局前缀
   `%APPDATA%\npm`、pnpm 前缀，也不覆盖常见 Python 安装根目录。

### 已确认的优化方向

- 安装流程改为**增量安装**（用户已确认）：先复用环境门已解析的 Node / Trellis /
  Python，只安装真正缺失的组件；Node 可用时不下载私有 Node，Trellis 缺失时优先用
  已解析的 Node 执行 `npm install -g --prefix <data>/npm-global`。
- 登录页未就绪时展示**已检测到的组件及版本**（例如“已检测到 Node.js 24.13.0、
  Python 3.14.3”），并为 `needs_setup` 增加“重新检查”按钮，避免外部装完依赖后必须重启。
- 安装进度不再预设 `node:download`，由 `runtime-progress` 事件驱动实际步骤。
- 补齐探测兜底：`%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、常见 Python 安装根目录；
  跳过 0 字节可执行文件；flag 版本过低时继续探测其它候选。
- `runtime_status` 写一条不含敏感信息的检查摘要日志，便于下次定位。

## Requirements

- R1：`config::load()` 必须能解析“只有运行时标记、还没有 `serverUrl`”的登录前配置，
  且返回的运行时标记与文件一致。
- R2：登录保存不得丢失 `node_runtime` / `trellis_runtime` / `python_runtime`；退出登录
  清除密码时同样不得丢失。
- R3：安装流程不得再自行写入 snake_case 的 `schema_version`；运行时 flag 与
  `schemaVersion` 统一由 `runtime_commands` 保存到 `client.json`。
- R4：新增回归测试覆盖 R1–R3，现有 schema 2 → 3 迁移与配置读写测试保持通过。
- R5：保持 `flag → PATH → 兜底目录 → py -3` 的优先级顺序不变（只增加候选、允许旧
  flag 继续向后探测）；不改变 Agent “只认 flag”的契约，也不在项目初始化时重新探测 Node。
- R6：`runtime_install` 改为增量安装：Node / Trellis / Python 已通过环境门校验时直接
  复用，不下载私有 Node；只对缺失组件执行下载或安装。
- R7：登录页 `needs_setup` 状态展示已检测到的组件及版本，并提供“重新检查”按钮。
- R8：安装进度不再预设 `node:download` 为活动步骤，只按 `runtime-progress` 事件展示
  实际执行的阶段。
- R9：环境门兜底目录补齐 `%APPDATA%\npm`、pnpm 前缀和常见 Python 安装根目录；跳过
  0 字节可执行文件；flag 指向的 Node/Trellis 版本过低时继续探测其它候选；客户端私有
  前缀解析成功时写回 `trellis_runtime`，保证 flag 丢失后可自愈。
- R10：`runtime_status` 记录一条不含路径/凭据的检查摘要，至少包含每个组件的
  ok、版本、来源（source）；缺失或版本过低时写明 foundVersion。

## Acceptance Criteria

- [ ] AC1：对只含 `schemaVersion: 3` 与三个运行时 flag、没有 `serverUrl` 的
  `client.json`，`config::load()` 返回 `Some`，三个 flag 与文件一致，`server_url` 为空串。
- [ ] AC2：上述配置经 `load()` → `save()` 后重新读取，三个 flag 仍完整保留。
- [ ] AC3：`desktop_login` 保存路径把 `python_runtime` 一并持久化（代码审查 + 配置单测）。
- [ ] AC4：安装完成后 `client.json` 只含规范键 `schemaVersion`，不再出现
  `schema_version`；flag 由 `runtime_commands` 一次性保存。
- [ ] AC5：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿；
  无 Rust 工具链的环境下必须记录未执行原因并交由 CI `windows.yml` 验证。
- [ ] AC6：升级后已受影响用户重启客户端即恢复：登录页重新执行 `runtime_status`
  写回 flag，自动登录不再覆盖。
- [ ] AC7：在私有 Node 不存在、系统 Node/Trellis/Python 均通过校验的环境下调用
  `runtime_install`，不发起 `node:download`，不创建 `<data>/runtime/node`，只对缺失
  组件执行安装。
- [ ] AC8：`needs_setup` 登录页显示已检测到的组件版本，并可通过“重新检查”在外部安装
  依赖后刷新状态，无需重启客户端。
- [ ] AC9：`needs_setup` 下点击安装时，进度初始不把“下载 Node.js”标为活动步骤；
  实际未下载 Node 时该步骤不会出现。
- [ ] AC10：探测兜底覆盖 `%APPDATA%\npm`、pnpm 前缀、常见 Python 根目录；0 字节
  `python.exe` 不会被当作有效解释器；flag 版本过低时会继续探测并采用更优候选；
  客户端私有 Trellis 前缀解析成功时写回 `trellis_runtime`。
- [ ] AC11：`runtime_status` 的摘要日志出现在 `<data>/logs/desktop.log`，且不含
  绝对路径、密码或令牌。

## Out of Scope

- 不在 `trellis_runtime()` / 项目初始化路径中重新探测 Node（保持“Agent 只认 flag”）。
- 不修改版本下限（Node ≥ 18.17.0、Trellis ≥ 0.6.17、Python ≥ 3.9.0）和下载源。
- 不修改服务端；Board 前端只改本地登录/环境门页面。
- 不发布新版本；版本号与发布流程由用户另行决定。
- 不尝试兼容“只在 PowerShell profile 中注入 PATH”的安装；客户端仍以进程 PATH +
  常见安装前缀为准。

## Technical Notes

- `client.json` schema 3 的字段命名是混合的：`schemaVersion` / `serverUrl` 为 camelCase，
  三个 `*_runtime` 为 snake_case；本次修复只统一 schema 版本键，不动其它命名。
- `config::load()` 放宽 `serverUrl` 后，`app_status` 与 `initial_server_url` 需要把空串
  视为“未配置”，避免登录页把空串当成有效服务器地址。
- 现有安装环境可能同时存在 `schemaVersion` 与遗留 `schema_version` 两个键；不要给
  `schema_version` 加 serde alias，否则重复字段会让 `load()` 直接失败。

## Open Questions

无。安装策略已确定为增量安装（只安装缺失组件、复用环境门已解析的运行时）。
