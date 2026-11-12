# E2E 验收报告

## 测试拓扑

| 层 | 地址 / 进程 | 说明 |
| --- | --- | --- |
| 客户端 | `trellis-board-client.exe` | 最新客户端；最终稳定运行状态见 `.runtime/e2e-final-restored-state.png` |
| 后端 | `http://127.0.0.1:4317`，`/api/health` | 团队模式；健康检查返回 200，PID 30892 |
| Agent | `trellis-agent.exe` | 最终单实例运行，事件流已连接 |
| 数据库 | `%LOCALAPPDATA%\TrellisBoard\server\board.sqlite` | 只读核对任务、分支和权限数据；探针写入后已清理 |

服务端成功 GET 不写普通请求日志。测试窗口内服务端日志无新增 ERROR/WARN，健康检查与页面查询均正常；后端拒绝和校验路径由聚焦测试覆盖。

## 逐步证据

| # | 页面操作 / 请求 | 对应后端或数据证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 选择“全部项目” | 页面显示 7 条进行中任务、5 个授权仓库，同时出现 `trellis-board` 与 `mdp-backend-service` | 通过 |
| 2 | 输入 ` DEV ` | 7 条收敛为 1 条 `dev` 分支任务，项目、团队和分支字段正确 | 通过 |
| 3 | 选择 `mdp-backend-service`，再选 `dev` taskSpace | 项目级和单 taskSpace 均只返回该分支任务 | 通过 |
| 4 | 临时双分支：`dev` 与 `e2e/cross-branch-probe-20261112` | 同项目显示两条同名任务；详情分别显示对应分支和任务路径 | 通过 |
| 5 | 团队视角“全部项目” | 显示 7/7 条任务，覆盖两个项目；输入 `DEV` 后为 1/1 | 通过 |
| 6 | 归档索引 `DEV` 与翻页 | 589 条匹配，第 1 页 1-20，第 2 页 21-40，页码 2/30 | 通过 |
| 7 | 清理临时探针 | `sync_task_space`、`sync_task_index`、`sync_task_space_file` 探针记录均为 0；活动任务恢复为 7 | 通过 |

## 自动验证

- `node --test tests/task-view-key.test.js tests/execution-filter.test.js tests/team-task-index-v10.test.js tests/team-gitless-http.test.js tests/team-web.test.js`
  - 37 个测试，37 通过，0 失败。
- `npm --prefix web run build`
  - TypeScript 与 Vite 构建通过；仅报告既有主 chunk 大于 500 kB 警告。

## 清理记录

- 临时分支 `e2e/cross-branch-probe-20261112` 及其 1 条任务索引、6 条任务文件记录已删除。
- 未修改真实任务文件、项目权限或团队关系。
- 测试截图保存在 `.runtime/e2e-*.png`，不属于运行时代码。

## 结论

全部验收项通过。唯一未做的是对成功 GET 的服务端请求级日志抓取，因为当前服务只记录启动和异常，不记录成功请求；本次用页面结果、数据库读回、健康检查和聚焦接口测试交叉验证。
