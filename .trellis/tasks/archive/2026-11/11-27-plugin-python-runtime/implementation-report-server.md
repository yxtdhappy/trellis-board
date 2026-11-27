# STEP 1 实施报告：server 端 Python 解析器

日期：2026-11-27
范围：`packages/server`（Rust / Web / `plugins/` 未改动）

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/server/python.js` | 新增 `PYTHON_UNAVAILABLE = 1011`、`PythonUnavailableError`、`isUsableExecutable`、`resolvePythonCandidates`、`resolvePython`、`runPythonScript`；`pythonCommandCandidates` 保留为兼容导出（委托候选解析） |
| `packages/server/actions.js` | `runTaskPython(repoPath, args, env)` 委托 `runPythonScript`；`createTask(input, { listRepositories, env = process.env })` 透传 `env`；删除本地 spawn/回退循环与 `spawn` import |
| `packages/server/team/toolchain.js` | `precheckLifecycleHooks` 先 `resolvePython({ env: process.env })`，再用解析结果执行 `-I -B -c` |
| `packages/server/team/process.js` | 删除 `command === 'python'` 的专用回退，`runProcess` 保持通用；删除 `pythonCommandCandidates` import |
| `packages/server/test/python-runtime.test.js` | 新增 12 个用例（候选顺序 / 校验 / 回退 / 1011 / 非 0 退出不重试） |
| `packages/server/test/actions.test.js` | 新增「createTask 把注入的 env 透传给 Python 解析器」 |

`packages/server/python.js` 共 275 行，低于 800 行上限，无需拆分辅助模块。

## 2. 实现要点

候选结构 `{ command, prefixArgs, source, label }`，`source` 取值：
`env` | `path` | `common-prefix` | `py-launcher` | `fallback`。

顺序（`resolvePythonCandidates({ env, platform = process.platform })`）：

1. `TRELLIS_PYTHON`（原样，不做文件校验，允许 `python3` 这类名字）；
2. PATH 扫描：Windows `python.exe` / `python3.exe`（只认 `.exe`），POSIX `python3` / `python`，
   每项必须过 `isUsableExecutable`；
3. Windows 常见目录：`%LOCALAPPDATA%\Programs\Python\Python*`、`%ProgramFiles%\Python*`、
   `%SystemDrive%\Python*`，子目录按名字倒序（新版本优先），取 `python.exe`；
4. `py -3`：优先用 `%SystemRoot%\py.exe`（可用时）跑 `-3 -c "import sys; print(sys.executable)"`
   反解真实路径，校验通过后用绝对路径；反解失败保留 `py -3` 直接执行；
5. 只有当 1-4 都没有解析出磁盘上的可用文件时，才追加裸 `python3` / `python`（Windows 为
   `python.exe` / `python3.exe`）。

去重键是 `realpath` 后的绝对路径（Windows 再小写），因此 `/usr/bin/python3` 与 `/bin/python3`
这类符号链接只会保留一个候选。不做进程级缓存：每次调用重新 `stat`。

`isUsableExecutable(file)`：`statSync` 跟随符号链接 → 必须 `isFile()` 且 `size > 0`
（排除 Windows App Execution Alias）→ POSIX 再 `accessSync(X_OK)`；任何异常都视为不可用。

`runPythonScript(scriptPath, args, { cwd, env = process.env, platform })`：

- 逐候选 `spawn(command, [...prefixArgs, scriptPath, ...args], { cwd, env: {...env, PYTHONUTF8:'1'}, windowsHide: true, shell: false })`；
- `error.code ∈ {ENOENT, EACCES, EPERM}` → 记入 `attempts` 后继续；其他 spawn 错误立即 reject；
- `close` 且 `code !== 0` → `stderr → stdout → <脚本名> 退出码 N`，直接 reject，**不换候选**；
- 全部候选 spawn 失败 → `PythonUnavailableError`，`code = 1011`，`attempts = [{ label, source, code }]`。

## 3. 验证命令与结果

```bash
# 1) 新测试文件
TRELLIS_PYTHON=python3 yarn test --scope=server --file=python-runtime
# → tests 12 / pass 12 / fail 0

# 2) actions 测试（含新增 env 透传用例）
TRELLIS_PYTHON=python3 yarn test --scope=server --file=actions.test.js
# → tests 13 / pass 13 / fail 0

# 3) 两个文件一起
TRELLIS_PYTHON=python3 yarn test --scope=server --file=python-runtime --file=actions.test.js
# → tests 25 / pass 25 / fail 0

