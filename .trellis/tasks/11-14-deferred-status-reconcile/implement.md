# 实施计划：deferred 已一致状态收敛

## 前置

- 已确认 65/8/10/6 个 deferred 均与服务端文件集合和 SHA256 完全一致。
- 不改真实任务正文，不执行补同步上传。
- 在 `main` 直接实施，不创建分支。

## 实施步骤

1. 把 `local_sync_state` 的比较循环提取为纯函数，输入现有 cursor、local groups 和合并后的
   `snapshot_baselines`。
2. 保留 `cursor.baselines` 作为本地 dirty 判断基线；仅用 `snapshot_baselines` 判断 deferred
   是否已经与服务端完全一致。三者一致且本地非空时删除 deferred，并跳过 dirty upload。
3. 复用 `TaskSync::update_bindings` 首次建立运行集合时的现有 pull 流程；同一 revision 的空增量
   也必须触发收敛，不新增进程态扫描集合或周期任务。
4. 正常 pull 使用合并后的服务端 baseline 执行同一收敛；deferred 指纹仍匹配本地但服务端不同时
   保留受保护审查路径，不上传。
5. 收敛只把“本地、deferred 指纹和合并服务端基线完全一致”的目录记录为精确收敛；本地状态变化
   导致的旧 deferred 清理不得纳入。收敛只写实际变化的 `CursorPatch.deferred`，不产生 pending
   batch、revision 推进、上传或任务正文写入。
6. 增加 Rust 单测：exact、hash mismatch、server missing、local extra、local missing、empty
   baseline、同 revision 启动收敛、收敛不触发基线补交上传、pull 收敛不产生 dirty upload、
   本地状态变化仍保留基线补交、重复 heartbeat 不重复正文扫描。
7. 更新 `.trellis/spec/backend/desktop-realtime-sync.md`；如 UI 契约未变化，不改 Web 组件。
8. 最后只执行一次开发完成后的 Rust 测试/编译验证，不按小阶段反复构建。

## 验证

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

补充定向检查：

- deferred 为空时不扫描。
- 同一 revision 启动 pull 仍执行一次收敛，但相同 deferred 结果不重写 cursor。
- 3 秒 association 路径没有新增 `local_groups()` 调用。
- `write_cursor` 相同 deferred patch 不落盘。
- `git diff --check` 通过。

真实 Windows E2E：

1. 运行修复版客户端，等待启动同步，并通过现有 association 刷新路径读取
   `deferredCount`。
2. 确认 `trellis-board` 不再显示 65 个本地任务未同步。
3. 确认 `mdp-backend-service` 8、`mdp-report-service` 10、`mdp-management-web` 6 同样收敛。
4. 确认服务端 revision、merge evidence、taskSpace 文件数和任务正文不变。
5. 创建一个真实存在差异的临时 deferred 探针，确认仍显示未同步且不会被自动上传；验证后清理。
6. 重新采样客户端 CPU，确认没有回到任务正文全量扫描造成的周期尖峰。

## 风险点

- 不能在 3 秒展示轮询里做正文扫描。
- 不能因 baselines 不完整而误清真实差异。
- 不能把自动收敛扩大成自动上传。
- 启动收敛失败必须保留原 cursor，不能部分删除标记。
- 后续状态性能优化任务会再次修改 `task_sync.rs`；本任务必须先完成并归档，避免在
  `write_cursor` 和本地同步比较逻辑上并行开发。

## 文件范围

- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- `.trellis/spec/backend/desktop-realtime-sync.md`
- 任务内报告

如需更新 UI 规范，仅改 `.trellis/spec/frontend/rendering-and-state.md`，不改组件代码。
