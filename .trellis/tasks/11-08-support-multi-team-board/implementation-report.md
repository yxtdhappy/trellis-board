# 实施报告

## 结论

多团队任务看板已完成代码实施。登录不再选择或固定活动团队；任务、项目、保存视图、WIP、管理台和 Agent 授权均按服务端实时团队成员关系执行。默认看板展示全部授权团队，团队筛选只改变展示范围。

## 后端

- Session/runtime 移除活动团队授权语义，返回全部 active `teams`；`activeTeamId`、`activeTeam`、`teamRole` 仅保留为 `null` 兼容字段。
- `/api/tasks/query` 支持 `teamId=all|teamId`，任务行返回 `teamId`、`teamName`；ETag、缓存键和游标绑定包含实际团队作用域与可读项目集合。
- 项目、任务、保存视图和 WIP 均实时校验团队成员关系；成员移除后项目集合变化，旧游标返回 `CURSOR_INVALID`。
- 保存视图和 WIP 使用三套独立作用域：全局、团队 A、团队 B；移除团队成员时清理该团队作用域并保留全局数据。
- 管理台项目、用户、Agent、审计和项目接入使用显式管理团队范围。系统管理员筛选用户时保留完整 `user.teams`，避免编辑账号误删其他团队关系。
- 系统管理员不需要 `team_member` 记录即可跨 active 团队使用项目和 Agent，但不能访问已停用团队。
- 桌面设备注册返回兼容 `teamId=null` 和全部可用 `teams`；同一设备可跨团队建立项目绑定，按团队撤销只影响目标团队。

## 前端

- `BoardFilters` 增加 `teamId`；`TeamSwitcher` 改为受控筛选器，不再提交 Session 或刷新页面。
- 团队切换时清空任务页、分页游标、ETag、保存视图和 WIP，并用请求序号丢弃迟到响应。
- 团队模式独立读取 `/api/saved-views?teamId=` 与 `/api/board/settings?teamId=`。
- 项目栏、项目筛选和任务查询跟随当前团队；任务卡片、注意力队列、团队视角和详情显示 `teamName`。
- 管理台增加独立 `adminTeamId`，项目选项合并团队管理员项目与跨团队项目负责人项目。
- Windows 桌面 workspace 初始化增加团队选择；普通 Agent 配置保存 `teams[]`，顶层 `teamId` 保持兼容为 `null`。

## 兼容与数据库

- 未新增数据库 schema 或迁移。
- 继续使用 `saved_view.team_id=NULL` 表示全局视图、团队 ID 表示团队视图。
- 继续使用 `user_board_state.team_id=''` 表示全局 WIP、团队 ID 表示团队 WIP。
- `user_session.active_team_id` 保留为废弃列但不参与授权。

## 验证

- `npm test -- --test-concurrency=1`：334 通过、5 跳过、0 失败。
- `npm run build`：通过，包含 `tsc -b` 与 Vite 构建。
- `git diff --check`：通过。
- 聚焦覆盖双团队查询、A/B/all 偏好隔离、成员移除、设备跨团队绑定、按团队撤销、系统管理员 Agent 路径和前端查询参数。

## 未执行

- 未重启现有 Board 服务，未执行真实浏览器 E2E。
- 本机没有 `cargo`，桌面 Tauri Rust 改动未做 `cargo check`。
- 未提交、未推送、未部署。
