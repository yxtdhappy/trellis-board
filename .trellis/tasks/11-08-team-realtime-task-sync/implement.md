# 客户端任务实时上报与广播实施计划

## 前置条件

- [ ] `11-08-desktop-account-login` 已完成登录、设备凭据和 approved project binding。
- [ ] `11-08-support-multi-team-board` 已完成并稳定多团队授权契约。
- [ ] 当前工作区无关改动已区分，实施只覆盖本任务文件。

## 1. 共享 watcher

- [ ] 把 `server/watcher.js` 的目录过滤、监听、状态和关闭逻辑提取到 `shared/trellis-watcher.js`。
- [ ] `server/watcher.js` 保持现有导出，改为共享模块薄包装。
- [ ] sidecar 使用同一共享模块，不复制 `fs.watch` 和路径过滤。
- [ ] 支持 `repositories` 动态重建和批次防抖。
- [ ] 保留单机 watcher 现有测试，并增加共享 watcher 单测。

验证：

```powershell
node --test tests/watcher.test.js tests/desktop-package.test.js
```

## 2. 服务端 schema 与存储

- [ ] 数据库 schema 升级到 v7。
- [ ] 新增 `project_live_revision`、`project_live_file`、`project_live_batch`、`agent_live_cursor`。
- [ ] 为 `team_task_index` 增加 `live_revision`。
- [ ] 用 `BEGIN IMMEDIATE` 保证 batch、revision、文件和审计原子提交。
- [ ] 实现 batchId 幂等和同文件后到覆盖。
- [ ] 实现路径规范化、文本类型、大小、数量和速率校验。

验证：

```powershell
node --test tests/database.test.js tests/team-realtime-sync.test.js
```

## 3. 服务端 API

- [ ] 新增 `POST /api/agent/live-changes/preflight`。
- [ ] 新增 `POST /api/agent/live-changes`。
- [ ] 新增 `GET /api/agent/live-files?projectId&afterRevision`。
- [ ] 新增 `GET /api/team/live-revision`。
- [ ] 在 Agent SSE 中增加 `live.changed`。
- [ ] 向原责任人发送 `task.live.overridden`。
- [ ] 所有接口验证 Agent 身份、团队成员、project binding 和项目权限。

验证：

```powershell
node --test tests/team-realtime-sync.test.js tests/team-events.test.js tests/team-isolation.test.js
```

## 4. 实时任务投影

- [ ] 增加 live file 覆盖视图，复用 `server/loader.js` 解析和阶段推导。
- [ ] 任务文件变化时重算单个任务并更新 `team_task_index`。
- [ ] workspace/developer 变化时重算受影响任务。
- [ ] Git 刷新时逐文件比较摘要，只清除已收敛的 live file。
- [ ] Git 内容不同或更旧时保留实时状态。
- [ ] 完整 Git 扫描不得无条件覆盖 `live_revision > 0` 的任务行。

验证：

```powershell
node --test tests/loader.test.js tests/team-task-index.test.js tests/team-realtime-sync.test.js
```

## 5. Agent 上报与拉取

- [ ] sidecar 为 approved binding 创建共享 watcher。
- [ ] 把文件变化聚合为批次，支持 upsert/delete、摘要、幂等键和客户端序号。
- [ ] 实现对 UTF-8/文件扩展名/符号链接/路径限制的校验。
- [ ] SSE 收到 `live.changed` 后按本地 cursor 拉取最新文件。
- [ ] 按文件执行比较、备份、临时写、fsync 和原子 rename。
- [ ] 写入后记录期望摘要，watcher 仅在摘要一致时忽略自触发事件。
- [ ] 真实本地修改即使紧接远端写入也必须上报。
- [ ] 应用成功后才推进 cursor；失败停止该批次并显示错误。

验证：

```powershell
node --test tests/desktop-package.test.js tests/desktop-realtime-apply.test.js agent/test/runtime-cli.test.js
```

## 6. 备份与一键复原

- [ ] 备份写入项目工作区外、watcher 不扫描的 Agent 数据目录，保存 manifest 和原文件。
- [ ] 冲突覆盖成功后显示通知，包含任务、revision、文件数和备份位置。
- [ ] 实现备份列表和“一键复原”。
- [ ] 复原时 pause/suppress watcher，写回文件，并以新 batchId 上传。
- [ ] 服务端将复原内容作为新 revision 广播。
- [ ] 备份保留 30 天，每任务至少最近 20 份。

验证：

```powershell
node --test tests/desktop-realtime-backup.test.js tests/team-realtime-sync.test.js
```

## 7. 责任人警告

- [ ] 上传前 preflight 获取责任人、warningId 和过期时间。
- [ ] sidecar pending 队列保存待确认批次，不把文件正文写入日志。
- [ ] Rust 从 sidecar 控制事件打开本地模态窗口。
- [ ] 提供取消、继续推进、接管任务三个动作。
- [ ] 取消：先备份本地改动，再恢复服务端版本。
- [ ] 继续推进：保留责任人并写审计。
- [ ] 接管任务：显式变更责任人后上传。
- [ ] Board 直接写操作收到 409 时复用同样三按钮交互。
- [ ] 原责任人收到通知，不阻塞操作者。

验证：

```powershell
node --test tests/team-realtime-assignee.test.js tests/desktop-package.test.js
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

## 8. Board 快速刷新

- [ ] `useBoard` 每 750ms 查询 `/api/team/live-revision`。
- [ ] revision 或 taskKeys 变化时使用现有 ETag/游标重新查询任务。
- [ ] 卸载、切换团队和退出登录时清理定时器。
- [ ] 保持原 `/api/team/status` 轮询作为兜底。

验证：

```powershell
node --test tests/team-web.test.js
npm --prefix web run build
```

## 9. 安全与恢复

- [ ] 拒绝非 approved binding、无写权限用户、越界路径、符号链接、二进制和超大文件。
- [ ] 日志和审计不记录文件正文。
- [ ] SSE 断线后从 cursor 补拉，旧事件不能回退新 revision。
- [ ] 连续失败时暂停该项目自动应用并提示用户。
- [ ] 关闭实时同步开关后，系统回退到 Git 轮询和手动刷新。

## 10. 最终验证

全部开发完成后只执行一次完整构建：

```powershell
npm test
npm run build
node desktop/sidecar/build-sidecar.ps1
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo tauri build
```

Windows 真实 E2E：

1. 客户端 A 修改未提交 `task.json`，客户端 B 在 3 秒内看到 Board 阶段变化和本地文件变化。
2. A 修改 `task.json`、B 同时修改 `prd.md`，两者都保留。
3. A、B 同时修改 `task.json`，后到内容最终生效，先到端生成备份和提示。
4. 通过一键复原恢复先到版本，服务端产生更高 revision，双方最终一致。
5. A 修改他人负责的任务时出现责任人弹窗；取消后恢复、继续保留责任人、接管才改派。
6. 断网修改后重连，变化补传且其他客户端补齐。
7. SSH/网络抖动和 SSE 重连下不会产生回退、重复任务或事件风暴。
8. Git commit 后实时覆盖逐步收敛；“实时未入 Git”状态正确显示。
9. 测量 20 次同步操作，P95 不超过 3 秒。

