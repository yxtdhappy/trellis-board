# 检查报告

## 结论

代码审查和自动化门禁通过。检查中发现并修复了系统管理员 Agent、管理台跨团队误删、团队切换竞态和停用团队访问等边界问题。

## Findings (fixed)

- 系统管理员可访问已停用团队：统一修正项目与任务授权，停用团队返回 `404`。
- 多团队管理员缺少 `teamId` 时隐式聚合：单管理团队自动落位；多管理团队缺省返回 `400`，仅显式 `teamId=all` 聚合。
- 系统管理员按团队筛选用户后，`user.teams` 被裁剪，编辑账号会静默删除其他团队关系：筛选只收窄列表，成员关系保持完整。
- 团队管理员 A + 其他团队项目负责人会丢失可管理项目：项目选项改为两组能力集合合并去重。
- 无 `team_member` 的系统管理员无法注册设备、兑换配对码、绑定项目、批准绑定、读写游标或订阅事件：相关实时查询支持系统管理员 active 团队。
- 前端快速切换团队时旧响应可能覆盖新作用域：任务和偏好请求增加请求序号，团队变化清空旧页、ETag、视图和 WIP。
- 团队切换后任务详情和 team-scoped 配对码可能残留：切换时关闭详情并清除旧团队凭证。
- 规范缺少多团队契约：已回写 backend、frontend 和 cross-layer 规范。

## Findings (not fixed)

- 本机没有 `cargo`，无法验证桌面 Rust 改动的编译。
- 未重启现有服务，未执行真实浏览器 E2E；前端只完成 TypeScript/Vite 构建验证。
- Windows 并行全量测试存在既有 ACP/workspace 临时目录句柄抖动；本轮串行全量测试全绿。
- 工作区中的 `design/trellis-board-redesign.pen`、`design/exports/`、`data/standalone-backup-20261108-142014/` 和 `.trellis/tasks/11-08-desktop-account-login/` 属于其他未完成改动，本次未纳入。

## Verification

- `npm test -- --test-concurrency=1`：334 通过、5 跳过、0 失败。
- `npm run build`：通过。
- `git diff --check`：通过。
- `python ./.trellis/scripts/task.py validate .trellis/tasks/11-08-support-multi-team-board`：通过。

## 剩余验收

- 双团队账号在真实页面默认显示全部团队、A/B/all 筛选以及保存视图/WIP 切换。
- 管理员移除团队成员后刷新页面，团队筛选项和任务消失。
- 桌面客户端在 Windows 上完成多团队 workspace 初始化和设备按团队撤销。
