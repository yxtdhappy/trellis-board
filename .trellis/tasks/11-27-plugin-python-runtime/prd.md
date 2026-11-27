# 修复插件宿主 Python 解析与 spawn EACCES 回退

## Goal

让插件宿主执行 `.trellis/scripts/task.py` 时，Python 解释器的选择与桌面客户端启动自检使用同一套结果：客户端已探测并写入 `client.json` 的 `python_runtime.path` 必须被实际执行路径使用；`python` 名字解析到不可执行文件（Windows App Execution Alias / ACL 拒绝）时继续尝试其余候选，而不是直接把 `spawn python EACCES` 抛给插件面板。Python 确实不可用时，用户能从下发失败直接回到首次启动的环境检测界面，自行运行一遍环境初始化。

## Background

- 客户日志：登录成功，但 `POST /dispatch` 连续失败，`下发失败 {"businessId":"72769","message":"spawn python EACCES","code":-32603}`。失败点是本地创建 Trellis 任务，不是平台接口或登录。
- 调用链：`plugins/witops-core/dispatch.js:1001` → `packages/server/plugins/task-service.js:153` → `packages/server/actions.js:225` → `packages/server/actions.js:126` `spawn('python')`。
- 当前候选只有 `python` / `python3`（`packages/server/python.js:8-11`），且 `packages/server/actions.js:143` 只在 `ENOENT` 时回退；`EACCES` 直接失败。
- 启动自检（Rust `packages/desktop/src-tauri/src/agent/env/probe.rs:734-800`）会过滤 0 字节 Windows App Execution Alias、实际跑版本探测，并把可用的绝对路径写入 `client.json` 的 `python_runtime`。因此自检可以通过，但 Node 宿主按名字解析 PATH 时仍会命中别名/不可执行文件——这就是「首次检测能过、运行脚本报错」的原因。
- 插件宿主由 `packages/desktop/src-tauri/src/plugin_host.rs:199` 的 `ensure_running` 拉起，未继承 `client.json` 的解释器记录；`packages/desktop/src-tauri/src/agent/task_command.rs:931` 的 `recorded_python()` 只被 Rust 自己的 `run_task_python` 使用。

## Requirements

### R1 解释器候选与校验

- R1.1 `packages/server` 侧执行 task.py 时，候选顺序必须与桌面客户端自检对齐：`TRELLIS_PYTHON` → 客户端记录的 `python_runtime.path`（由宿主注入）→ PATH 中可用的 `python` / `python3` 绝对路径 → Windows 常见安装目录 → `py -3` 反解出的真实解释器 → 裸 `python` / `python3`（最后兜底）。
- R1.2 候选必须校验：存在、是文件、大小大于 0（排除 Windows App Execution Alias）、POSIX 下可执行。目录、0 字节占位、不可执行文件不得作为候选。
- R1.3 spawn 返回 `ENOENT` / `EACCES` / `EPERM` / `EFTYPE` 时继续下一个候选；只有全部候选都无法启动才判定 Python 不可用。task.py 正常启动但退出码非 0 时，保持现有行为（用 stderr/stdout 报错，不重试）。
- R1.4 全部候选失败时，抛出的错误必须：
  - 带稳定的机器可识别标识（数值 `1011`，字符串 `PYTHON_UNAVAILABLE`）；
  - 消息第一行是可操作中文，例如「未找到可执行的 Python：请重新运行运行环境初始化，或设置 TRELLIS_PYTHON 指向 python.exe」；
  - 列出尝试过的候选名（不输出完整本机路径），便于排障。

### R2 启动自检与 client.json

- R2.1 每次客户端启动都执行一次运行环境自检（复用现有 `runtime_status` / `env::check`），后台执行、不阻塞 UI；不新增自动下载或静默安装。
- R2.2 自检成功后把解析到的 Python 绝对路径写入 `client.json` 的 `python_runtime`（保留现有行为）；flag 有效时只做本地校验，不重复跑 PowerShell。
- R2.3 flag 指向的解释器失效（被删除、0 字节、执行失败）时，自检必须清掉旧 flag 并重新探测；探测失败则环境门显示未就绪，而不是继续使用坏路径。
- R2.4 自检未通过时继续展示现有环境检测界面（登录页 env 阶段），由用户点击「安装运行环境」或重试；本次不改变安装/重试的交互。

### R3 宿主与执行路径打通

- R3.1 桌面客户端拉起插件宿主时，把 `client.json` 中 `python_runtime.path` 注入宿主进程环境（`TRELLIS_PYTHON`）；宿主重启或重新拉起时重新读取，不能只依赖一次性的进程环境。
- R3.2 宿主注入前必须校验该路径可用（存在、非目录、大小 > 0），坏路径不得覆盖其他候选。
- R3.3 `packages/server` 内所有 Python 调用点统一走同一解析器，不允许再出现硬编码 `'python'` 且无回退的调用；至少覆盖 `packages/server/actions.js`、`packages/server/team/process.js`、`packages/server/team/toolchain.js`。

