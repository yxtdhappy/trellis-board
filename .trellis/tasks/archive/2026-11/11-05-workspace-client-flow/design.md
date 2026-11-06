# 客户端 workspace 接入技术设计

## 1. 边界

- 初始化写操作仍由 `agent/workspace.js` 独占：路径校验、模板缓存/下载、合并/备份、developer 初始化、回滚都不在 CLI、Rust 或 UI 中重写。
- 客户端只负责“拿到 path + username + teamId + 凭证”并调用初始化模块。
- 桌面端初始化在 sidecar 进程执行；Rust 只做目录选择和转发；UI 只做 invoke 与展示。
- 远程 Board 页面不进入 capability，仍无 IPC。

## 2. 身份与团队来源

`server/team/agents.js` 的 `enroll()` 响应增加：

```js
{ agentId, credential, protocolVersion, username, teamId }
```

- `username` 来自配对码所属 `user_account.username`（与登录账号一致）。
- `teamId` 来自 `agent_pairing_code.team_id`。
- `agent/protocol.js` 的 `parseEnrollResponse()` 透传两个可选字段；`agent/cli.js` 和 `desktop/sidecar/desktop-device.js` 写入本地 config。
- `agent/config-store.js` 的 `validateConfig()` 接受并保留可选 `username` / `teamId`。
- 旧配置缺少字段时，CLI 可用 `--username` / `--team`；sidecar 返回明确配置错误，提示重新注册。

## 3. CLI

`agent/cli.js`：

| 命令 | 参数 | 行为 |
| --- | --- | --- |
| `workspace init` | `--path` 必填；`--tools` 逗号分隔；`--username`；`--team`；全局 `--json` | 解析 config、credential，调用 `initializeWorkspace()` |
| `workspace status` | `--path` 必填；`--json` | 只读检查 `.trellis`、`.developer`、`.template-hashes.json`、`.opencode`、`.agents` |

- 注入点：`runCli(argv, { workspaceInitializer })`，测试用 fake 校验参数/退出码；默认是 `initializeWorkspace`。
- 用户名优先级：`--username` → `config.username` → `<path>/.trellis/.developer` 的 `name=`。
- 模板下载使用 `config.serverUrl`、`config.teamId`（或 `--team`）与 DPAPI 凭证。
- 结果摘要字段：`workspace`（基名）、`developer`、`templateVersion`、`templateSha256`、`source`、`tools`、`created/updated/skipped`、`backupDir`、`changed`。
- 退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 参数/配置缺失 |
| 9 | `DEVELOPER_CONFLICT` |
| 10 | `WORKSPACE_PATH_INVALID` / `WORKSPACE_PATH_UNWRITABLE` / `WORKSPACE_USERNAME_INVALID` |
| 11 | `TEMPLATE_UNAVAILABLE`（离线且无缓存） |
| 12 | 模板认证/完整性/结构错误与 developer 初始化失败 |

## 4. sidecar

新增 `desktop/sidecar/workspace-init.js`：

```js
export async function runWorkspaceInit({
  workspacePath, tools, username, teamId, serverUrl, dataRoot,
  agentCredential, fetchImpl, initialize = initializeWorkspace, logger
})
```

- 仅调用 `initializeWorkspace()`；透传 `teamId`、`serverUrl`、`agentCredential`、`dataRoot`、`tools`、`username`。
- `main.js` 新增 `workspace-init --path <dir> [--tools a,b] [--username] [--team] [--server]`：
  - 读取 `config.json`，用 DPAPI 凭证（与 `run`/`enroll` 同一 `prepareAgent()`）。
  - 输出单行 JSON：成功 `{ok:true, ...result}`；失败 `{ok:false, error, code}`。
- 失败由 `agent/workspace.js` 回滚，不留下半成品。
- sidecar 退出码沿用 CLI 分类（9/10/11/12），便于诊断；Rust 只读取 JSON。

## 5. Tauri

`desktop/src-tauri/`：

- `Cargo.toml` 增加 `tauri-plugin-dialog = "2"`。
- `main.rs`：
  - `.plugin(tauri_plugin_dialog::init())`
  - `pick_workspace(window)`：`ensure_local_caller` → `app.dialog().file().blocking_pick_folder()` → 返回路径或 null。
  - `init_workspace(app, window, path, tools)`：`ensure_local_caller` → `sidecar::workspace_init()` spawn `workspace-init` → 解析最后一行 JSON；`ok:false` 返回错误文本。
  - `generate_handler![app_status, enroll_device, pick_workspace, init_workspace]`
- `sidecar.rs` 增加 `workspace_init()`：命令参数数组，不经 shell；stdout JSON 原样返回。
- `permissions/desktop.toml` 增加 `allow-pick-workspace`、`allow-init-workspace`。
- `capabilities/main.json`：`core:default` + 四个自定义命令权限 + `dialog:allow-open`；不声明 `remote`，不加 `shell:*`、`fs:*`、`http:*`、`process:*`。

## 6. UI

`desktop/ui/index.html` + `setup.js`：

- 新增 `#workspace-panel`：路径输入 `#workspace-path`、`#pick-workspace`、`#init-workspace`、`#workspace-result`、`#workspace-error`、`#open-board`。
- 已注册或注册成功后显示该面板，不立即跳转；用户初始化后点“打开看板”进入 Board。
- `#pick-workspace` → `invoke("pick_workspace")`；`#init-workspace` → `invoke("init_workspace", { path, tools })`。
- UI 不导入 `agent/workspace.js`、不启动子进程、不写文件。

## 7. 测试

`tests/workspace-client-flow.test.js`：

- CLI fake initializer：参数解析、tools 拆分、JSON 摘要、用户名从 `.developer` 回退、退出码 9/10/11。
- `workspace status`：真实临时目录，读 developer/version/tool 状态。
- sidecar `runWorkspaceInit`：临时 workspace + 临时 dataRoot，预置 `server/templates/workspace/workspace-template.zip` 到内容寻址缓存，`fetchImpl` 抛错模拟离线；断言 source=cache、developer、`.opencode`/`.agents` 非空、结果计数。
- 静态断言：CLI 命令注册、UI invoke、Rust 命令/插件、Cargo 依赖、capability 权限、无 remote、无 `shell:allow-open`。
- 更新 `tests/desktop-package.test.js` 以接受最小 dialog 权限并检查新命令注册。

## 8. 风险

- Windows 目录选择与 sidecar spawn 无法在当前 Linux 环境实机验证，只通过静态断言与 Rust 编译前审查。
- 旧设备未保存 `username`/`teamId`，需要重新注册；CLI 可通过参数绕过，桌面端会提示重新注册。
- 模板仍按团队缓存；teamId 只信任注册响应，不从路径或页面输入推断。
