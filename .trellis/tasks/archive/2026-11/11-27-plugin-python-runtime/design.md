# 技术设计：Python 解释器解析、宿主注入与失败回环境门

## 1. 边界与改动面

| 层 | 文件 | 改动 |
| --- | --- | --- |
| server 解析器 | `packages/server/python.js` | 扩展为候选解析 + 执行 + 结构化错误；保留 `pythonCommandCandidates` 兼容导出 |
| server 任务创建 | `packages/server/actions.js:118` | `runTaskPython` 改为调用解析器；`createTask` 接受可注入 `env` |
| team 子进程 | `packages/server/team/process.js:174` | 删除按名字猜测的回退逻辑，`runProcess` 保持通用 |
| team 工具链 | `packages/server/team/toolchain.js:91` | 先解析解释器，再执行 `-I -B -c` |
| Rust 环境门 | `packages/desktop/src-tauri/src/agent/env/probe.rs:734` | flag 不可执行时清空并重新探测 |
| Rust 任务执行 | `packages/desktop/src-tauri/src/agent/task_command.rs:931` | `recorded_python()` 增加大小校验 |
| Rust 插件宿主 | `packages/desktop/src-tauri/src/plugin_host.rs:199` | 拉起宿主时注入 `TRELLIS_PYTHON` |
| Rust 命令 | `packages/desktop/src-tauri/src/main.rs:311`、`capabilities/*.json` | 新增 `runtime_open_gate` 与权限 |
| 插件 | `plugins/witops-core/dispatch.js`（独立仓库） | 下发失败结果透传 `code` |
| Web | `packages/web/src/features/plugins/PluginPanel.tsx:141` | 识别 `code === 1011` 并提示回环境门 |
| Web | 新增 `packages/web/src/features/plugins/runtime-issue.ts` | 响应检测 + 去重 + toast action |

## 2. 候选模型与顺序

```js
// { command, prefixArgs, source, label }
```

顺序（与 `desktop-agent-runtime.md` 的 Rust 候选对齐）：

1. `TRELLIS_PYTHON` 环境变量——原样作为候选，不做文件校验（允许用户指定 `python3` 这类名字）；spawn 失败自然进入下一个。
2. 客户端记录的解释器——桌面壳注入为 `TRELLIS_PYTHON`，因此与 1 合并；若未来改为独立变量，放在 1 之后。
3. PATH 扫描：
   - Windows：`env.PATH` 按 `;` 拆分，依次找 `python.exe`、`python3.exe`；
   - POSIX：按 `:` 拆分，依次找 `python3`、`python`。
   - 每一项必须通过 `isUsableExecutable`。
4. Windows 常见目录：`%LOCALAPPDATA%\Programs\Python\Python*\python.exe`、`%ProgramFiles%\Python*\python.exe`、`%SystemDrive%\Python*\python.exe`。
5. `py -3`：先用 `py -3 -c "import sys;print(sys.executable)"` 反解真实路径（校验通过后用绝对路径作为候选）；反解失败时保留 `{ command: 'py', prefixArgs: ['-3'] }` 直接执行。
6. 裸 `python` / `python3`：只在前面都没解析出可用路径时追加，兼容非常规安装。

去重键：解析后的绝对路径（大小写不敏感平台按小写）。不做进程级缓存：每次任务创建重新解析，避免 Python 被卸载/替换后长期使用陈旧路径；解析成本是若干次 `stat`，`py` 反解只在需要时发生。

## 3. 可用性校验

```js
function isUsableExecutable(file) {
  const stat = fs.statSync(file)            // 跟随符号链接
  if (!stat.isFile() || stat.size === 0) return false // 排除 Windows App Execution Alias
  if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
  return true
}
```

- Windows 只接受 `.exe`（PATH 扫描不认 `.cmd`/`.bat`，`shell: false` 下不可执行）。
- 0 字节判定与 Rust `is_usable_file`（`probe.rs:325-334`）保持一致。
- 任何 `stat`/`access` 异常一律视为不可用。

## 4. 执行与回退

```js
async function runPythonScript(scriptPath, args, { cwd, env = process.env } = {})
```

- 逐候选 `spawn(command, [...prefixArgs, scriptPath, ...args], { cwd, env: { ...env, PYTHONUTF8: '1' }, windowsHide: true, shell: false })`。
- `child.on('error')`：`ENOENT` / `EACCES` / `EPERM` / `EFTYPE` 记录到 `attempts` 后继续；其他错误立即 reject。
- `child.on('close')`：退出码 0 → resolve `{ stdout, stderr }`；非 0 → 用 stderr → stdout → `task.py 退出码 N` 构造错误并 reject，**不换候选**（脚本本身失败，换解释器无意义）。
- 全部候选 spawn 失败 → 抛 `PythonUnavailableError`。

