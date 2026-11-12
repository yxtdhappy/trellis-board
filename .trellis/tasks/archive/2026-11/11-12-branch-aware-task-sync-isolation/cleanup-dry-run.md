# 存量重复任务 dry-run

- 时间：2026-11-12
- 数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`
- projectId：`276d04c2-1a91-4a75-9581-7f75f501ca30`
- 待清理 taskSpace：`75984cbd-ed47-4389-bddf-2efbce07f275`（`codex/server-gitless-task-sync`，revision 223）
- 保留 taskSpace：`a8d34d0e-54af-4041-bb2c-4507665c7abe`（`main`，revision 138）
- 模式：只读 dry-run，未执行 `--apply`

## 汇总

- 重复任务：6
- 待墓碑文件：33
- 内容完全一致：5
- 内容存在差异：1
- 缺少稳定任务 ID：0

## 重复任务

| task.json id | 内容一致 | 说明 |
| --- | --- | --- |
| `branch-aware-task-sync-isolation` | 是 | 当前任务也已被旧双绑定同步到两个任务空间 |
| `fix-desktop-cross-process-sync-sequence-race` | 是 | 历史重复 |
| `fix-pi-init-exdev` | 是 | 历史重复；两空间来源不同但内容摘要一致 |
| `fix-project-preflight-guidance` | 是 | 历史重复 |
| `project-onboarding-init-hardening` | 是 | 历史重复 |
| `rust-desktop-agent-single-exe` | 否 | 6 个文件均不同，不能直接删除旧副本 |

`rust-desktop-agent-single-exe` 的差异文件：

- `check.jsonl`
- `design.md`
- `implement.jsonl`
- `implement.md`
- `prd.md`
- `task.json`

## 结论

- 清理脚本默认 dry-run 和归档排除逻辑已在真实库验证。
- 当前 4317 仍运行未重启的旧代码；上述重复任务可能是旧进程继续双写产生。
- 实际清理尚未授权，未写 tombstone、audit、revision 或索引。
