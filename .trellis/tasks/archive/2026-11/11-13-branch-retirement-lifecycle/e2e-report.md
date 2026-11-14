# E2E 验收报告

## 真实服务拓扑

| 项 | 值 |
| --- | --- |
| 模式 | Team |
| 地址 | `http://127.0.0.1:4317` |
| 服务进程 | Node PID `38092`，启动于 `2026-11-13T20:06:55.9649471+08:00` |
| 健康检查 | `/api/health` 返回 `status=ok`、`mode=team`、PID `38092` |
| 数据 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`，schema v12 |
| 浏览器 | Chrome DevTools MCP `1.13.0` 控制独立 headless Chrome，真实打开 `/login.html`、`/admin.html` |
| 日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.log`，每次操作前后读取增量 |

本轮直接验证用户重新启动的真实服务，没有另起临时 Team 服务。测试数据统一使用 `E2E` 前缀，结束后已清理。

## 测试数据

- 临时系统管理员：`E2E_` 前缀账号，测试后删除。
- 主项目：`E2E 分支生命周期真实验收`。
- 主项目分支：`E2E/branch-main`、`E2E/branch-retire`、`E2E/branch-purge`、`E2E/branch-disabled`。
- 对照项目：`E2E 分支生命周期对照` / `E2E/control-main`。
- `E2E/branch-purge` 包含 2 个未归档任务、4 个文件、1 个 approved binding、1 个在线监听、1 个 pending conflict 和 1 个 active command。
- `E2E/branch-disabled` 保持 `status=disabled`、`retired_at=null`，用于验证历史技术停用语义不被误当成弃用。

## 逐步证据

| # | 页面操作 / 请求 | 接口、数据库与日志证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 登录后进入 `/admin.html`，选择主项目 | 页面出现“分支管理”；显示正常分支 3、技术停用 1；每个分支展示任务数、文件数、监听数、最后活动 | 通过 |
| 2 | 对 `E2E/branch-retire` 点击“弃用” | 弹层展示任务 1、文件 2、监听 0、已关联 1、未归档任务“E2E 待弃用任务” | 通过 |
| 3 | 填写原因并确认弃用 | 管理台出现“已弃用分支 1”，状态 `retired`，原因“E2E 验收：历史功能结束”；项目审计新增弃用成功 | 通过 |
| 4 | 读取 `/api/team/status` 与管理分支接口 | 两者均返回 200；普通状态列表不含该分支；管理接口仍返回 `lifecycleStatus=retired`、任务 1、binding 1 | 通过 |
| 5 | 点击“恢复分支”并确认 | 普通确认框提示“恢复后旧客户端监听不会自动恢复”；页面回到正常分支，弃用分组和原因消失 | 通过 |
| 6 | 再次读取 `/api/team/status` 与管理分支接口 | 普通列表重新出现该分支；管理状态恢复为 `active`、`retiredReason=null` | 通过 |
| 7 | 使用错误确认名调用移除接口 | HTTP `400 INVALID_INPUT`，文案“分支确认名称不匹配”；随后查询该分支仍存在，任务 2、binding 1、在线监听 1 | 通过 |
| 8 | 对 active 的 `E2E/branch-purge` 点击“移除分支” | 第一次确认显示任务 2、文件 4、监听 `1/1`、已关联 1、未归档 2，并列出两个任务名称 | 通过 |
| 9 | 点击“继续确认” | 第二次确认要求输入完整分支名 `E2E/branch-purge`，最终按钮在未输入时禁用 | 通过 |
| 10 | 输入完整分支名并确认移除 | 页面刷新后该分支消失；主分支与 `E2E/branch-disabled` 保留；项目审计新增“移除分支”成功 | 通过 |
| 11 | 查询真实 SQLite | taskSpace 行已消失；`sync_agent_binding`、`sync_agent_cursor`、`sync_task_index`、`sync_task_index_tag`、`sync_task_space_file`、`sync_task_command`、`sync_conflict`、`sync_conflict_backup`、`sync_file_audit`、`sync_task_assignment`、`sync_task_space_batch`、`sync_task_space_scan_cache` 的探针计数均为 0 | 通过 |
| 12 | 检查清除审计与备份 | `task_space_purged` 为 success；审计记录 `taskCount=2`、`fileCount=4`、`approvedBindingCount=1`、`onlineListenerCount=1`、`pendingConflictCount=1`、`activeCommandCount=1`；备份文件存在且大小 `51,847,168` 字节 | 通过 |
| 13 | 移除后发送监听心跳 | HTTP 200；目标 taskSpace 返回 `BINDING_UNKNOWN` / “当前设备尚未接入该任务空间” | 通过 |
| 14 | 检查同项目其他分支、对照项目与历史 `disabled` | `E2E/branch-main`、`E2E/branch-retire` 仍为 active；对照项目 `E2E/control-main` 仍为 active；`E2E/branch-disabled` 仍为 `disabled` 且 `retired_at=null` | 通过 |

## 日志结论

- 每一步前记录日志字节偏移，操作后读取同一真实 `server.log` 的增量。
- 成功的管理 GET/POST/DELETE 不逐条写业务日志，因此以页面状态、HTTP 响应、SQLite 和审计记录为主证据。
- 本轮增量没有 `ERROR`、未捕获异常堆栈或部分删除。
- 删除后关闭辅助浏览器连接时出现一条 `read ECONNRESET` WARN；对应连接已结束，后续健康检查仍为 `status=ok`，属于连接关闭噪音，不是业务失败。
- 错误确认请求由服务端受控返回 `400 INVALID_INPUT`，没有产生部分删除。

## 清理记录

- `E2E` 临时管理员、项目、分支、任务、Agent、绑定、审计记录和本次删除备份均已删除。
- 数据库恢复到测试前基线：用户 4、团队 1、项目 5、taskSpace 7。
- 临时密码文件已删除，未写入报告、日志或提交。
- Chrome DevTools MCP 停止连接其独立 headless Chrome；未关闭用户原有 Ego 浏览器。
- 清理完成后的第一次健康检查仍返回 `status=ok`、`mode=team`、PID `38092`。
- 最终收尾核对时 PID `38092` 和 `4317` 监听均已消失；日志没有关闭、ERROR 或异常堆栈，无法区分是用户主动停止还是终端随父进程退出。本次没有擅自重启真实服务。

## 构建与自动测试

合并 `origin/main` 后：

- `npm test`：467 项，466 通过、1 跳过、0 失败。
- `npm run build`：通过。
- `npm run build:desktop`：通过。
- Web lint、边界检查通过。
- 服务端生命周期、权限、heartbeat、迁移、备份失败和级联删除均有自动测试。

## 未验证项

- 未启动真实 Tauri 桌面客户端验证删除瞬间 watcher 停止、本地关联失效和待解绑展示。
- 未验证真实桌面客户端 60 秒心跳超时窗口。
