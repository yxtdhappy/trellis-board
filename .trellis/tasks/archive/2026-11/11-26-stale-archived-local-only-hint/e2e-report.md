# 实机 E2E 验收报告：11-26-stale-archived-local-only-hint

## 1. 验收拓扑与版本证据

| 项 | 值 |
| --- | --- |
| 验收层级 | L3（真实隔离 Team 服务端 + 真实自构建 Tauri 客户端 + WebView2 CDP） |
| Git HEAD | `611673f` + 本任务工作区改动（未提交） |
| 服务端进程 | `node packages/server/index.js`，PID `37440`，`serverStartedAt: 2026-11-26T10:20:55.823Z`，端口 `4467`（`http://127.0.0.1:4467/weint-spec-board`） |
| 客户端进程 | 自构建 `packages/desktop/src-tauri/target/debug/trellis-board-client.exe`（`--features tauri/custom-protocol`，v0.5.16），WebView2 CDP 端口 `9347` |
| 隔离目录 | `C:\projects\_trellis-board-e2e\11-26-stale-archived-local-only-hint\`（服务端数据、客户端 HOME、bare 远端与测试仓库完全独立于源码树） |

## 2. 场景与逐项验收结果

### 场景构造
- 远端 `origin.git`（`main` 分支）有两个提交：`73fee4b` 包含两个未归档任务 `.trellis/tasks/11-22-archived-remote` 与 `.trellis/tasks/11-22-only-on-old-branch`；`f378a12`（最新）将两者均归档移至 `.trellis/tasks/archive/2026-11/`。
- 服务端仅在 `sync_archive_snapshot` + `sync_archive_file` 写入 `11-22-archived-remote` 的活跃归档快照（`sync_task` 无该任务行），模拟 Git 归档同步后的真实状态。
- 本地接入仓库 `repo-stale` 停留在滞后的 `73fee4b`。

### 逐 AC 结果与双源证据

| AC | 结果 | 证据 1（接口 / 状态文件 / 日志） | 证据 2（UI / DOM） |
| --- | --- | --- | --- |
| **AC1（预检不误报已归档任务）** | ✅ 通过 | 真实客户端调用 `preflight_pending_project` 返回：`archivedTaskBasenames: ["11-22-archived-remote"]`，`counts.localOnly: 1`，`differences` 仅含 `.trellis/tasks/11-22-only-on-old-branch`，已剔除 `11-22-archived-remote`。 | 客户端 Board 页面（`Weint Spec Board`, `http://127.0.0.1:4467/weint-spec-board/`）正常加载并经由真实 capability 通道完成调用。 |
| **AC2（首同步过滤已归档任务）** | ✅ 通过 | `associate_pending_project`（`safe` 模式）完成首次同步后，`live-cursors.json` 的 `deferred` 仅包含 `[".trellis/tasks/11-22-only-on-old-branch"]`，不含 `11-22-archived-remote`；服务端目录查询返回 `409 TASK_ARCHIVED`（`desktop.log` 记录 `本地残留已归档任务副本 .trellis/tasks/11-22-archived-remote`）。 | 左侧 `ProjectRail` 真实 DOM 展示 `1 个本地任务未同步`（`railHasHint: true`），计数准确为 1 而非 2。 |
| **AC3（更新分支后提示自动消除）** | ✅ 通过 | 在 `repo-stale` 执行 `git pull --ff-only`（`73fee4b..f378a12`）将两个任务归档移出活跃目录；**不重启客户端**，几秒内 `list_local_associations` 收敛为 `deferredCount: 0, deferredTaskDirs: []`，`live-cursors.json` 中 `deferred` 自动清空为 `{}`。 | 左侧 `ProjectRail` 真实 DOM 自动消除 `1 个本地任务未同步` 提示（`railStillHasHint: false`），并更新为 `已关联 · 同步正常`（`railHasNormal: true`）。 |

## 3. 未覆盖项及说明

- **AC4（服务端/cursor 基线仍存在而本地目录临时缺失的防误删保护）**：已由 L1 Rust 单元测试 `missing_local_directory_keeps_deferred_protected` 覆盖，本次实机 L3 聚焦主路径。

## 4. 环境清理结果

- 隔离服务端进程（端口 `4467`）与客户端进程树（CDP 端口 `9347`）均已关闭，端口释放完毕。
- 临时目录 `C:\projects\_trellis-board-e2e\11-26-stale-archived-local-only-hint\` 已完整删除。
- 源码工作区无额外未预期变更。
