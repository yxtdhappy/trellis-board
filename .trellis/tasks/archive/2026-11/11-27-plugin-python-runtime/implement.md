# 实施计划：Python 解析、宿主注入与失败回环境门

> 前置：`prd.md`、`design.md` 已评审通过；`task.py start` 之后才进入执行。

## 0. 准备

- [ ] 确认分支：从 `main` 拉出工作分支（或沿用当前分支），记录 `task.py set-branch`。
- [ ] 记录基线测试：`TRELLIS_PYTHON=python3 yarn test --scope=server`、`TRELLIS_PYTHON=python3 yarn test --scope=plugins`，保存通过数，便于对比回归。
- [ ] 确认 `plugins/` 是独立 git 仓库：`git -C plugins status --short`；任务目录提交范围包含 `.trellis/tasks/11-27-plugin-python-runtime/`。

## 1. server 解析器（核心）

- [ ] 扩展 `packages/server/python.js`：
  - [ ] `resolvePythonCandidates({ env, platform })`：顺序、校验、去重（按 `design.md §2`）。
  - [ ] `isUsableExecutable(file)`：文件、非 0 字节、POSIX `X_OK`。
  - [ ] `resolvePython({ env, platform })`：返回 `{ command, prefixArgs, source }`，供 `toolchain.js` 使用。
  - [ ] `runPythonScript(scriptPath, args, { cwd, env })`：`ENOENT|EACCES|EPERM|EFTYPE` 继续，非 0 退出不重试。
  - [ ] `PYTHON_UNAVAILABLE = 1011`、`PythonUnavailableError`（消息首行可操作）。
  - [ ] 保留 `pythonCommandCandidates(env)` 导出（`team/process.js` 现有 import 不破坏）。
- [ ] 改 `packages/server/actions.js:118-153`：`runTaskPython` 委托 `runPythonScript`；`createTask` 签名增加 `env = process.env` 并透传（`:160`、`:225`）。
- [ ] 改 `packages/server/team/toolchain.js:91`：先 `resolvePython`，再 `runProcess`。
- [ ] 改 `packages/server/team/process.js:174-190`：删除 python 专用回退；`runProcess` 保持通用。
- [ ] 检查 `rg -n "'python'" packages/server --glob '!test/**'`，确认没有遗留硬编码调用点。

**验证**

```bash
TRELLIS_PYTHON=python3 yarn test --scope=server --file=python-runtime
TRELLIS_PYTHON=python3 yarn test --scope=server --file=actions.test.js
```

**Review gate 1**：解析器单测覆盖候选顺序/0 字节/无执行权限/全失败文案；`actions.test.js` 不回归。未过不进入 Rust 改动。

## 2. Rust：自检 flag 与宿主注入

- [ ] `probe.rs:734-800`：flag 文件存在但 `python_version_at` 返回 `None` 时 `set_python_runtime(None)`，继续探测；版本过低保留现状（用于 `found_version` 文案）。
- [ ] `task_command.rs:931-939` `recorded_python()`：`is_file()` 改为「文件且 `metadata.len() > 0`」。
- [ ] `plugin_host.rs:234`：宿主启动命令增加 `.env("TRELLIS_PYTHON", path)`，仅当父进程未设置 `TRELLIS_PYTHON`；路径来自 `recorded_python()`。
- [ ] 提取可测辅助函数（例如 `fn recorded_python_env() -> Option<(String, String)>`），避免在 `ensure_running` 内写不可测分支。
- [ ] 单测：
  - [ ] flag 指向 0 字节文件 → 自检清空并重新探测；
  - [ ] flag 指向可执行但运行失败的文件 → 自检清空；
  - [ ] `recorded_python()` 拒绝 0 字节；
  - [ ] 父进程已有 `TRELLIS_PYTHON` 时不覆盖。

**验证**

```bash
yarn test --scope=rust
```

**Review gate 2**：Rust 测试通过；代码评审确认注入不覆盖用户环境变量、不清会话。

## 3. 错误码透传（server → 插件，两个仓库）

- [ ] 根仓库：确认 `packages/server/plugins/protocol.js:252-262` 对 positive `error.code` 生成 `data.code`；不需要改协议，若已有测试覆盖则补一个 1011 断言。
- [ ] `plugins/witops-core/dispatch.js`（独立仓库）：
  - [ ] `createOne` 的 catch（`:1002` 附近）返回 `{ status:'failed', reason, code: Number.isInteger(error?.code) ? error.code : null }`；
  - [ ] `createChildren` 的失败项（`:849` 附近）同样透传；
  - [ ] `createBatch` 结果自然带出各项 code。
- [ ] `plugins/witops-core/test/index.test.js`：补「错误对象带 code=1011 时结果保留 code」用例。

**验证**

```bash
TRELLIS_PYTHON=python3 yarn test --scope=plugins --file=index.test.js
```

**Review gate 3**：插件测试通过；`git -C plugins diff` 只包含预期改动，单独提交。

## 4. Web：识别 code 并回环境门

- [ ] 新增 `packages/web/src/features/plugins/runtime-issue.ts`：
  - [ ] `hasPythonUnavailable(payload)` 支持顶层 `code` 与 `results[].code`；
  - [ ] `reportRuntimeIssue(payload)` 用 sonner `toast.error` + action，`id` 去重；
  - [ ] action 调 `invoke('runtime_open_gate')`（`@/desktop/tauri`），失败时 toast 提示。
