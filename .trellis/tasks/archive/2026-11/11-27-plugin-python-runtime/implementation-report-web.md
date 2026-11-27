# STEP 4+5 实施报告：Web 识别 1011 + Rust `runtime_open_gate`

日期：2026-11-27
范围：`packages/web`（面板桥 + 纯检测模块 + 单测）、`packages/desktop`（Tauri 命令、权限、capability、静态契约测试）。
未改动：`packages/server/**`、`plugins/**`（属 STEP 1-3，由其它 worker 负责）。

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/web/src/features/plugins/runtime-issue.ts`（新增） | `PYTHON_UNAVAILABLE = 1011`、`hasPythonUnavailable(payload)`、`pythonUnavailableToast()`；无 sonner / `@/` 依赖，可被 `node:test` 直接 import `.ts` |
| `packages/web/src/features/plugins/PluginPanel.tsx` | desktop 分支响应后调用 `reportPythonUnavailable(response.data)`；`toast.error` + `action` 调 `invoke('runtime_open_gate')`；非桌面壳只提示文案 |
| `packages/desktop/src-tauri/src/main.rs` | 新增 `runtime_open_gate(app, window)`（`ensure_board_caller` → `navigate_local_login`），注册到 `generate_handler!`（放在 `runtime_install,` 之后） |
| `packages/desktop/src-tauri/permissions/desktop.toml` | 新增 `allow-runtime-open-gate`（`commands.allow = ["runtime_open_gate"]`） |
| `packages/desktop/src-tauri/capabilities/board-local-association.json` | `permissions` 追加 `allow-runtime-open-gate`（紧跟 `allow-desktop-logout`）；`capabilities/main.json` 未改 |
| `packages/desktop/test/desktop-ui-build.test.js` | 新增 `desktop board can reopen the local runtime gate without clearing the session`（权限成对、Board capability 含 / main.json 不含、命令注册、`ensure_board_caller`、命令体不含清会话调用、Web 侧 invokes 一致） |
| `packages/web/test/plugin-runtime-issue.test.js`（新增） | 5 个 `node:test` 用例：顶层 code、批量 `results[]`、无关 code / 字符串 1011、非对象负载、toast 文案 |

## 2. 实现要点

### 2.1 `runtime-issue.ts`（纯函数，零 UI 依赖）

```ts
export const PYTHON_UNAVAILABLE = 1011
export function hasPythonUnavailable(payload: unknown): boolean
export function pythonUnavailableToast(): { id; title; description; actionLabel }
```

- `hasUnavailableCode` 只做 `value.code === 1011` 的数值比较（`Record<string, unknown>` 上的 `===` 对 `unknown` 天然安全），字符串 `'1011'` 与文案里的 `1011` 都不命中。
- 顶层命中即返回；否则仅在 `results` 为数组时逐项判断，数组本身不会被当作 payload 命中。
- 文案集中在 `pythonUnavailableToast()`，`PluginPanel` 消费同一份文本，保证桌面/浏览器分支一致。

### 2.2 `PluginPanel.tsx` 桌面分支

```ts
reportPythonUnavailable(response.data)   // post({ type:'trellis:response', ... }) 之后
```

- `reportPythonUnavailable` 先判 `hasPythonUnavailable`，未命中直接返回；命中才 `toast.error(title, { id: 'python-unavailable', description, action: { label: '检查运行环境', onClick } })`，`id` 由 sonner 去重，连续下发不会刷屏。
- `openRuntimeGate`：`!isNativeTauri || !invoke` → `toast.error('请在桌面客户端中打开运行环境门')`；否则 `void invoke('runtime_open_gate').catch(...)`，异常用 `errorMessage(error, '打开运行环境门失败')` 提示（复用 `@/desktop/tauri` 既有 helper，会剥掉 `Error: ` 前缀）。
- 非 desktop 分支（`fetch` 路径）未加任何导航或新提示，保持既有错误文案。

### 2.3 Rust 命令与权限

```rust
/// 下发任务遇到本地 Python 不可用时，当前 Board origin 请求回到本地运行环境门。
/// 只做导航：不清会话、不清已保存密码、不退出登录。
#[tauri::command]
async fn runtime_open_gate(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_board_caller(&app, &window)?;
    let state = app.state::<DesktopAuthState>().inner().clone();
    navigate_local_login(&app, &state);
    Ok(())
}
```

- 只调用 `navigate_local_login`（`main.rs:311` 只 `window.navigate(local_url)`）；未调用 `clear_desktop_session` / `forget_saved_password` / `desktop_logout`，静态契约测试也断言了这一点。
- 权限只进 `capabilities/board-local-association.json`；`permissions/desktop.toml` 中与 `allow-desktop-logout` 相邻声明，描述明示「只做导航不清会话」。

## 3. 与 `implement.md` 的偏差（3 处，均有理由）

1. **`reportRuntimeIssue` 没有导出到 `runtime-issue.ts`**：任务的执行契约把模块限定为 `PYTHON_UNAVAILABLE` / `hasPythonUnavailable` / `pythonUnavailableToast`，并要求「模块不得 import sonner 或 `@/` 别名（node:test 可导入）」。`implement.md` §4 写的 `reportRuntimeIssue(payload)` 若放进该模块会立刻引入 sonner 依赖并破坏可测性，因此 toast 组装落在 `PluginPanel.tsx` 的私有函数 `reportPythonUnavailable`（同签名 `payload: unknown`），文案仍由模块提供。
2. **`generate_handler!` 注册位置**：紧接 `runtime_install,` 而不是紧跟 `desktop_logout,`。既有测试 `desktop logout uses a board-only command and forgets the saved password` 断言 `/desktop_logout,\s+desktop_login,/`，插在两者之间会让该断言失效；放在 runtime 组末尾既不改既有契约，又与命令名同族。
3. **`plugin-runtime-issue.test.js` 未覆盖「重复响应只弹一次」**：去重由 sonner 的 `id` 实现，纯模块层无法测试；任务给定的用例清单也只要求顶层/批量/无关 code/非对象/文案。`id` 固定为 `'python-unavailable'` 由该测试与桌面契约测试共同锁定。

## 4. 验证

### 4.1 通过

```bash
yarn test --scope=web --file=plugin-runtime-issue
# 1..5 / pass 5 / fail 0 / duration_ms 131

