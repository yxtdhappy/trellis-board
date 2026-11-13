# 检查报告

## 结论

- 全量扫描与实际上传批次边界已拆分：`group_task_snapshot_files` 只负责逐文件校验和目录分组，不再限制整个 taskSpace 的文件总数或聚合正文大小。
- `upload_batch` 是私有入口，仅由 `upload_persisted_batch` 和 `retry_pending_batch` 调用；两者都会在 pending 写入或网络重试前执行 `validate_upload_batch`。
- 新批次和 pending 重试继续使用 1024 文件、64 MiB 正文上限；错误发生在 pending 落盘前。
- 分支守卫、CAS、冲突、删除墓碑、目录移动、游标和 pending 重放逻辑未改动；服务端协议、限额常量和任务数据未修改。
- 已补充跨目录聚合超过 1024、两个真实上传调用点提前拒绝、重复路径和活动/归档分组测试，并在
  `desktop-realtime-sync` 与 `desktop-agent-runtime` 规范中明确聚合扫描不是上传批次。

## 验证

- `git diff --check`：通过，仅有既有 `task.json` CRLF/LF 提示。
- `node --test apps/server/test/team-task-snapshot.test.js packages/shared/test/task-snapshot.test.js`：通过，27/27。
- `npm test`：通过，428 通过、1 跳过、0 失败。
- `npm run lint --workspace @trellis-board/web`：通过，存在既有 warning。
- `npm run check:boundaries`：失败；唯一违规为未修改的 `plugins/witops-core/test/witops-plugins.test.js` 使用旧 `tests/` 路径，不属于本任务。
- `npm run format:check`：失败；14 个未修改文件存在既有格式问题。`oxfmt` 不覆盖 Rust 和 `.trellis` 目标文件。
- Rust `cargo test`、`cargo fmt --check`、`cargo clippy`：未执行。本机没有 `cargo`、`rustc`、`rustfmt` 或 `tauri`。
- 真实 Windows 客户端同步 E2E：未执行。

## 剩余限制

- 新增 Rust 单元测试已完成源码级审查，但未在本机编译或运行；需要 Rust 工具链 CI 或开发机执行。
- 发布前仍需使用真实客户端验证：1561 文件 taskSpace 可跨多个任务目录持续同步，以及单个超限 pending 会保留原 pending 并返回明确错误。
