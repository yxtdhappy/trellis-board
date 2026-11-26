# 生产页面项目移除接口验证报告

## 测试拓扑

- 页面：`http://spec-board.weintdata.cn/weint-spec-board/admin.html`
- API：同源 `/weint-spec-board/api/*`
- 生产版本：`0.5.16`
- 服务进程：PID `107`
- 服务启动时间：`2026-11-26T11:07:30.886Z`
- Jenkins 发布：`{devops}weint_weint-spec-board` build `#10`，提交
  `1f3943043e0e7ef00e0a9594c50f0c6e5c3227d4`

## 安全验证方式

本次未删除任何生产项目。使用管理员页面现有会话调用新增接口的非成功分支：

1. 不带会话调用真实项目的删除接口，预期在鉴权层拒绝。
2. 带管理员会话，但提交错误项目名称，预期在备份和删除前拒绝。
3. 带管理员会话，删除不存在的项目，预期返回 404。
4. 对比调用前后项目列表和 `project_purged` 审计数量，确认没有副作用。

## 验证结果

| # | 请求 | 响应 | 副作用复核 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/runtime` | HTTP 200，`systemAdmin=true` | 当前会话具备系统管理员能力 | ✅ |
| 2 | `DELETE /api/admin/projects/:id`，不带会话 | HTTP 401 `AUTH_REQUIRED`，`需要登录` | 项目未变化 | ✅ 预期拒绝 |
| 3 | `DELETE /api/admin/projects/:id`，管理员 + 错误项目名 | HTTP 400 `INVALID_INPUT`，`项目确认名称不匹配` | 项目未变化，无新增删除审计 | ✅ 预期拒绝 |
| 4 | `DELETE /api/admin/projects/:id`，管理员 + 不存在项目 | HTTP 404 `NOT_FOUND`，`项目不存在` | 项目未变化 | ✅ 预期拒绝 |
| 5 | `GET /api/admin/projects?teamId=...` 前后对比 | HTTP 200 | 项目 ID 集合完全一致，项目数均为 2 | ✅ 无数据变化 |
| 6 | `GET /api/admin/audit?teamId=...` 前后对比 | HTTP 200 | `project_purged` 数量前 0、后 0 | ✅ 无删除审计 |

浏览器控制台仅出现上述 401、400、404 对应的预期资源错误，没有未处理异常。

## UI 范围

生产管理页面“项目协作”仍显示成员、分支、团队访问、Agent 绑定和项目审计，没有
“删除项目/移除项目”按钮。这与本任务确认的“仅提供系统管理员服务端 API，不包含 Web 入口”一致。

## 未执行项

- 未在生产环境使用真实项目名执行成功删除，因为该操作不可恢复，会删除真实项目数据。
- 成功删除、备份、cascade、审计保留和项目隔离已完成本机 HTTP API E2E：
  `api-e2e-report.md`。
- 生产 Jenkins 和健康检查已完成，见发布记录和 `/api/health` 结果。