- [ ] `PluginPanel.tsx:141-160`：desktop 分支响应后调用 `reportRuntimeIssue(response.data)`；非 desktop 分支不调用。
- [ ] 新增 `packages/web/test/plugin-runtime-issue.test.js`：顶层/批量/无关 code、重复响应只弹一次、无 Tauri 时不抛错。

**验证**

```bash
yarn test --scope=web --file=plugin-runtime-issue
yarn test --scope=lint
```

## 5. Rust：`runtime_open_gate` 命令与权限

- [ ] `main.rs` 新增 `runtime_open_gate(app, window)`：
  - [ ] `ensure_board_caller(&app, &window)?`；
  - [ ] `navigate_local_login(&app, &state)`；
  - [ ] 注册到 `invoke_handler`。
- [ ] `permissions/desktop.toml` 增加 `allow-runtime-open-gate`（`commands.allow = ["runtime_open_gate"]`）。
- [ ] 只把 `allow-runtime-open-gate` 加入 `capabilities/board-local-association.json`；`capabilities/main.json` 不得包含。
- [ ] `packages/desktop/test/desktop-ui-build.test.js` 增加静态契约测试（权限成对、capability 白名单、命令注册、`ensure_board_caller`）。
- [ ] 确认 `navigate_local_login` 不清 cookie、不删配置、不调用 logout（代码审查）。
- [ ] `packages/web/src/features/plugins/runtime-issue.ts` 的 action 与命令名一致。

**验证**

```bash
yarn test --scope=rust
yarn test --scope=lint
```

**Review gate 4**：命令只在 Board origin 可调用；本地登录页仍能正常 `runtime_status`/`runtime_install`。

## 6. 集成测试与回归

- [ ] `packages/server/test/python-runtime.test.js`：按 `design.md §9` 的矩阵补齐。
- [ ] `packages/server/test/plugin-real-task.test.js`：新增 PATH 首位不可执行 `python` 的场景（用 `TRELLIS_PYTHON` 指向可用解释器或临时 PATH 注入 `python3`），断言任务创建成功。
- [ ] 如 `actions.js` 签名变化影响其他调用方，更新 `packages/test-support/plugin-runtime.js` 或测试夹具。

```bash
TRELLIS_PYTHON=python3 yarn test --scope=server
TRELLIS_PYTHON=python3 yarn test --scope=plugins
yarn test --scope=web
yarn test --scope=desktop
yarn test --scope=rust
yarn test --scope=lint
```

**Review gate 5**：全量通过；失败项必须定位到环境缺失（记录命令与环境），不能以「与本次无关」跳过。

## 7. 文档与 spec

- [ ] `.trellis/spec/backend/plugin-runtime.md:167`：删除「actions.js 已回退到 python3，测试不需要注入 PATH shim」的过时结论，改为「候选解析 + spawn 失败继续 + 结构化 1011」。
- [ ] `.trellis/spec/backend/desktop-agent-runtime.md` §3：补 Node 侧候选顺序、宿主 `TRELLIS_PYTHON` 注入、flag 执行失败清空、失败回环境门契约。
- [ ] `.trellis/spec/backend/quality-guidelines.md` 如涉及测试范围说明，补充新测试文件。

**验证**

```bash
yarn format:check
```

## 8. 手工验收（Windows 实机，记录环境与结果）

> 2026-11-27 实机已覆盖以下三项：PATH 前置 0 字节 Store 别名、`TRELLIS_PYTHON` 指向不可执行文件、
> 真实 Python 回退；`check-report.md §4.1` 记录了命令与结果。完整「面板下发 → 环境门 → 自动回 Board」
> 因隔离实例未登录 WitOps 平台未执行。


- [ ] 机器存在 `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`（0 字节）且位于 PATH 前部：
  - [ ] 启动客户端，环境门通过；
  - [ ] 插件的下发任务成功，日志无 `spawn python EACCES`；
  - [ ] `client.json` 的 `python_runtime.path` 指向真实 `python.exe`。
- [ ] 删除/重命名真实 Python（模拟环境损坏）：
  - [ ] 重启客户端，环境门显示 Python 未就绪；
  - [ ] 点击「安装运行环境」后恢复正常。
- [ ] 保持 Python 损坏，打开插件面板下发任务：
  - [ ] 提示「本地 Python 运行环境不可用」且含「检查运行环境」；
  - [ ] 点击后回到环境门，未退出登录、未清空本地数据；
  - [ ] 初始化完成后自动回到 Board。
- [ ] 无桌面壳（浏览器 / Team）：下发失败只显示可操作文案，无 Tauri 报错。

## 9. 提交与归档

- [ ] 根仓库提交：server / Rust / Web / 测试 / spec / 任务目录（含 `prd.md`、`design.md`、`implement.md`、`research/`）。
- [ ] `plugins/` 仓库单独提交：`dispatch.js` + 测试；提交信息注明与根仓库的配对关系。
- [ ] `task.py set-commit <name> <hash>` 记录根仓库提交；`plugins` 提交哈希写入 `task.json` 的 `meta`（`task.py set-meta`）。
- [ ] `task.py archive` 前确认两个仓库都干净、任务目录已入库。

## 回滚点

1. 解析器改动（第 1 步）后如出现回归：还原 `python.js` / `actions.js` / `team/*`，插件执行恢复旧行为。
2. Rust 注入（第 2 步）后如宿主启动异常：移除 `.env("TRELLIS_PYTHON", ...)`，宿主回退 PATH 解析。
3. Web/命令（第 4-5 步）后如导航异常：移除 capability 与 toast action，保留错误文案。
4. 插件改动独立提交，可单独 revert，不影响根仓库其余修复。