```js
export const PYTHON_UNAVAILABLE = 1011

export class PythonUnavailableError extends Error {
  constructor(attempts) {
    super('未找到可执行的 Python：请重新运行运行环境初始化，或设置 TRELLIS_PYTHON 指向 python.exe')
    this.name = 'PythonUnavailableError'
    this.code = PYTHON_UNAVAILABLE
    this.attempts = attempts // [{ label, command, code }]
  }
}
```

- 消息第一行固定为可操作文案；候选明细只放 `attempts`（日志可打印），避免 `plugins/witops-core/dispatch.js` 的首行提取把技术细节当成用户提示。
- 数值 code 复用插件协议的 positive-code 通道：`packages/server/plugins/protocol.js:252-262` 的 `errorResponse` 会把 `error.code` 放进 `data.code`。

## 5. 调用点改造

### 5.1 `actions.js`

- `runTaskPython(repoPath, args, env)` 改为 `runPythonScript(script, args, { cwd: repoPath, env })`。
- `createTask(input, { listRepositories, env = process.env })` 把 `env` 透传；生产默认不变，测试可注入 PATH/TRELLIS_PYTHON。
- 保持 `taskScriptSupports`、slug 校验、原子写 task.json 等逻辑不变。

### 5.2 `team/process.js` / `toolchain.js`

- 删除 `runProcess` 内 `command === 'python'` 的特殊回退（`:174-190`）；`runProcess` 只负责通用子进程。
- `toolchain.js:91` 改为：

```js
const python = await resolvePython({ env: process.env })
const result = await runProcess(python.command, [...python.prefixArgs, '-I', '-B', '-c', code, repoPath, parserFile], {
  cwd: repoPath,
  env: minimalEnvironment({ PYTHONUTF8: '1' }),
  timeoutMs: 60_000,
})
```

- `minimalEnvironment` 继续只透传白名单环境变量；解析发生在父进程，因此子进程不需要 `TRELLIS_PYTHON`。

## 6. client.json 与宿主注入

### 6.1 启动自检

现有链路已经满足「每次启动都检查」：主窗口始终先加载本地 `desktop/index.html`，`LoginApp` 挂载时调用 `runtime_status`（`packages/web/src/desktop/LoginApp.tsx:230`），`runtime_status` 内部 `env::check` → `resolve_python` 写回 flag（`runtime_commands.rs:102`、`probe.rs:734`）。本次不改时机，只补两处正确性：

1. `resolve_python` 在 flag 文件「存在但执行失败」（`python_version_at` 返回 None）时清空 flag，而不是保留坏路径继续。删除/0 字节仍走现有 `set_python_runtime(None)`。
2. `recorded_python()`（`task_command.rs:931`）从 `is_file()` 升级为「文件且 size > 0」，与 `is_usable_file` 对齐。

### 6.2 宿主注入

`plugin_host::ensure_running`（`plugin_host.rs:199`）在 `Command::new(&node)` 之后增加：

```rust
if std::env::var_os("TRELLIS_PYTHON").is_none() {
    if let Some(python) = crate::agent::task_command::recorded_python() {
        command.env("TRELLIS_PYTHON", python);
    }
}
```

- 进程级 `TRELLIS_PYTHON` 优先（与 Rust `run_task_python` 的候选顺序一致），不覆盖用户显式设置。
- 宿主每次 `ensure_running` 重新读取 `client.json`；宿主重启后自动使用最新 flag。
- 注入值已经过 `recorded_python` 的大小校验；宿主内 Node 解析器仍会再校验一次，坏路径只会浪费一次 spawn。

## 7. 错误码传递与回环境门

### 7.1 数据流

```
actions.createTask → PythonUnavailableError(code=1011)
  → task-service.create 原样抛出
  → supervisor handlePluginRequest 抛出
  → errorResponse: { code:-32603, message, data:{code:1011} }
  → 插件 SDK PluginError(code=1011)
  → witops-core createOne catch → 返回 { status:'failed', reason, code:1011 }
  → 插件 HTTP 响应 → host → Rust desktop_plugin_request → PluginPanel 桥
```

- 插件侧只在 `createOne` 的失败结果与 `createBatch` 的逐项结果透传 `Number.isInteger(error?.code) ? error.code : null`；不改协议版本、不改权限。
- 批量结果 `results[]` 与顶层都可能有 code，检测逻辑两者都看。

### 7.2 Web 检测

新增 `packages/web/src/features/plugins/runtime-issue.ts`：

```ts
export function hasPythonUnavailable(payload: unknown): boolean
export function reportRuntimeIssue(payload: unknown): void
```

