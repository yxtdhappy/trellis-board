---
mode: independent
agent: worker
session: fd975232-8d2f-4996-9c73-c80e38c3e85c
commit: 
base: 495a71b031b014431f4271718b888cd8c308d09b
scope: packages/server,packages/desktop/src-tauri,packages/desktop/test,packages/web/src/features/plugins,packages/web/test,.trellis/spec/backend
diff: sha256:59c3650da213dfbd6300eb140c56c4c893266795233ef482ad225923f2d3749e
---
# 独立检查报告：插件宿主 Python 解析与 spawn EACCES 回退

检查范围：根仓库工作区 diff（server / desktop-Rust / web / specs / 任务目录）+ 嵌套仓库
`plugins/` 工作区 diff。未改动 `.trellis/scripts`，未执行 `task.py` 状态命令，未提交。

## 1. 结论

实现与 `prd.md` / `design.md` 的 R1–R5 一致，未发现阻塞级缺陷。补齐 3 处小问题（1 处死代码
import、1 处重复分支、1 处 spec 措辞不精确），其余为信息级偏差与残留风险。

## 2. 逐项核对

| 关注点 | 结论 |
| --- | --- |
| `packages/server/python.js` 候选 / 校验 / 重试 / 1011 | 通过。顺序 `TRELLIS_PYTHON` → PATH 绝对路径 → Windows 安装目录 → `py -3` → 裸名；`isUsableExecutable` 排除目录/0 字节/POSIX 不可执行；`ENOENT`/`EACCES`/`EPERM`/`EFTYPE` 换候选，非 0 退出不重试；全失败抛 `PythonUnavailableError(code=1011)`，`attempts` 只含候选名（`labelFor` 对 env 候选固定为 `TRELLIS_PYTHON`，不回显路径） |
| `actions.js` env 透传 | 通过。`runTaskPython(repoPath, args, env)` → `runPythonScript`；`createTask(..., { env = process.env })`；生产调用点 `packages/server/plugins/task-service.js:153` 未传 env，行为不变 |
| `team/toolchain.js` 回退 | 通过。`precheckLifecycleHooks` 用 `tryPythonCandidates` 逐个候选跑 `-I -B -c`；`team/process.js` 删除 `command === 'python'` 专用回退；全仓库已无硬编码 `spawn('python')`（`grep` 仅命中 `python.js` 注释与候选名） |
| Rust flag 自愈 | 通过。`classify_recorded_python`：不可用/版本探测失败 → `Stale`（清空 flag 后继续探测），版本过低 → `Outdated`（保留 flag 供 `found_version`）；与改动前语义差异仅「可执行但跑不起来不再保留坏路径」 |
| `recorded_python` 0 字节 | 通过。`recorded_python_from` 改用 `is_usable_file`（普通文件且 `len > 0`），`is_usable_file` 由 `pub(super)` 放宽为 `pub(crate)` 复用同一判定 |
| `TRELLIS_PYTHON` 注入优先级 | 通过。`python_env_for_host` 在父进程已有该变量时返回 `None`（宿主继承父环境，用户显式值不被覆盖）；注入值经 `recorded_python()` 校验；`ensure_running` 每次拉起重读 `client.json` |
| `runtime_open_gate` | 通过。`ensure_board_caller` → `navigate_local_login`，无 `clear_desktop_session` / `forget_saved_password` / `desktop_logout`；`permissions/desktop.toml` 成对声明 `allow-runtime-open-gate`，只进 `capabilities/board-local-association.json`，`main.json` 未包含，已注册进 `generate_handler!` |
| Web 1011 识别 | 通过。`hasPythonUnavailable` 只看数值 `code === 1011`（顶层 + `results[]`），字符串/文案里的 1011 不命中；`witops-core` 的 `createBatch` 返回 `{ results, summary }`，实际链路命中 `results[]` |
| 仅桌面壳可导航 | 通过。`reportPythonUnavailable` 只在 `panel.host === 'desktop'` 分支调用；`openRuntimeGate` 在 `!isNativeTauri || !invoke` 时只提示「请在桌面客户端中打开运行环境门」，不发 Tauri 调用 |
| toast 去重 | 通过。sonner `id: 'python-unavailable'` 固定，连续下发合并为一条 |
| 插件 `code` 透传 | 通过。`failureResult` 只在 `Number.isInteger(code) && code > 0` 时保留 `code`，JSON-RPC 负数码与字符串码被丢弃；成功/重复（`status: imported` / `duplicated`）路径未改 |
| 测试真实性 | 通过。server 单测直接调用生产导出；`plugin-real-task.test.js` 用真实 `task.py` + 坏解释器走完整 `createService`；Rust 用例走 `probe_recorded_python` / `recorded_python_from` / `python_env_for_host` 生产函数。`desktop-ui-build.test.js` 为静态契约（仓库既有模式），不替代行为测试 |
| spec 准确性 | 修正 1 处措辞后通过；`plugin-runtime.md` 的「已回退到 python3、测试不需要 PATH shim」过时结论已删除 |

