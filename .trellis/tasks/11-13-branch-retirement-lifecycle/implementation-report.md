# 实施报告

## 结果

已完成 taskSpace 的弃用、恢复和安全物理移除生命周期。管理入口只在服务端 `/admin.html` 项目页，桌面客户端不增加管理操作。

## 实施内容

- SQLite schema 升至 v12，为 `sync_task_space` 增加 `retired_at`、`retired_by_user_id`、`retired_reason` 和查询索引。
- v10/v11 升级幂等补字段，历史 `disabled` 保持技术停用语义，不自动转为 retired。
- taskSpace 服务增加管理列表、弃用、恢复和物理移除；弃用保留数据，物理移除使用严格数据库备份和事务删除。
- 删除前收集任务、文件、监听、binding、冲突和活动命令摘要，写 `task_space_purged` 全局审计后删除聚合根。
- 普通项目列表、状态列表和任务归属候选排除 retired；管理接口保留全部状态。
- 修复快照和索引 Worker 可能把 retired/disabled taskSpace 改回 active/indexing 的竞态。
- Agent 心跳区分 retired、disabled 和已删除 binding；已删除监听 ID 不再导致整次心跳 400。
- 新增四个项目级管理 API：列表、弃用、恢复和删除；删除要求请求体中的分支名逐字符完全一致。
- 服务端管理台增加“分支管理”面板，按正常、技术停用、已弃用分组，展示任务、文件、监听、binding 和最后活动信息。
- 移除分支使用两阶段确认：先展示影响摘要，再要求输入完整分支名；失败保留弹层和输入。
- 同步更新 backend/frontend Trellis spec。

## 关键安全边界

- 项目负责人、团队管理员和系统管理员可执行生命周期操作；普通成员不能执行，普通视图也不能看到 retired。
- 在线监听、approved binding 和未归档任务不阻塞删除，但会出现在确认摘要和审计中。
- 数据库备份失败时中止删除。
- 不删除真实 Git 分支，不清理客户端本地 `.trellis/tasks`。
- 删除只作用于指定项目内的指定 taskSpace，外键级联清理关联 Board 数据。

## 代码验证

- 合并 `origin/main` 后 `npm test`：467 项，466 通过、1 跳过、0 失败。
- `npm run build`：通过；仅有既有大于 500 kB 的 chunk warning。
- `npm run build:desktop`：通过；仅有既有 `theme-init.js` 非 module 提示。
- `git diff --check`：通过。
- Web TypeScript 类型检查通过。
- Web lint 通过，无新增 error；保留仓库既有 warning。

## 状态

代码与任务文档已在独立 worktree 完成；本次交付将在独立分支提交后合并到 `main` 并推送远端，任务本身不归档。
