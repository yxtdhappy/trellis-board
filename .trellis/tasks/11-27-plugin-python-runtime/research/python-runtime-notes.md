# Python 执行链排查记录（2026-11-27）

## 现象

客户 Windows 客户端（0.5.18）日志：

```
07:27:44 info 平台登录成功 {"account":"z***1","source":"panel","remember":true}
07:28:09 error 下发失败 {"businessId":"72769","message":"spawn python EACCES","code":-32603}
07:32:22 error 下发失败 {"businessId":"72769","message":"spawn python EACCES","code":-32603}
07:33:06 error 下发失败 {"businessId":"72769","message":"spawn python EACCES","code":-32603}
```

- `code: -32603` 是插件 RPC 的 `INTERNAL_ERROR`（`packages/server/plugins/protocol.js:29`），不是业务错误码。
- 登录、平台取数、预览都成功，失败发生在「创建本地 Trellis 任务」这一步。

## 调用链

```
plugins/witops-core/dispatch.js:1001        记录「下发失败」
  → packages/server/plugins/task-service.js:153   actions.createTask(...)
    → packages/server/actions.js:225              runTaskPython(repo.path, args)
      → packages/server/actions.js:126            spawn(command, [task.py, ...])
```

`runTaskPython` 的候选来自 `packages/server/python.js:8-11`：`['python', 'python3']`（或 `TRELLIS_PYTHON`）。

关键缺陷在 `packages/server/actions.js:143`：

```js
if (error.code === 'ENOENT' && index + 1 < candidates.length) { ... }
```

只有 **ENOENT** 才换下一个候选；**EACCES 直接 reject**。所以本次错误里 `python3` 从未被尝试。

## 为什么启动环境检查能过、真正执行却失败

两条路径用的解析方式不同：

| 路径 | 解析方式 | 结果 |
| --- | --- | --- |
| 启动自检（Rust） | `client.json` flag → `TRELLIS_PYTHON` → fresh `where.exe python.exe` → 静态 PATH → 常见安装目录 → `py -3`；每一步都要求 `is_usable_file`（文件、非目录、大小 > 0）并实际跑一次版本 | 跳过 0 字节的 Windows Store 别名，找到真实 `python.exe`，写回 `client.json`，环境门通过 |
| 插件宿主执行（Node） | 直接 `spawn('python')`，交给 Windows PATH 解析 | 若 PATH 首位是 `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`（0 字节 App Execution Alias）或 ACL 拒绝的文件，`CreateProcessW` 返回 `ERROR_ACCESS_DENIED` → Node 报 `spawn python EACCES` |

证据：

- `packages/desktop/src-tauri/src/agent/env/probe.rs:325-334` 已写明「0 字节文件是 Windows App Execution Alias……执行不了」，`is_usable_file` 专门过滤。
- `packages/desktop/src-tauri/src/agent/env/probe.rs:734-800` 的 `resolve_python` 会逐候选跑 `python -V`，别名候选失败后继续。
- `packages/desktop/src-tauri/src/agent/task_command.rs:931-939` 的 `recorded_python()` 读取 flag，但只被 Rust 自己的 `run_task_python` 使用；**插件宿主（`packages/desktop/plugin-host/host.mjs`）从未读取它**。
- `plugins/` 是独立 git 仓库（`git -C plugins`），插件改动需单独提交。

## Linux 上可复现的等价场景

PATH 首位放一个 0644（无执行权限）的 `python` 文件，第二候选 `python3` 可用：

- `spawn('python')` → `EACCES`
- 现有代码立即失败；期望回退到 `python3` 并成功建任务

该场景可以在 CI 里稳定复现 Windows 的「找到了但执行不了」语义，不需要 Windows 机器。

## 修复约束

- 启动自检已是现有行为（`LoginApp` 挂载时调用 `runtime_status`），本次不引入自动下载安装；环境不 ready 时继续用现有环境门，由用户点击初始化。
- 不新增 Node 侧 Python 版本门槛，保持现状（Rust 侧门槛不变）。
- 候选全失败的错误消息要能直接指导用户，且插件面板只需展示第一行即可读。
