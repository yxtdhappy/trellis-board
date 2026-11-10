# 实时同步阻塞与误弹窗根因证据

## 事件时间线

| 时间 | 事件 |
| --- | --- |
| 2026-11-10 15:45:24 | `D:\wit\mdp-backend-service` 执行 `git merge origin/dev`。`git reflog` 与 `git show --stat 8079fbe` 均确认该合并写入 18 个 `.trellis/tasks` 文件。 |
| 15:45:28 | 合并后的 workspace 文件成功形成实时 revision 3。 |
| 15:49 左右 | `11-06-project-ds-sync-reconcile` 与归档任务文件产生责任人确认，对应任务责任人为 `zhangxuan` 或 `weishanchong`。 |
| 15:50:14 | 一个 `design.md` 批次以 `continue` 决策成功形成 revision 4。 |
| 15:53:53 | Agent 心跳请求 30 秒超时，日志为 `Agent 请求已取消`。 |
| 15:54:05 | Agent 事件流因长时间无数据断开。 |
| 15:54:25 | Agent 自动重连，服务恢复响应。 |
| 16:01:03-16:01:05 | 同类心跳和待重试上传再次超时；16:01:08 恢复。 |

## 代码调用链

1. 共享 watcher 把 Git merge 写入的 `.trellis` 文件作为普通文件变化交给 `AgentLiveSync._handleWatcherEvents()`。
2. Agent 不检查路径是否仍与 Git HEAD 有差异，直接把文件内容送入 preflight。
3. 服务端发现任务责任人不是当前开发者，返回 `ASSIGNEE_CONFIRMATION_REQUIRED`。
4. 实时变更成功后，服务端 `applyChanges()` 在主线程同步调用 `reapplyProject()`。
5. `reapplyProject()` 复制整个项目覆盖层、调用 `scanRepository()`、执行 `buildBoard()` / 索引替换，并递归删除临时目录。
6. 所有同步文件操作均位于 Node HTTP 主线程，期间 `/api/health`、Agent heartbeat 和确认请求只能排队。

## 主线程耗时测量

测量只包含 `reapplyProject()` 中复制、扫描和删除临时目录三段，未包含 `buildBoard()`、SQLite 索引写入和并发定时拉取：

| 项目 | 任务数 | 复制 | 扫描 | 删除 | 合计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mdp-backend-service` | 135 | 9655 ms | 6054 ms | 3563 ms | 19273 ms |
| `mdp-management-web` | 324 | 6288 ms | 5041 ms | 1983 ms | 13312 ms |

第二组在系统缓存较热时测得，说明耗时受 Windows 文件缓存和磁盘负载影响明显；真实服务耗时还包含未计部分，因此超过 Agent 的 30 秒请求超时具有现实条件。

## 确认窗口问题

- `desktop/src-tauri/src/sidecar.rs:230` 的 `show_control()` 每次都会显示、取消最小化并强制聚焦窗口。
- 同一项目的多个任务会形成多个 decision 文件，每个 decision 都调用 `emitControl()`。
- `control_is_stale()` 只处理过期和处理完成，没有“用户主动稍后处理”状态。
- `dismiss_control()` 明确拒绝关闭责任人确认，要求三个远端动作之一成功。
- “取消并恢复”仍调用 `/api/agent/live-files`，所以服务端阻塞时三个选项都会等待。

## 结论边界

- 已证明同步全量重投影在主线程执行，且单项目耗时达到 13-19 秒以上，足以解释心跳和健康检查超时。
- 已证明 Git merge 的干净工作区写入会被 watcher 当作本地实时修改，从而产生误弹窗。
- 未捕获旧进程故障瞬间的 V8 stack，因为旧服务已被停止并重启；耗时基准、调用链和日志时间吻合，根因判断为高置信度。
