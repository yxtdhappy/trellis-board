# 实施计划

## 1. 客户端状态读取

- [x] 扩展 `desktop/sidecar/desktop-device.js` 的 `readLocalAssociations()`，读取可选 `live-cursors.json` 并返回 `deferredCount`、`deferredTaskDirs`。
- [x] 对损坏或缺失的游标文件保持关联列表可用；不返回本地绝对路径。
- [x] 在 `desktop/src-tauri/src/sidecar.rs` 扩展 `LocalAssociation`，新字段使用 serde default。

## 2. 补同步命令

- [x] 在 `agent/task-snapshot-sync.js` 增加 deferred 任务的上传入口，复用 `_enqueue()`、`_uploadDirectories()`、`_pull()` 和现有冲突处理。
- [x] 在 `desktop/sidecar/main.js` 增加 `live-sync-deferred --task-space <id>` 命令。
- [x] 在 `desktop/src-tauri/src/sidecar.rs` 和 `main.rs` 增加 Tauri command，参数仅允许任务空间 ID。
- [x] 更新 `desktop/src-tauri/permissions/desktop.toml` 和 `capabilities/board-local-association.json`。

## 3. 前端状态与操作

- [x] 扩展 `web/src/components/layout/ProjectRail.tsx` 的 association DTO 归一化和状态文案。
- [x] 调整 `web/src/lib/project-rail-association.js` 的聚合优先级，deferred 位于 syncing 与 pending 之间。
- [x] 在可写 deferred 分支行增加确认后的补同步按钮、loading、成功/失败/冲突提示。
- [x] 多 taskSpace 展示范围增加“按分支独立统计”说明，不改变现有任务身份和计数。

## 4. 测试

- [x] `tests/desktop-association.test.js`：有/无 deferred、坏游标、目录字段。
- [x] `agent/test/task-snapshot-sync.test.js`：补传成功后清理 deferred；冲突停止且保留状态。
- [x] `tests/project-rail-association.test.js`：deferred 聚合优先级和普通 ready 状态。
- [x] `desktop/src-tauri/src/sidecar.rs` 单测：旧 DTO 缺字段兼容。
- [x] `tests/desktop-package.test.js`：新 Tauri permission、capability、command 注册和 sidecar 参数。

## 5. 验证顺序

开发期间不执行构建；所有开发改动完成后统一执行一次：

1. 相关 Node 定向测试。
2. `npm test`。
3. `npm --prefix web run build`。
4. `npm run format:check`，仅在必要时执行一次格式化。
5. 有可用桌面环境时，验收“safe 产生 deferred -> 状态可见 -> 确认补传 -> main 出现任务 -> 状态恢复”。

## 6. 回滚点

- 第一阶段只增加可选 DTO 字段，可独立回滚，不影响同步。
- 第二阶段新增 Tauri command 和 permission，回滚时先移除 UI 入口再移除命令。
- 第三阶段不触碰服务端 schema 和任务正文，数据回滚不需要迁移。
