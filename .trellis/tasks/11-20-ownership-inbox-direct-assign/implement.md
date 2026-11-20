# 实施计划：待归属任务支持从看板直接指定分支归属

## 0. 前置确认

- [ ] 需求评审：负责人专属权限、只改工作区、不做跨端派发（见 `prd.md`）。
- [ ] 阅读 `implement.jsonl` 中的规范，重点确认任务归属门禁与 Tauri 命令边界。
- [ ] 确认 `set_task_ownership` 的现有行为：任务必须在本机 `local_groups` 中，非负责人会被过滤。

## 1. 服务端

- [ ] 新增 `packages/server/database-sql/v18.js`：
  - `ALTER TABLE sync_task_ownership_inbox ADD COLUMN assignee_user_id TEXT;`
  - `ALTER TABLE sync_task_ownership_inbox ADD COLUMN assignee_dev_id TEXT;`
  - 注意 SQLite 重复执行时用 `hasColumn()` 守卫。
- [ ] `packages/server/database-sql/index.js`：导出 `SCHEMA_V18_SQL`，`DATABASE_SCHEMA_VERSION` 改为 18。
- [ ] `packages/server/database-migrations.js`：新增 `ensureV18Schema`；`database.js` 启动流程调用。
- [ ] `packages/server/team/task-ownership-inbox.js`：
  - `normalizeUpsert` 接受可选 `assigneeDevId`（trim、长度 ≤ 120、无控制字符）。
  - upsert 时通过 `sync_project_member.trellis_dev_id` 解析 `assignee_user_id`（大小写不敏感），解析不到存 NULL。
  - `list` 返回 `taskSpaceId`、`assigneeUserId`、`assigneeDevId`。
- [ ] `packages/server/test/task-ownership-inbox.test.js`：
  - 上报带 `assigneeDevId` 且成员存在 → list 返回 userId；
  - 未知 dev id → `assigneeUserId=null`；
  - 旧 payload 缺字段 → 兼容。

**检查点 A（评审 gate）**：服务端契约与迁移评审通过后再动前端。

## 2. 桌面客户端

- [ ] `packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs`：
  - `sync_ownership_inbox` 的 upserts 增加 `assigneeDevId`：取 `task_owner(group)`（已有 helper，按 assignee→creator 顺序）。
  - 为空时不发送该字段。
- [ ] 确认无需新增 Tauri 命令；若实施中发现 `set_task_ownership` 的候选过滤确实阻断了任务，再回到设计评审，不在实现中临时加绕过。
- [ ] `packages/desktop/src-tauri/src/agent/task_sync/tests/ownership_inbox.rs`（或现有测试文件）：
  - 断言 upsert payload 含 `assigneeDevId`；
  - 缺失 assignee 时不发送该键。

## 3. 前端

- [ ] `packages/web/src/lib/ownership-inbox.js`：
  - `normalizeItem` 增加 `taskSpaceId`、`assigneeUserId`、`assigneeDevId`。
- [ ] `packages/web/src/features/board/OwnershipInboxPanel.tsx`：
  - 增加 `currentUserId`、`canInvoke`、`taskSpaces`（或按 project 取）与 `onAssigned` 回调。
  - 每条 item 渲染「归属」按钮与分支选择：
    - `assigneeUserId !== currentUserId` → 禁用 + 「仅任务负责人可操作」；
    - 负责人未知 → 禁用 + 「负责人未知，等待重新同步」；
    - 无对应本地关联 / 非 Tauri → 禁用 + 「请在本机关联该分支后操作」。
  - 提交中禁用；调用 `invoke('set_task_ownership', {...})`；捕获错误映射为可读文案。
- [ ] `packages/web/src/pages/board/BoardPage.tsx`：
  - 传入 `runtime.user.id`；
  - 归属成功后刷新 inbox 与项目关联状态。
- [ ] `packages/web/test/ownership-inbox.test.js`：新字段归一化。
- [ ] 新增/扩展组件测试：三种按钮状态 + 成功调用参数 + 错误展示。

## 4. 验证

- [ ] `yarn format:check`
- [ ] `yarn test`
- [ ] `yarn workspace @trellis-board/web lint`
- [ ] `yarn build`（tsc + vite）
- [ ] `yarn workspace @trellis-board/desktop test`（cargo test）
- [ ] 手动验收：
  1. 用负责人账号（本机 developer 与任务 assignee 一致）复现「本地 pending 为空、inbox 有记录」；
  2. 点击归属 → 选择 `main` → 成功 toast；
  3. 确认 `task.json.branch=main`、客户端上传成功、inbox 行消失；
  4. 用非负责人账号确认按钮禁用，且直接调用 `set_task_ownership` 也失败。

**检查点 B（评审 gate）**：全量测试通过、手动验收完成后再考虑提交。

## 5. 回滚点

- 服务端：回退 v18 迁移代码；已加的可空列不影响旧逻辑。
- 前端：回退面板改动即恢复只读展示。
- 客户端：回退 upsert 字段；服务端兼容缺失字段。
- 单独一层失败时不需要同时回滚其他层。

## 6. 风险

| 风险 | 缓解 |
| --- | --- |
| 旧 inbox 行没有 `assigneeUserId`，按钮全部禁用 | 来源客户端下次同步会重新 upsert；文案提示等待同步 |
| `set_task_ownership` 对空 branch 任务的候选判定与对话框不一致 | 直接调用命令，不依赖候选列表；测试覆盖 |
| 选择非当前 binding 的分支只记录归属、不上传 | 与现有对话框语义一致；UI 默认来源分支并说明 |
| 负责人映射大小写/别名不一致 | 与服务端 `readMemberByDev` 保持同一解析规则 |