## 3. 发现与处置

### 已修复

1. **[low] `packages/server/team/toolchain.js:5` 未使用 import**
   `import { resolvePythonCandidates, tryPythonCandidates }` 中 `resolvePythonCandidates` 无消费者
   （`implement.md` 计划用 `resolvePython`，实现改用 `tryPythonCandidates`）。已改为只导入
   `tryPythonCandidates`。

2. **[low] `packages/server/python.js` `spawnCandidate` 重复分支**
   `child.once('error')` 中 `if (RETRYABLE_SPAWN_CODES.has(error.code)) reject(error); else reject(error)`
   两支相同，重试判定实际在 `tryPythonCandidates`。已简化为单一 `reject(error)` 并注明判定归属，
   行为不变（重试策略保持单一来源）。

3. **[low] `.trellis/spec/backend/desktop-agent-runtime.md` 措辞不精确**
   原文「宿主 Node 侧 `packages/server/python.js` 按同一顺序解析」与 Node 实际顺序并不逐项相同
   （Node 把 PATH 绝对路径排在裸 `python`/`python3` 之前，且 `py -3` 在裸名之前）。已改写为
   精确顺序，并说明 `TRELLIS_PYTHON` 允许是名字（不做文件校验）。

### 信息级（未改，供记录）

4. **[info] `implementation-report-server.md` 与代码不符**：报告写 `precheckLifecycleHooks`
   「先 `resolvePython(...)`」，实际用 `tryPythonCandidates`（多出 spawn 失败重试）；报告写
   「新增 12 个用例」，实际 `packages/server/test/python-runtime.test.js` 为 13 个 `test()`。
   代码行为优于报告描述，未改他人报告。

5. **[info] `resolvePython` / `pythonCommandCandidates` 目前只有测试消费者**：`design.md §1/§5.2`
   要求保留兼容导出，故保留；`pythonCommandCandidates` 已标注 `@deprecated`。

6. **[info] R1.4 的字符串标识**：`PYTHON_UNAVAILABLE` 只作为导出常量名与 `error.name =
   'PythonUnavailableError'` 存在，未随负载下发（`design.md §4` 即如此定义，插件只需数值
   `code`，`protocol.errorResponse` 把正码放进 `error.data.code`）。

7. **[info] `hasPythonUnavailable([{ code: 1011 }])` 为 `false`**：顶层数组不被当作 payload。
   现有插件（`witops-core`）批量返回 `{ results, summary }`（`plugins/witops-core/dispatch.js:1075-1083`），
   实测链路命中 `results[]`，不构成功能缺口；单测显式锁定了该行为。

8. **[info] `tauri-commands/index.md` 未新增 `runtime_open_gate` 场景**：`prd.md` R5.4 只要求更新
   `plugin-runtime.md` 与 `desktop-agent-runtime.md`；新增命令已遵守该 spec 已声明的
   「permission + capability + `ensure_board_caller`」契约，无需新场景。

## 4. 验证命令与结果（本机 Linux，Node v22.21.1 / Python 3.12.3）

```bash
# 1) 全量（含 plugins/ 嵌套仓库测试）
PYTHON=python3 TRELLIS_PYTHON=python3 yarn test --scope=all
# → EXIT=0，tests 965 / pass 962 / fail 0 / skip 3 / duration 64.8s（修复前后各跑一次，结果一致）

# 2) server 范围（修复后连跑 5 次）
TRELLIS_PYTHON=python3 yarn test --scope=server
# → 561 pass / 0 fail（5/5 次一致）

# 3) Rust
TRELLIS_PYTHON=python3 yarn test --scope=rust
# → FAILED. 448 passed; 8 failed（与已知基线相同的 8 个 Windows-only 用例：
#   agent::env::tests::{fallback_dirs_cover_version_manager_prefixes, python_dirs_cover_common_install_roots,
#   status_paths_live_under_data_dir, where_node_output_yields_parent_dirs, where_python_output_yields_parent_dirs}
#   + agent::onboarding::tests::{commits_and_pushes_only_initialization_paths,
#   reports_initial_push_state_for_missing_remote_branch, untracks_manifest_before_initial_commit}）
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --bin trellis-board-client -- \
  recorded_python parent_trellis_python probe_recorded_python
# → 6 passed; 0 failed（本次新增的 6 个 Rust 用例全部通过）

# 4) lint 范围
yarn test --scope=lint
# → EXIT≠0：oxfmt --check 报 27 个**既有**文件格式问题，改动文件均不在列表；
#   脚本在 oxfmt 处中止，故手工补跑后两步：
cd packages/web && node ../../node_modules/oxlint/bin/oxlint        # → 仅 warning，无 error；无一条指向改动文件
cd packages/web && node ../../node_modules/typescript/bin/tsc -b --noEmit   # → EXIT=0
node node_modules/oxfmt/bin/oxfmt --check <13 个改动的 js/ts/tsx 文件>       # → All matched files use the correct format.

# 5) Rust 格式与编译告警
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --check
# → 基线即有 diff（build.rs、main.rs:94/104/732、task_command.rs:366、company_spec/*、git/* 等）；
#   本次新增行（main.rs:377、task_command.rs:931-936、probe.rs:736-783、plugin_host.rs:201-208 与 278-283）不在任何 hunk 内
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml --tests
# → 4 条基线 warning（git.rs、agent_service.rs、credential.rs、protocol.rs），改动文件无新增告警

# 6) 错误码链路实测
node --input-type=module -e "errorResponse(...) / failureResult(...)"
# → {"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"未找到可执行的 Python：…","data":{"code":1011}}}
# → {"status":"failed","reason":"未找到可执行的 Python：…","code":1011}
```

