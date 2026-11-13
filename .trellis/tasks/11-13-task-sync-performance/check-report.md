# Agent 任务同步性能优化检查报告

## 实施结果

- 服务端对每个 taskSpace 保存最后广播 revision；相同、更旧或非法 revision 不再发送 `task.changed`。
- Rust Agent 解析事件 revision，并在首次同步已完成、无 initial review、无 pending upload 且 revision
  不新时短路，不进入快照 GET、本地任务扫描或 cursor 写入。
- `write_cursor` 先比较完整 cursor 状态；patch 无实际变化时保留原 `live-cursors.json` 和 `updatedAt`。
- `.trellis/spec/backend/desktop-realtime-sync.md` 与
  `.trellis/spec/backend/desktop-agent-runtime.md` 已同步契约。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `node --test apps/server/test/agent-event-stream.test.js` | 1 通过、0 失败 |
| `npm test` | 428 通过、1 跳过、0 失败 |
| `npm run check:boundaries` | 未通过；唯一违规来自不在 HEAD、且本任务未修改的 `plugins/witops-core/test/witops-plugins.test.js` 旧导入路径 |
| `cargo fmt --check` / `cargo test` | 未执行；当前会话和常见安装目录均无 `cargo`/`rustc` |

## 代码审查

- 首次同步、initial review、缺失 revision 和 pending upload 均保留原有拉取路径。
- 服务端去重状态只抑制重复广播，不承担一致性恢复；SSE 重连仍由客户端现有补偿拉取负责。
- cursor schema、事件 payload 结构和现有路由均未改变。
- 工作区其他未提交任务和未跟踪文件未修改。

## 待完成验收

1. 在具备 Rust 工具链的环境执行 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 和
   `cargo test --lib`。
2. 使用 0.3 Rust Agent 完成至少 10 分钟重复事件压力对照。
3. 发送真实新 revision，确认只拉取一次并正确推进本地文件、baseline 和 cursor。
