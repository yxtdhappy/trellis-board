# 迁移看板持久化到 SQLite

## Goal

将 Trellis Board 自身的可变持久化数据统一迁移到 Node 内置 SQLite，同时继续以各仓库的 `.trellis/tasks/**` 作为任务流程事实来源。

## Background

当前看板把不同类别的状态分散在以下文件中：

- `data/repos.json`：项目白名单
- `data/task-metadata.json`：人工流程检查点
- `data/scan-cache.json`：可重建的扫描缓存
- `data/board-state.json`：刷新和监听状态

这些数据由主服务线程和扫描 Worker 共同读取，后续还要增加审计、依赖、评论、保存视图和流程指标。继续拆分多个 JSON 文件会产生全量重写、跨文件一致性、查询和并发问题。

## Requirements

- 使用 Node 内置 `node:sqlite`，不引入第三方运行时依赖。
- 运行时创建并维护 `data/board.sqlite`。
- 将项目白名单、人工流程检查点、扫描缓存和看板刷新状态持久化到 SQLite。
- 首次打开数据库时，以幂等迁移方式导入已有 JSON 数据。
- 迁移完成后，运行时不再写入上述 JSON 文件。
- 保留旧 JSON 文件作为迁移来源和回滚备份，不自动删除或覆盖。
- 项目新增、批量新增和删除必须使用 SQLite 事务；失败时不得留下部分数据。
- 人工流程检查点必须持久化，并在服务重启和工作线程扫描后保持可见。
- 扫描缓存必须保留 `SCAN_SCHEMA_VERSION` 语义；版本不匹配时视为无缓存。
- 现有 HTTP API、前端字段和页面行为保持不变。
- 继续将各仓库 `.trellis/tasks/**`、`task.json` 和流程产物作为任务事实来源，不复制成 SQLite 中的第二套任务真值。
- 项目最低 Node 版本调整为支持稳定内置 SQLite 的 Node 24。

## Out of Scope

- 不新增操作审计、依赖、评论、截止日期、标签或周期指标功能。
- 不迁移或改写任何被扫描仓库中的 Trellis 任务文件。
- 不增加用户认证、权限、远程仓库 Agent 或 PostgreSQL。
- 不删除现有 JSON 文件。

## Acceptance Criteria

- [x] 新环境首次启动会在 `data/board.sqlite` 建立带版本号的 schema。
- [x] 已有 `data/repos.json` 中的项目会迁移到数据库，迁移后新增、删除项目只修改数据库。
- [x] 已有 `data/task-metadata.json` 中的人工阶段会迁移，更新后服务重启仍能读取。
- [x] 已有 `data/scan-cache.json` 在 schema 版本匹配时会迁移并可被 `/api/board` 作为缓存读取。
- [x] 已有 `data/board-state.json` 会迁移，刷新状态接口仍返回原有字段。
- [x] 同一数据库重复初始化不会重复导入项目、检查点或缓存。
- [x] 用户清空项目白名单后，下一次启动不会因为 fallback 配置而自动把默认项目加回来。
- [x] 非法或损坏的旧 JSON 不会阻止数据库启动；迁移会跳过该文件并保留原文件。
- [x] 项目批量新增中任一目录无效时，数据库不会写入该批次任何项目。
- [x] `npm test` 全部通过，新增测试覆盖 schema 初始化、迁移幂等、事务回滚、项目持久化、人工阶段持久化和缓存/状态读写。
- [x] 通过 PowerShell 遍历 `server/` 和 `public/` 下的全部 `.js` 文件，逐个执行 `node --check` 且全部通过。
- [x] README 明确说明 SQLite 数据路径、Node 24 要求、旧 JSON 的迁移/备份角色和回滚方式。
