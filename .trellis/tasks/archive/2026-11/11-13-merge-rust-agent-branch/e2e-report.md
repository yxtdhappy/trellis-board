# 合并 Rust 单文件客户端分支 E2E 报告

## 0. 测试拓扑

| 层 | 实际对象 | 说明 |
| --- | --- | --- |
| 真实服务端 | `node apps/server/index.js`，临时端口（末次运行 `127.0.0.1:51499`） | `TRELLIS_BOARD_MODE=team`、`TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=1`、隔离 `TRELLIS_BOARD_DATA_DIR`（位于源码工作树之外，符合服务端自检） |
| 服务端数据 | 隔离 SQLite `board.sqlite` | 通过 `createUser` / `createTeam` / `setUserTeams` 预置管理员 `e2e-admin` 与团队 |
| 客户端 Agent | 合并后 Rust 代码（`agent::{device, association, task_sync}`，进程内） | 使用 `ConfigStore`（隔离 `TRELLIS_DESKTOP_HOME`）与真实 DPAPI 凭证文件 |
| 本地仓库 | 临时 Git 仓库 + `file:///` 裸远端 | `main` 分支，`.trellis/tasks/01-01-e2e/{task.json,prd.md}` |
| 证据 | 本文档与下方哈希 | 临时编排脚本与仓库在验证后已删除 |

编排方式：临时 Node 脚本预置数据库、启动真实服务端、再以 `cargo test --ignored` 运行临时 `#[cfg(test)]`
端到端用例；用例结束后脚本直接读取服务端 SQLite 校验落库结果。验证完成后临时脚本、用例与数据目录全部删除。

## 1. 全链路步骤与证据

| # | 客户端动作 | 服务端 / 本地证据 | 结论 |
| --- | --- | --- | --- |
| 1 | `device::login_desktop`（`/api/auth/login` → `/api/runtime` → 设备注册） | 用例输出 `E2E 登录成功 username=Some("e2e-admin")`；服务端 `agent_device` 出现 `e2e-device / active` | ✅ 登录与设备注册 |
| 2 | `association::associate_desktop_project`（本地 Git 预检 → `/api/agent/task-spaces/preflight` → `attach`） | 输出 `taskSpace=<uuid> status=Some("approved")`；服务端 `sync_agent_binding` 为 `approved`、`branch_name=main` | ✅ 关联即时批准 |
| 3 | `TaskSync::sync_task_directories` 上传本地任务 | 输出 `revision:1`，`baselineFiles` 两项；服务端 `sync_task_space.revision=1`、`sync_task_space_file` 两行、`sync_task_index` 一行（标题 `E2E 任务`，分支 `main`） | ✅ 客户端 → 服务端 |
| 4 | 删除本地任务目录与 `live-cursors.json`，再 `resolve_initial_sync(safe)` | 输出 `{"downloaded":1,"mode":"safe","revision":1,"skipped":0}`；本地 `prd.md` 被重新写回 | ✅ 服务端 → 客户端 |
| 5 | 内容一致性 | 本地还原文件 `sha256=4f1a4c0f29e05d3b9402264110be8d7ef39b4fc418119c1ecf41096b925c827e`，与服务端 `sync_task_space_file` 中同路径行完全一致 | ✅ 内容未被改写 |

`cargo test` 结果：`test result: ok. 1 passed; 0 failed; 0 ignored; 90 filtered out`。

## 2. 结论

- 合并后的 Rust Agent 能与当前服务端完成 **登录 → 设备注册 → 项目预检 → 关联（approved）→ 任务上传 → 服务端快照下载** 全流程，
  双向文件哈希一致，说明 12 个冲突的人工解决没有破坏 Agent 协议或数据落库结构。
- 服务端 `sync_task_space_file`、`sync_task_space`、`sync_task_index`、`sync_agent_binding`、`agent_device`
  五张表的实际写入结果与客户端返回一致，排除了“客户端自说自话”的可能。

## 3. 单 EXE 打包与启动冒烟

`cargo tauri` 本机未安装（CI 通过 `tauri build` 生成 NSIS 安装包），因此本地用等价的
`cargo build --release` 产出客户端可执行体，再走仓库自带的 `package-portable.ps1` 组装绿色包：

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `cargo build --release`（`apps/desktop/src-tauri`） | `Finished \`release\` profile [optimized] target(s) in 2m 43s`；`target/release/trellis-board-client.exe` 7,910,400 字节 |
| 2 | `pwsh -File apps/desktop/package-portable.ps1` | 产出 `TrellisBoard_0.3.0_x64-portable.zip`（3,802,284 字节）与 `.zip.sha256`，zip SHA256 `0eb934f7c13c9f653ab71e3c3de8fd79ec26b81ebb148f3c1f47bd66ae263b75` |
| 3 | 解压到含中文路径的目录并按 `SHA256SUMS.txt` 逐文件校验 | 4 个文件齐全（`trellis-board-client.exe`、`VERSION.txt`、`SHA256SUMS.txt`、`使用说明.txt`），2 条清单全部匹配 |
| 4 | 以隔离 `TRELLIS_DESKTOP_HOME` 启动解压后的 EXE，6 秒后进程仍存活 | `alive=True pid=26096`；隔离目录自动生成 `agent/`、`logs/`，证明配置根解析与 Agent 初始化在打包产物中正常 |

打包过程发现并修复一处合并缺陷：`apps/desktop/package-portable.ps1` 的 `Test-PathWithin`
在合并后丢失了“路径与根相等”的分支（`main` 原有 `[string]::Equals(...)` 提前返回），导致默认输出目录
`target/release/bundle/portable` 被判为越界而必然失败。恢复相等判定后打包通过。

限制：NSIS 安装包未在本地构建（需要 `cargo tauri build` 与 NSIS 工具链，由 CI `windows.yml` 覆盖），
本次只验证绿色包。
