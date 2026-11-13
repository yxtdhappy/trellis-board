# E2E 验收报告

## 环境

| 项 | 值 |
| --- | --- |
| 模式 | Team |
| 地址 | `http://127.0.0.1:44317` |
| 服务进程 | Node PID `22448`，启动于 `2026-11-13T18:24:44+08:00` |
| 健康检查 | `/api/health` 返回 `status=ok`、`mode=team`、PID `22448` |
| 数据 | 独立临时 SQLite，schema v12 |
| 浏览器 | Ego Lite Chromium，真实 `/login.html`、`/admin.html` |
| 日志 | 临时数据目录 `logs/server.log`，每次操作读取增量；成功管理请求不逐条打印 |

临时服务、数据库、备份、日志和浏览器任务均在验收后清理；端口 `44317` 已关闭。

## 测试数据

- 团队：`E2E 分支生命周期团队`
- 主项目：`E2E 分支生命周期`
- 分支：`E2E/branch-main`、`E2E/branch-retire`、`E2E/branch-purge`、`E2E/branch-disabled`
- 对照项目：`E2E 对照项目` / `E2E/control-main`
- 数据包含未归档任务、归档任务、approved binding 和在线监听探针。

## 逐步证据

| # | 操作 | 响应、数据库或页面 | 结论 |
| --- | --- | --- | --- |
| 1 | 管理员登录并进入 `/admin.html` 项目页 | 页面出现“分支管理” | 通过 |
| 2 | 选择主项目并读取分支摘要 | 页面显示 3 个正常分支、1 个技术停用分支；任务、文件、监听和最后活动可见 | 通过 |
| 3 | 对 `E2E/branch-retire` 执行“弃用”，填写原因 | 弹层展示任务 1、文件 1、binding 1、未归档任务“待弃用任务” | 通过 |
| 4 | 确认弃用 | 页面出现“已弃用分支”和原因；管理 API 返回 `lifecycleStatus=retired` | 通过 |
| 5 | 查询 `/api/team/status` | 普通状态列表只含 disabled/main/purge，不含 retired | 通过 |
| 6 | 点击恢复并确认 | 页面回到正常分支，retired 分组和原因消失 | 通过 |
| 7 | 查询临时 SQLite | `E2E/branch-retire` 为 `active`，`retired_at=null` | 通过 |
| 8 | 使用错误确认名调用 DELETE | HTTP `400 INVALID_INPUT`，提示“分支确认名称不匹配” | 通过 |
| 9 | 错误确认后重新查询 | `E2E/branch-purge` 仍存在 | 通过 |
| 10 | 对 active 的 `E2E/branch-purge` 打开移除弹层 | 第一次确认显示任务 2、未归档 1、归档 1、binding 1；第二步要求输入完整分支名 | 通过 |
| 11 | 输入完整分支名并最终确认 | 页面移除该分支；main 和 disabled 保持可见 | 通过 |
| 12 | 查询临时 SQLite | taskSpace 行消失；binding、cursor、file、index、command、conflict、file_audit 计数全部为 0 | 通过 |
| 13 | 检查删除审计和备份 | `task_space_purged` 审计存在；备份 `board.sqlite.snapshot.20261113T103311178Z` 存在 | 通过 |
| 14 | 通过真实 Agent attach + heartbeat 创建在线探针 | 页面显示 `E2E/branch-online-purge`，监听 `1/1` | 通过 |
| 15 | 在线监听仍在时执行移除 | 删除成功；审计记录 `approvedBindingCount=1`、`onlineListenerCount=1` | 通过 |
| 16 | 检查在线分支级联数据 | binding、cursor、file、index、command、conflict、file_audit 全部为 0 | 通过 |
| 17 | 检查对照项目 | `E2E/control-main` 仍为 active | 通过 |
| 18 | 检查历史技术停用分支 | `E2E/branch-disabled` 仍存在，`status=disabled`，`retired_at=null` | 通过 |

## 日志结论

- 每个操作前后读取同一临时 `server.log` 的增量。
- 成功的管理 GET/POST/DELETE 不逐条写业务日志。
- 所有增量中没有 ERROR 或未捕获异常堆栈。
- 错误确认请求返回受控 `400 INVALID_INPUT`，没有产生部分删除。

## 构建与自动测试

- 合并 `origin/main` 后 `npm test`：467 项，466 通过、1 跳过、0 失败。
- `npm run build`：通过。
- `npm run build:desktop`：通过。
- 服务端生命周期、权限、heartbeat、迁移、备份失败和级联删除均有自动测试。

## 清理

- 临时 Team 服务已停止，端口 `44317` 无监听。
- 浏览器任务已 `finish`，未保留页面。
- 临时数据库、日志、备份、夹具脚本和截图目录已删除。
- 未修改真实 `4317` 服务或真实用户数据。

## 未验证项

- 未启动真实 Tauri 客户端验证删除瞬间 watcher 停止、本地关联失效和待解绑展示。
- 未验证真实桌面客户端 60 秒心跳超时窗口。
