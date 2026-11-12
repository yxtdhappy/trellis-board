# 跨分支任务同步与冲突收敛检查报告

## 结论

静态检查完成。按用户要求跳过测试用例，因此本报告不把测试、构建或真实 E2E 记为通过。

## 检查项

- [x] binding 层级和任务层级的归属门禁区分清楚，未把 `base_branch` 当作同步归属。
- [x] 上传批次在服务端 CAS 前有完整任务分支校验，拒绝时不递增 revision、不写 batch/conflict。
- [x] pending 重试保留原始文件字节和幂等标识；冲突状态有稳定 ID。
- [x] 历史冲突查询只投影每组最新 pending，避免响应体继续膨胀。
- [x] 清理工具默认 dry-run，apply 前要求备份、停服和状态/revision 校验。
- [x] ProjectRail 区分 binding 暂停和任务归属待确认；单分支创建不显示多余选择器。
- [x] 新 Tauri 命令和 capability/permission 在源码中成对出现。
- [x] 规范已拆分为独立任务归属文档，`desktop-realtime-sync.md` 降至注入阈值以内。

## 未验证

- Node 单元/集成测试：用户要求跳过，未执行。
- `npm --prefix apps/web run build`：用户要求跳过，未执行。
- Rust/Tauri 编译和真实客户端点击：本轮未执行；当前机器是否具备工具链未重新确认。
- 生产数据库 dry-run、backup 和 apply：未执行。
- 真实 4317 服务重启、Agent 重连和跨分支 worktree E2E：未执行。

## 剩余风险

- 历史 pending batch 中若已固化空 `task.json.branch`，需要在真实迁移时单独核对，不能通过改写原批次来绕过幂等。
- 旧任务空间仍存在跨分支副本时，代码会暂停对应任务；最终数据收敛仍依赖显式清理流程。

## 非测试静态检查

- `task.py validate`：通过，`implement.jsonl` 和 `check.jsonl` 均为 6 个有效条目。
- `git diff --check`：通过。
- `node --check`：10 个本次改动 JavaScript 文件通过。
- 规范文件大小：桌面同步规范 27,617 字节，任务归属规范 7,677 字节，均低于 32,768 字节注入上限。