### R4 失败可回到环境检测界面

- R4.1 插件下发结果在 Python 不可用时携带 R1.4 的数值 code（与 `reason` 并存），供桌面壳识别；批量下发时每个失败项都带 code。
- R4.2 桌面 Board 页面在插件面板响应中识别到该 code 时，必须提示「本地 Python 运行环境不可用」并提供「检查运行环境」操作；点击后主窗口回到本地环境检测界面（登录页 env 阶段），由用户自行运行环境初始化。
- R4.3 该跳转不得自动登出、不得清空会话或本地数据；环境恢复后沿用现有自动登录链路回到 Board；环境仍不可用时环境门停留并展示原因。
- R4.4 非桌面壳场景（浏览器 / Team 服务）没有该跳转能力时，至少展示 R1.4 的可操作错误文案，不得出现要求 Tauri 的报错。

### R5 验证与文档

- R5.1 为解析器和回退逻辑补充自动化测试：候选顺序、0 字节/不可执行文件（POSIX `EACCES` 模拟）、`TRELLIS_PYTHON` 优先、全失败文案、task.py 非 0 退出不重试。
- R5.2 用真实 `task.py` 做集成测试：在 PATH 首位放不可执行的 `python` 时，仍能回退到 `python3` 并创建任务（Linux CI）；Windows 实机验证作为手工验收项记录。
- R5.3 相关测试范围（`packages/server`、`packages/desktop`、Rust `cargo test`）通过，现有测试不回归。
- R5.4 更新 `.trellis/spec/backend/plugin-runtime.md` 中「宿主调用依赖 python，actions.js 已回退到 python3」的过时描述，并在 `.trellis/spec/backend/desktop-agent-runtime.md` 补充 Node 侧候选、宿主环境注入与失败回环境门的契约。

## Acceptance Criteria

- [ ] PATH 首位放 0644 的 `python` 文件、`python3` 可用时，插件下发任务成功创建，日志不再出现直接失败的 `spawn python EACCES`；解析器优先使用 `python3` 或客户端记录的解释器。
- [ ] 所有候选都不可启动时，下发结果为 `{ status: 'failed', code: 1011, reason: <可操作中文> }`；插件面板提示包含「检查运行环境」。
- [ ] 点击「检查运行环境」后主窗口进入本地环境检测界面；Python 未就绪时停留在环境门，完成初始化后可回到 Board；过程中会话与本地数据未被清除。
- [ ] 启动后 `client.json` 的 `python_runtime.path` 指向通过自检验证的解释器；插件宿主进程环境中的 `TRELLIS_PYTHON` 等于该路径（可用单元测试或日志断言）。
- [ ] flag 指向的解释器被删除后，下一次启动自检能清掉旧 flag 并重新探测；环境门状态与实际可用性一致。
- [ ] `packages/server/team/toolchain.js` 不再硬编码 `'python'`，其调用可通过解析器回退到 `python3`。
- [ ] 新增测试与现有测试范围全部通过，且 `git status` 只包含本任务范围内的代码、测试、文档与任务目录；`plugins/` 仓库改动单独提交并记录。

## Out of Scope

- 不自动下载或静默安装 Python；安装仍由环境门按钮触发。
- 不改变 Rust 现有的 Python ≥ 3.9 门槛，也不在 Node 侧新增版本门槛。
- 不重构插件 RPC 协议、不新增插件权限，不改插件 manifest/apiVersion。
- 不改 Team 服务的 Python 安全策略（只复用同一解析器）。
- 不做 Windows 实机自动化（当前无可用 Windows 设备），仅保留手工验收步骤。

## Risks / Deferred

- Windows `EACCES` 的触发来源可能因机器而异（Store 别名、ACL、EDR 拦截）。修复以「解析绝对路径 + 可识别的 spawn 失败（含 Windows `EFTYPE`）继续候选」覆盖，不依赖单一来源假设。
- 向宿主注入 `TRELLIS_PYTHON` 会影响插件内所有 Trellis 相关 Python 调用；这与该变量既有语义一致，但若插件需要自带解释器需显式覆盖。
- 新增错误码需要 `plugins/` 仓库同步改动（透传 code），两个仓库的提交要成对出现，避免只升级一边导致面板拿不到 code。
- 回到环境门会离开当前 Board 页面，可能丢失未提交的页面表单；只在用户点击操作时跳转，不做自动跳转。
