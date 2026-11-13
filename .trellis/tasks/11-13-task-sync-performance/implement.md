# Agent 任务同步性能优化实施计划

## 执行顺序

- [x] 1. 记录当前状态
  - 确认当前分支、工作区改动和 0.3 Rust 客户端构建方式。
  - 保留现有无关改动，不格式化、不回滚。
- [x] 2. 服务端 revision 去重
  - 在 `apps/server/team/agent-event-stream.js` 增加 per-taskSpace 最后通知 revision。
  - 对相同和更旧 revision 直接返回。
  - 新增事件流单元测试，覆盖同 revision、旧 revision、新 revision 和多 taskSpace。
- [x] 3. 客户端事件 revision 透传
  - 在 `apps/desktop/src-tauri/src/agent/runtime.rs` 解析 `task.changed.revision`。
  - 将可选 revision 传给 `pull_and_report`。
  - 缺少 revision 时保持原有拉取行为。
- [x] 4. 客户端 revision 短路
  - 在 `apps/desktop/src-tauri/src/agent/task_sync.rs` 增加纯判定函数。
  - 首次同步、initial review、pending upload、缺失 revision 必须继续拉取。
  - revision 不新且无 pending 时返回 `REVISION_CURRENT`，跳过快照请求、本地扫描和游标写入。
  - 为纯判定增加表驱动测试。
- [x] 5. 游标无变化不写
  - 将 cursor patch 应用与落盘判断拆分。
  - 仅实际字段变化时更新 `updatedAt` 并写文件。
  - 增加 identical patch 和每类字段变化测试。
- [ ] 6. 回归测试
  - [x] 运行 `npm test`：428 通过、1 跳过、0 失败。
  - [ ] 运行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：当前机器没有 `cargo` 工具链。
  - 确认首次同步、SSE 重连、pending retry、冲突、分支不一致、真实新 revision 测试通过。
- [ ] 7. 最终编译
  - 所有代码和测试完成后只执行一次构建：
    - `npm run build:desktop`
    - `npm run desktop:build`
  - 不新增 lint、类型检查或无关构建步骤。
- [ ] 8. 0.3 Rust Agent 性能验证
  - 在可控重复事件窗口采样 10 分钟。
  - 记录 Agent CPU、读/写 MB/s、任务空间 GET、`live-cursors.json` mtime 修改次数。
  - 验证修复后相同 revision 不产生请求、全量扫描或游标写入。
  - 发送真实新 revision，验证一次成功同步和本地文件更新。
- [ ] 9. 质量检查与收尾
  - 运行 Trellis check，更新必要的同步契约文档。
  - 检查工作区差异，只提交本任务文件。
  - 完成后归档任务。

## 验证命令

```powershell
npm test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run check:boundaries
npm run build:desktop
npm run desktop:build
```

## 风险文件

- `apps/server/team/agent-event-stream.js`
- `apps/desktop/src-tauri/src/agent/runtime.rs`
- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- 对应 Node/Rust 测试文件

## 回滚点

- 服务端去重可单独回滚，不影响协议。
- 客户端 revision 短路必须在游标无变化保护之前验证，防止 pending retry 被误跳过。
- 游标 schema 不变，无数据迁移回滚风险。

## 启动前检查

- [ ] PRD、Design、Implement 已由用户审阅。
- [ ] 用户明确批准最终规划摘要。
- [ ] 工作区现有无关改动已识别。
- [ ] 当前部署 0.2 与源码 0.3 差异已纳入验收说明。
