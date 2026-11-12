# 实施报告

## 实施结果

- `list_local_associations` 现在从 `live-cursors.json` 读取当前 taskSpace 的 `deferred` 目录，返回 `deferredCount` 和 `deferredTaskDirs`。
- 项目栏在 `ready + deferredCount>0` 时显示“N 个本地任务未同步”，不再误报“同步正常”。
- 可写关联分支提供上传按钮，用户确认后通过新 Tauri command 和 sidecar `live-sync-deferred` 命令补传。
- 补传复用现有按 taskSpace 串行队列、文件级 CAS、pending batch、限流、冲突事件和 `_pull()`。
- 只读 binding 在 Agent 层拒绝补传；网络失败会向 Tauri/UI 抛出错误，不再被同步队列吞掉。
- 多 taskSpace 展示范围增加“按分支独立统计”提示，不跨分支合并任务。
- 后端与前端同步规范已回写。

## 主要文件

- `agent/task-snapshot-sync.js`
- `desktop/sidecar/desktop-device.js`
- `desktop/sidecar/main.js`
- `desktop/src-tauri/src/sidecar.rs`
- `desktop/src-tauri/src/main.rs`
- `desktop/src-tauri/permissions/desktop.toml`
- `desktop/src-tauri/capabilities/board-local-association.json`
- `web/src/components/layout/ProjectRail.tsx`
- `web/src/lib/project-rail-association.js`
- `web/src/lib/project-rail-association.d.ts`

## 验证

- `npm test`：479 通过、0 失败、4 跳过。
- `node --test agent/test/task-snapshot-sync.test.js`：33 通过。
- 桌面关联、权限、Tauri 契约和项目栏聚合定向测试：38 通过。
- `npm --prefix web run build`：通过。
- 本任务相关文件 `oxfmt --check`：通过。
- `git diff --check`：通过。

## 未执行

- 当前环境没有 `cargo`/`rustc`，未执行 Rust 单测、Tauri 安装包构建和真实 Windows WebView2 交互验收。
- 仓库级 `npm run format:check` 仍有 10 个与本任务无关的既有格式问题，未修改这些文件。
- 未提交、未推送、未归档。
