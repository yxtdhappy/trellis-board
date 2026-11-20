# E2E 验证报告：待归属任务直接指定分支归属

## 环境

- 客户端：Trellis Board 0.4.56 便携版（Windows）
- 服务端：`http://10.126.126.1:4317`，已更新到 `v0.4.56` 并重启
- 本机 agent：`yuhaojie`（`DESKTOP-AC42130`），绑定任务空间 `3536a478-...` / 分支 `main`
- 数据库：启动后自动执行 schema v18，`sync_task_ownership_inbox` 已包含负责人列
- CI：tag `v0.4.56` 构建成功（含 `cargo test`、桌面打包、便携包校验）

## 前置与测试夹具

单分支项目里，空 `branch` 的任务会被客户端自动推断为 `main`，不会停留在待归属列表。因此使用本机 agent 凭证调用
`PUT /api/agent/task-spaces/{id}/ownership-inbox` 注入一条测试待归属记录：

- 任务：`.trellis/tasks/11-20-e2e-ownership-inbox`
- 负责人：`yuhaojie`
- 原因：`TASK_OWNERSHIP_REQUIRED`
- 响应：HTTP 200，`{"upserts":1,"deletes":0,"changed":true}`

## 步骤与结果

| 步骤 | 预期 | 结果 |
| --- | --- | --- |
| 刷新看板 | 待归属面板出现 E2E 任务，显示负责人 `yuhaojie` | 通过（用户确认） |
| 点击「归属分支」→ 选择 `main` →「确认归属」 | 调用 `set_task_ownership`，写回并同步 | 通过（用户确认操作完成） |
| 操作后刷新面板 | 该条从待归属列表消失 | 通过（用户确认） |

## 本地核对

- `task.json.branch` = `main`，`assignee` = `yuhaojie`
- `live-cursors.json`：`ownershipPending` = 0，`pendingRejected` = 0
- `task-control-state.json`：任务在 revision 311 已 materialized，负责人 `4f1781c3-...`
- 客户端日志：操作期间无归属/上传错误；任务文件重写后增量校验正常
- 负向路径：日志持续输出 `跳过他人任务目录 ... owner=yhj localOwner=yuhaojie`，
  说明非负责人任务仍被客户端过滤，无法归属

## 结论

**通过。** 新 UI 的负责人门禁、分支选择、`set_task_ownership` 写入、pending 清理与 inbox 条目消失
均按预期工作；服务端 schema v18 与负责人解析正常。

## 观察 / 后续

1. 单分支项目中，空 `branch` 会被自动推断，正常业务下很难产生待归属项；本功能的实际价值主要在
   多分支歧义、历史残留 inbox 记录，以及负责人本机已落地但 pending 已清空的场景。
2. 原始问题任务 `11-20-onboarding-push-gitignore-developer` 的负责人是 `yhj`，按产品规则本机
   `yuhaojie` 不能归属；应由 `yhj` 先改派给 `yuhaojie`。
3. 临时 E2E 任务目录已从本机删除；若服务端仍保留该任务，可在看板归档/删除。