- `hasPythonUnavailable` 递归检查 `payload.code === 1011`、`payload.results[].code === 1011`，忽略字符串误匹配。
- `reportRuntimeIssue` 用 sonner `toast.error('本地 Python 运行环境不可用', { action: { label: '检查运行环境', onClick: () => invoke('runtime_open_gate') }, id: 'python-unavailable' })`，`id` 去重避免连续下发刷屏。
- 在 `PluginPanel.tsx` 的 desktop 分支 `post({ type:'trellis:response', ... })` 之后调用；非 desktop 分支不调用（R4.4 只要求文案）。

### 7.3 回环境门命令

`main.rs` 新增：

```rust
#[tauri::command]
async fn runtime_open_gate(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_board_caller(&app, &window)?; // 只允许已配置的 Board origin
    let state = app.state::<DesktopAuthState>().inner().clone();
    navigate_local_login(&app, &state);  // 复用现有导航，不清会话
    Ok(())
}
```

- `navigate_local_login`（`main.rs:311`）只把主窗口导航到上次记录的本地页面；不清 cookie、不删配置、不调 logout。
- 本地登录页再次执行 `runtime_status`：Python 未就绪 → env 阶段环境门；已就绪 → 自动登录回 Board。
- 权限（远程 Board 专用，本地登录页不需要）：
  - `packages/desktop/src-tauri/permissions/desktop.toml` 增加
    ```toml
    [[permission]]
    identifier = "allow-runtime-open-gate"
    description = "当前 Board origin 可请求回到本地运行环境门。"
    commands.allow = ["runtime_open_gate"]
    ```
  - 只加入 `capabilities/board-local-association.json` 的 `permissions`；`capabilities/main.json` 不得包含。
  - 在 `packages/desktop/test/desktop-ui-build.test.js` 增加静态契约：`permissions/desktop.toml` 成对声明、Board capability 包含、`main.json` 不包含、`main.rs` 已注册、命令实现含 `ensure_board_caller`。
- `ensure_board_caller` 复用 `desktop_logout` 现有的调用方校验，防止任意页面触发导航。

## 8. 兼容性与权衡

- **旧插件 + 新客户端**：失败结果没有 `code`，shell 不弹环境门，只显示新的可操作文案；不影响下发。
- **新插件 + 旧客户端**：多出的 `code` 字段被忽略；旧客户端仍按旧解析器执行（本次修复不生效，但无回归）。
- **Team / 浏览器**：不经过 Rust 注入，解析器仍会扫描 PATH / `python3`；错误文案可读，无 Tauri 依赖。
- **不缓存解析结果**：牺牲极小的重复 stat 成本，换取 Python 被卸载/替换后的即时正确性。
- **不改 Node 版本门槛**：避免把「Python 版本过低」和「解释器不可启动」混为一谈；版本门槛仍由 Rust 自检负责。
- **注入 `TRELLIS_PYTHON` 的作用域**：只影响插件宿主及其子进程；宿主内所有 Trellis Python 调用共享同一个解释器，符合该变量语义。

## 9. 测试设计

| 层 | 用例 | 方式 |
| --- | --- | --- |
| 解析器单测 | 候选顺序、0 字节跳过、无执行权限跳过、`TRELLIS_PYTHON` 优先、Windows 常见目录、`py -3` 反解失败回退 | `platform`/`env`/`fs` 注入；Linux 上构造 0 字节 `python.exe` 与临时 PATH |
| 执行回退 | PATH 首位 0644 `python` + 可用 `python3` → 成功；全部失败 → `code=1011` 与首行文案；非 0 退出不重试 | 临时 shell 脚本 + `runPythonScript` |
| 任务集成 | 真实 `task.py` + 上述 PATH 场景创建任务成功 | 复用 `packages/server/test/plugin-real-task.test.js` 夹具 |
| Rust | flag 执行失败清空、`recorded_python` 0 字节拒绝、宿主 env 注入辅助函数 | `probe.rs` / `task_command.rs` 现有单测模块 |
| Web | `hasPythonUnavailable` 顶层/批量/无关 code；toast action 只触发一次 | `packages/web/test/*.test.js` |
| 手工 | Windows：Store 别名在 PATH 首位时下发成功；删除 python 后启动出现环境门；下发失败点「检查运行环境」回到环境门 | 记录在 implement.md 验收清单 |

## 10. 发布与回滚

- 无数据迁移、无 schema 变化；`client.json` 字段不变。
- 两个仓库（根仓库 + `plugins/`）分别提交；发布顺序不敏感（见 §8）。
- 回滚：还原 server/Rust/Web 提交即可；宿主进程重启后不再注入 `TRELLIS_PYTHON`。插件侧多出的 `code` 字段可保留。
