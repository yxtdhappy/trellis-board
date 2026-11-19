# 多客户端任务同步控制面质量检查

## 结论

代码级检查与真实双客户端 E2E 均已完成。离线委派、目标认领、租约/所有权拒绝、
handoff 自动清理、Windows 隐藏态通知、归档 tombstone（干净删除/脏副本保留）、
旧客户端离线写入拒绝和迁移重复处理均已验证。

## 检查范围

- `packages/desktop/src-tauri/src/agent/runtime.rs`
- `packages/desktop/src-tauri/src/agent/task_command.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/{control,upload,pull,local_files}.rs`
- `packages/desktop/src-tauri/src/agent_service.rs`
- `packages/server/team/{agent-event-stream,task-command-service,task-control-service,task-space-index,archive-git-sync}.js`
- `packages/web/src/desktop/HandoffNotice.tsx`
- 对应服务端/桌面/Web 回归

## 检查中发现并修复

1. Agent command SSE 标准载荷为 `payload.command`，客户端改为优先读取嵌套字段并兼容
   旧字段。
2. 上传响应 `revision` 是上传前空间游标；命令结果改为使用
   `control.task.contentRevision`/`committedRevision`/claim revision，避免
   `TASK_VERSION_STALE`。
3. 命令成功上传后释放执行租约；服务端 handoff 清理不再把负责人自己的租约当成
   第三方并发写入。
4. 服务端 `COMMAND_WAITING_INDEX` 进入客户端重试路径，不再被当作永久失败。
5. 便携版 AUMID 会丢弃 `ToastGeneric`；隐藏/最小化通知改为 WinRT
   `ToastText02`（PowerShell `-EncodedCommand`），可见时只保留页内提示。
6. 归档 tombstone 只在本地归档副本存在且摘要一致时删除活跃副本；不一致时保留
   本地数据并告警，不静默删除。

## 验证结果

```text
node --test packages/server/test/team-task-commands.test.js \
  packages/server/test/team-task-control.test.js \
  packages/server/test/agent-event-stream.test.js \
  packages/server/test/team-task-index-v10.test.js

49 passed / 0 failed / 0 skipped
```

- GitHub Actions `windows.yml` build #9 成功；客户端 A 使用该构建完成双客户端验证。
- 先前 `yarn test`：643 tests / 642 passed / 1 skipped / 0 failed；
  `yarn build`、`yarn build:desktop`、`git diff --check` 通过。
- IDEA MCP 对 `runtime.rs` 错误级检查无问题。
- 真实 E2E 证据与清理记录见 `e2e-report.md`。

## 未覆盖风险

- 跨用户归档墓碑未在 B 侧单独复测（P9/P10 为 A 独占任务，控制面按用户过滤）。
- 归档脏副本保留在原活跃目录并告警，未额外生成独立 live-backup 目录。
- 迁移重复探针由归档身份 claim 拒绝拦截，未在 Board 生成第二行
  `identity_conflict`；活跃任务同 ID 冲突由自动化测试覆盖。
- 本轮未复测“本地 Git tracked 且已修改”的归档副本。