说明：修复后第一次 `--scope=server` 运行出现 1 个失败，但未捕获到用例名；随后同一命令连续 5 次
`561/561` 通过，`--scope=all` 亦 965 项 0 失败，判定为环境抖动（该次与另一条 shell 命令并行执行），
无复现。若后续复现需按 `--test-reporter` 记录用例名再定位。

## 4.1 Windows 实机验证（2026-11-27）

在 `Z0328@192.168.137.1` 的 `E:\work\mdp\trellis-board`（独立检出，HEAD `64ae0a45`，关键文件与
Linux `495a71b0` 一致）应用本次 diff 后执行：

```bash
# Node 侧
yarn test --scope=server --file=python-runtime      # 14 tests, 2 pass / 12 skip（POSIX 用例跳过）
yarn test --scope=server --file=actions.test        # 13 tests, 9 pass / 4 skip
yarn test --scope=web --file=plugin-runtime-issue   # 5/5
yarn test --scope=desktop --file=desktop-ui-build   # 12/12
yarn test --scope=plugins --file=index.test         # 98/98
# Rust 侧
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --bin trellis-board-client
# → 461 passed / 1 failed：agent::process::tests::decodes_system_codepage_output
#   期望中文 cmd 文案，英文 Windows 返回 "is not recognized"，属既有环境断言，与本次改动无关
# 构建
./tauri-dev.sh build desktop --skip-typecheck       # UI Vite 构建 + cargo debug 编译通过
```

实机回归（`E:\work\mdp\_windows-dev\python-fallback.mjs`）：

- `TRELLIS_PYTHON` 指向 0 字节 `python.exe`、PATH 前置同目录 0 字节别名、真实 Python 在 PATH 后方：
  首次 `spawn EFTYPE`（旧重试集合未含该码），加入 `EFTYPE` 后 `RUN_OK ran`，候选顺序为
  `env:...0字节python.exe` → `path:...Python313\python.exe`。
- PATH 只含 0 字节 `python.exe`/`python3.exe`：候选落到
  `common-prefix:C:\Users\kanyifei\AppData\Local\Programs\Python\Python313\python.exe`，`RUN_OK ran`。

客户端 `./tauri-dev.sh start` 启动成功，登录页与远端 Board 页面均能加载，插件面板 iframe 正常挂载到
本地 plugin-host；面板未登录平台，未执行真实下发。Windows 的 `tsgo`（TypeScript 7 native）对该机器上
部分源文件报 `TS1127`（Node 读取同一文件正常，Vite 构建正常），因此 UI 构建使用 `--skip-typecheck`；
Linux 侧 `tsc` 已通过，故未归因于本次改动。

## 5. 残留风险

1. **Windows 每次任务创建同步拉起 `py -3`**：`resolvePythonCandidates` 在 win32 上无条件执行
   `execFileSync(py, ['-3','-c', ...])`（超时 10s），即使 `TRELLIS_PYTHON` 或 PATH 已解析出解释器。
   正常机器约 100–300ms，但会阻塞宿主事件循环；`py.exe` 异常挂起时最坏阻塞 10s。`design.md §2`
   明确该顺序，本次未改。
2. **Team 场景错误形态**：`precheckLifecycleHooks` 抛 `PythonUnavailableError`（正数码）会被
   `packages/server/team/errors.js` 的 `errorPayload` 归为 `500 INTERNAL_ERROR` 通用文案（与改动前
   同类，未回归），且该函数当前无生产调用方。
3. **Windows 实机验收**：已完成 PATH 0 字节别名、`TRELLIS_PYTHON` 不可执行、真实 Python 回退三项（见 4.1）；
   ACL 拒绝与 `client.json` 损坏仍未实机覆盖。
4. **toast 只覆盖桌面面板桥**：Team/浏览器分支不弹 toast（R4.4 只要求可读文案，由插件面板自身
   展示）；若将来 Team 面板也走 `trellis:response` 桥需重新评估。
5. **`runtime_open_gate` 依赖 `state.local_url`**：未记录时 `navigate_local_login` 静默返回 `Ok(())`，
   用户看不到反馈（现有登录流程下 `local_url` 必然存在）。
6. **`plugins/` 需与根仓库成对提交**：插件侧 `failureResult` 未上线时，新客户端拿不到 `code`，
   toast 不出现但文案仍可读（`design.md §8` 已列为兼容矩阵）。