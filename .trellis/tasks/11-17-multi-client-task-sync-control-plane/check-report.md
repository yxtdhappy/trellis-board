# 多客户端任务同步控制面质量检查

## 结论

代码级检查通过，真实单客户端创建链路通过。任务仍保留 `in_progress`，因为第二账号 handoff、
Windows 隐藏态通知和真实 Git 归档清理尚未完成真机验收。

## 检查范围

- `packages/desktop/src-tauri/src/agent/runtime.rs`
- `packages/server/team/agent-event-stream.js`
- `packages/server/team/task-command-service.js`
- `packages/server/team/task-control-service.js`
- `packages/server/team/task-space-index.js`
- 对应 `agent-event-stream`、`team-task-commands`、`team-task-control`、
  `team-task-index-v10` 和 `team-web` 回归

## 检查中发现并修复

1. Agent command SSE 标准载荷为 `payload.command`，原 Rust 客户端只读顶层 `command`，
   命令不会进入 `/start`。客户端先读嵌套字段并兼容旧字段，服务端兼容期同时发送两者。
2. 上传路径仅以“创建者 ≠ 负责人”提前写 `source_cleanup_pending`。现由命令类型决定：
   `create_task -> none`，`assign_task` 完成索引校验后才 `source_cleanup_pending`。
3. 命令完成没有即时控制面失效信号。新增 `control.changed`，推进查询 revision 并通知目标
   taskSpace 的 approved bindings；旧客户端默认忽略未知事件。
4. 内容 revision 未变化时负责人变化不刷新索引。权威任务指纹加入负责人、设备、路径、标题、
   优先级、归档、materialization 和 taskVersion，参与 no-op、缓存和持久投影判断。

## 验证结果

```text
node --test packages/server/test/team-task-commands.test.js \
  packages/server/test/team-task-control.test.js \
  packages/server/test/agent-event-stream.test.js \
  packages/server/test/team-task-index-v10.test.js
46 passed / 0 failed / 0 skipped

yarn test
643 tests / 642 passed / 1 skipped / 0 failed

yarn build
yarn build:desktop
git diff --check
```

- IDEA MCP 对 `runtime.rs` 错误级检查无问题。
- Web 构建仅保留既有大 chunk 警告；桌面 UI 构建仅保留既有 `theme-init.js` 非 module 提示。
- 当前机器没有 Rust 工具链，Rust 单测和客户端打包交给 GitHub `windows.yml` 验证。

## 真实 E2E

- Board 创建并派发 `e2e-create-control-fixed-20261118` 给在线用户 `yhj`。
- `/start`、`/claim`、`/changes`、`/result` 均返回 200，revision 541 完成索引。
- 命令 `succeeded`；任务 `materialized`；`handoff_state=none`；负责人索引为 `yhj`。
- Board 显示“任务已落地”，不再出现“等待来源副本清理”。
- watcher 删除探针后 revision 542，Board 与索引消失；本地正文和数据库均有可恢复备份。

## 未覆盖风险

- 当前只有单账号真实客户端，完整 `assign_task` handoff、创建者清理通知、目标 materialization
  双客户端闭环未验证。
- Windows 隐藏/最小化系统通知未做第二账号真机验收。
- 真实 Git 归档后的干净副本自动删除、dirty/Git tracked 副本保留未验证。
- 仓库目录不是 Rust 工程，IDEA 的 Java build 成功不能替代 `cargo test` 或 Tauri 打包。
