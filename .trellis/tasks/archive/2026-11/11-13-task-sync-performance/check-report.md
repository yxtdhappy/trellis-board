# Agent 任务同步性能优化检查报告

## 实施结果

- 服务端对每个 taskSpace 保存最后广播 revision；相同、更旧或非法 revision 不再发送 `task.changed`。
- Rust Agent 解析事件 revision，并在首次同步已完成、无 initial review、无 pending upload 且 revision
  不新时短路，不进入快照 GET、本地任务扫描或 cursor 写入。
- `write_cursor` 先比较完整 cursor 状态；patch 无实际变化时保留原 `live-cursors.json` 和 `updatedAt`。
- Trellis check 将事件短路判断改为只读 cursor 缓存中的 revision 和 pending 摘要，避免为每次事件
  克隆完整 cursor 状态。
- `.trellis/spec/backend/desktop-realtime-sync.md` 与
  `.trellis/spec/backend/desktop-agent-runtime.md` 已同步契约。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `node --test apps/server/test/agent-event-stream.test.js` | 1 通过、0 失败 |
| `npm test` | 最终复核 429 通过、1 跳过、0 失败；此前并行运行的两个非本任务失败项单独复跑也已通过 |
| `npm run check:boundaries` | 未通过；唯一违规来自不在 HEAD、且本任务未修改的 `plugins/witops-core/test/witops-plugins.test.js` 旧导入路径 |
| `cargo fmt --check` / `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 未执行；当前会话和常见安装目录均无 `cargo`/`rustc` |

## 代码审查

- 首次同步、initial review、缺失 revision 和 pending upload 均保留原有拉取路径。
- 服务端去重状态只抑制重复广播，不承担一致性恢复；SSE 重连仍由客户端现有补偿拉取负责。
- cursor schema、事件 payload 结构和现有路由均未改变。
- 工作区其他未提交任务和未跟踪文件未修改。

## 待完成验收

- [ ] 在具备 Rust 工具链的环境执行 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 和
      `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- [x] 使用 0.3 Rust Agent 完成至少 10 分钟无 revision 变化采样。
- [x] 发送真实新 revision，确认只拉取一次并正确推进本地文件、baseline 和 cursor。
- [ ] 持续注入同一 revision 事件压力，验证重复事件对应的快照 GET、全量扫描和 cursor 写入均为 0；
      现有证据仅为 10 分钟空闲窗口和 revision `243` 的一次同 revision 回显。
- [ ] 重新构建 0.3 客户端，并验证本次 check 新增的 cursor revision/pending 摘要读取路径；
      当前真机受测二进制构建早于该源码改动。

## 0.3 Rust Agent 真机验证

### 测试拓扑

- 客户端：`TrellisBoard_0.3.0_x64-portable`，PID `21840`，启动时间
  `2026-11-13T13:51:10+08:00`，SHA-256
  `A929A0FD6236C94E2D326CE923F58777BAF136C48A020ECC06EE07208F49D21E`。
- Agent：与客户端同进程，状态 `running`；5 个绑定均为 `approved`，首次同步已完成，
  initial review 和 pending upload 均为空。
- 服务端：Team 模式，`http://192.168.65.27:4317`，数据目录
  `%LOCALAPPDATA%\TrellisBoard\server`。
- 服务重启后的诊断实例 PID `52720`，仅额外加载 HTTP 访问日志预加载器，不修改业务代码。

### 10 分钟无 revision 变化窗口

- 采样窗口：`2026-11-13T14:20:08+08:00` 至 `2026-11-13T14:30:08+08:00`。
- `live-cursors.json` 修改 0 次；文件 SHA-256 和最后修改时间在采样前后完全一致。
- 客户端进程 CPU 平均 9.79%，P95 12.24%，最大 21.23%；工作集约 150-178 MB。
- 客户端读取约 3.2-3.8 MB/s、写入不超过 0.003 MB/s；服务端进程读写基本为 0。
- 该 CPU 包含同进程内的 Tauri UI 与 Agent，不能直接等同于修复前的纯 Agent 基线。

### 服务重启与重连补偿

- 重启服务端后 Agent 在约 30 秒内恢复 `running`。
- 5 个已绑定任务空间各执行 1 次快照 GET，共 5 次；没有重复快照 GET。
- 重连期间 Agent 向服务端提交了 4 次 cursor PUT，但本地 `live-cursors.json`
  SHA-256 和 mtime 均未变化，验证了无实际变化不落盘。

### 真实新 revision

- 更新本检查报告后，Agent 于 `2026-11-13T14:38:57+08:00` 调用
  `POST /api/agent/task-spaces/a8d34d0e-54af-4041-bb2c-4507665c7abe/changes`。
- 服务端 revision 从 `241` 推进到 `242`；随后仅出现 1 次
  `GET /api/agent/task-spaces/a8d34d0e-54af-4041-bb2c-4507665c7abe/snapshot?afterRevision=242`。
- 本地 cursor 在 `2026-11-13T14:38:57+08:00` 推进到 revision `242`、sequence
  `1794551936591`；服务端 `indexed_revision=242` 且状态为 `active`。
- revision `242` 完成后继续观察 30 秒，`afterRevision=242` 的快照 GET 仍为 1 次，
  `live-cursors.json` 的 SHA-256 和 mtime 不再变化。
- 再次更新检查报告后，Agent 于 `2026-11-13T14:41:05+08:00` 上传 revision `243`。
  cursor 已在 changes 响应中推进到 `243`，随后同 revision 回显没有产生
  `snapshot?afterRevision=243` 请求；30 秒内也未出现重复 GET 或游标重写。
- 因此，revision `242` 因存在 pending upload 而仍执行一次正常拉取；revision `243`
  在上传完成且无 pending 后命中客户端短路，不再拉取。
- Trellis check 复核时，服务端 `sync_task_space_batch` 保留 revision `242` 的 sequence
  `1794551936591`、revision `243` 的 sequence `1794552063211`，创建时间分别为
  `2026-11-13T06:38:57.393Z`、`2026-11-13T06:41:05.507Z`，与本报告一致。
- Trellis check 随后新增 `read_cursor_event_state()`，避免短路判定克隆完整 cursor；
  该源码改动未包含在上述受测二进制中，需重新构建后补做至少一次同 revision 回显验证。