# 4) 全 server scope
TRELLIS_PYTHON=python3 yarn test --scope=server
# → tests 559 / pass 559 / fail 0 （含 plugin-real-task.test.js 真实 task.py 用例）

# 5) 改动文件格式
yarn oxfmt --check packages/server/python.js packages/server/actions.js \
  packages/server/team/process.js packages/server/team/toolchain.js \
  packages/server/test/python-runtime.test.js packages/server/test/actions.test.js
# → All matched files use the correct format.
```

`yarn test --scope=lint` 失败，但失败项全部是本次未修改的既有文件（`plugins/*`、
`trellis-kit/*`、`packages/web/src/*`、`packages/server/team/plugins/*` 等 27 个文件），
`git status` 中它们都不在改动列表里，属既有基线问题。本次改动的 6 个文件单独
`oxfmt --check` 通过。

新增用例覆盖：

1. `isUsableExecutable`：目录 / 0 字节 / 0644 / 0755 / 不存在的路径；
2. 候选顺序：`TRELLIS_PYTHON` 第一，PATH 中 `python3` 先于 `python`，解析成功时不追加裸名字；
3. PATH 中 0 字节 `python.exe`（App Execution Alias）被跳过，回落 `python3.exe`；
4. PATH 中 0644 `python3` 不被当作候选，退回裸名字兜底；
5. Windows 常见目录排在 PATH 之后、按版本倒序；
6. `py -3` 反解成功 → 绝对路径候选，prefixArgs 为空；反解失败 → `py -3`；
7. PATH 首位是不可执行 `python` + 可用 `python3` → 执行成功；
8. `TRELLIS_PYTHON` 指向不可执行文件 → EACCES 后继续下一个候选并成功；
9. 全部候选不可启动 → `PythonUnavailableError`，`code === 1011`，首行可操作文案，
   `attempts` 为 `['python3','python']` / `['ENOENT','ENOENT']`，label 不含路径分隔符；
10. 脚本退出码 3 时不重试（PATH 中另有可用 python3，若重试就会成功；marker 只有一行）；
11. `resolvePython` 返回首候选、`pythonCommandCandidates` 兼容导出可用；
12. `actions.createTask` 注入空 PATH env 时抛 code=1011 且不执行 task.py，用 `process.env` 时成功。

## 4. 与 design.md 的偏差

1. **R1.4「消息里列出候选名」**：按 `design.md §4` 实现为「首行固定可操作文案，候选明细只放
   `error.attempts`」。理由：`plugins/witops-core/dispatch.js` 只取消息首行做面板提示，
   多行会把技术细节当用户提示；`attempts` 供日志排障。若评审要求消息内也列出候选名，
   可再追加第二行。
2. **`py -3` 只在 `platform === 'win32'` 时探测**（design 候选顺序是 Windows 语义）；
   POSIX 不做 `py` 反解，避免每次解析多一次 spawn。
3. **去重额外做了 `realpath` 归一化**（design 只写「解析后的绝对路径」）：否则
   `/usr/bin/python3` 与 `/bin/python3` 会被当成两个候选，重复 spawn 同一个解释器。
4. **`pythonCommandCandidates(env)` 改为委托候选解析**（返回各候选的 `command`），
   design 只要求「保留导出」。改后语义与解析器一致，且已无生产调用方
   （`team/process.js` 的专用回退已删除），不影响外部。
5. design 中的行号与现状有偏移（`actions.js` `runTaskPython` 实际在 118 行、`createTask` 在 160 行，
   与 design 一致；`team/process.js` 的回退块实际在 174-190 行，与 design 一致）。
   无功能性偏差。

## 5. 未覆盖 / 后续步骤

- 未改 `.trellis/spec/backend/plugin-runtime.md:167` 的过时描述（implement.md 第 7 步）。
- 未改 Rust（宿主注入 `TRELLIS_PYTHON`、`recorded_python` 大小校验、自检清坏 flag）。
- 未改 Web（`code === 1011` 提示与回环境门）。
- 未改 `plugins/witops-core/dispatch.js` 透传 `code`。
- `packages/server/test/plugin-real-task.test.js` 的「PATH 首位不可执行 python 仍能建任务」集成用例属
  implement.md 第 6 步，本次未加（`actions.test.js` 的 env 透传用例覆盖了同一条执行路径）。
- `runPythonScript` 目前不限制输出大小（与原 `runTaskPython` 行为一致）；team 侧仍走
  `runProcess` 的 64KB 上限。