yarn test --scope=desktop --file=desktop-ui-build
# 1..12 / pass 12 / fail 0（新增用例为第 7 个）

yarn test --scope=web         # 144 pass / 0 fail
yarn test --scope=desktop     # 44 pass / 1 skip / 0 fail
```

### 4.2 `yarn test --scope=lint`：失败，但均为既有问题

```bash
yarn test --scope=lint
# oxfmt --check 失败：28 个文件「Format issues found」，进程在 oxfmt 处中止，
# 因此 oxlint / tsc 未被执行（脚本顺序执行）。
```

- 28 个文件全部是本次未改动的路径：`plugins/*/plugin.json`、`plugins/*/panel/index.html`、`plugins/witops-core/{dispatch.js,test/index.test.js}`、`trellis-kit/**`、`packages/server/team/plugins/*`、`packages/server/test/team-*.test.js`、`packages/web/src/api/{plugin-transport,team-plugins}.ts`、`packages/web/src/desktop/tauri.ts`、`packages/web/src/hooks/useOwnershipInbox.ts`、`packages/web/src/lib/role.ts`。
- 我改动/新增的 4 个文件单独跑 `oxfmt --check` 全部通过（`PluginPanel.tsx`、`runtime-issue.ts`、`plugin-runtime-issue.test.js`、`desktop-ui-build.test.js`）。中途 `PluginPanel.tsx` 与 `desktop-ui-build.test.js` 各出现过一次格式偏差，已按 oxfmt 输出修正。
- 手工补跑后两步：

```bash
cd packages/web && node ../../node_modules/oxlint/bin/oxlint   # exit 0，66 条 warning，无 error；无一条指向本次改动文件
cd packages/web && node ../../node_modules/typescript/bin/tsc -b --noEmit   # exit 0
```

### 4.3 `yarn test --scope=rust`：失败项与 HEAD 基线完全一致

```bash
yarn test --scope=rust
# test result: FAILED. 448 passed; 8 failed
```

在 `/tmp` 用 `git archive HEAD packages/desktop/src-tauri`（+ `trellis-kit`、`plugin-host`、`plugins/` 拷贝）跑 HEAD 基线：

```bash
cd /tmp/tb-head/packages/desktop/src-tauri && CARGO_TARGET_DIR=/tmp/tb-head-target cargo test
# test result: FAILED. 441 passed; 9 failed
```

| 失败用例 | HEAD 基线 | 当前工作区 | 判定 |
| --- | --- | --- | --- |
| `agent::env::tests::fallback_dirs_cover_version_manager_prefixes` | fail | fail | Linux 上缺 `%LOCALAPPDATA%`/`%ProgramFiles%`，路径解析返回空 |
| `agent::env::tests::python_dirs_cover_common_install_roots` | fail | fail | 同上 |
| `agent::env::tests::status_paths_live_under_data_dir` | fail | fail | 同上（`where`/dirs 期望 Windows 路径） |
| `agent::env::tests::where_node_output_yields_parent_dirs` | fail | fail | Linux 上 `C:\...` 无 `/` 分隔，`Path::parent` 为空 |
| `agent::env::tests::where_python_output_yields_parent_dirs` | fail | fail | 同上 |
| `agent::onboarding::tests::commits_and_pushes_only_initialization_paths` | fail | fail | `REMOTE_INVALID`（git 远端校验，环境相关） |
| `agent::onboarding::tests::reports_initial_push_state_for_missing_remote_branch` | fail | fail | 同上 |
| `agent::onboarding::tests::untracks_manifest_before_initial_commit` | fail | fail | 同上 |
| `plugin_host::tests::embedded_assets_cover_host_and_builtin_plugins` | fail（仅 /tmp 拷贝环境） | pass | 基线拷贝里 `plugins/` 是整目录复制而非 gitlink 内容，属拷贝环境噪声 |

结论：8 个失败在 HEAD 全部存在，本次 STEP 4+5 未引入新的 Rust 失败（448 通过 vs 基线 441 通过，差额来自 STEP 2 新增的 7 个用例）。

## 5. 残留风险

- 浏览器壳里 `isNativeTauri === false`，点「检查运行环境」只弹「请在桌面客户端中打开运行环境门」；这符合 R4.4（无桌面壳只给文案），但若将来 headless 桥要支持该命令，需要改 `openRuntimeGate` 的分支判定。
- toast 只在 desktop 分支触发；若某天插件面板改走 `fetch`（Team/浏览器），1011 只会体现在面板自己的错误文案里。
- `runtime_open_gate` 依赖 `state.local_url` 已记录；未记录时 `navigate_local_login` 静默返回（`Ok(())`），用户看不到反馈。当前 `local_url` 在每次本地页面加载时写入，正常登录流程下必然存在。
