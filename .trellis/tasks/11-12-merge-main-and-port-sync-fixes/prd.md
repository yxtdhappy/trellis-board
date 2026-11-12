# Merge main and port sidecar sync fixes into the Rust agent

## Goal

把 `origin/main` 合并进 `codex/rust-desktop-agent-single-exe`，并把 main 上针对 Node sidecar / JS agent 的修复同步移植到本分支的 Rust 进程内实现，使分支在追平 main 后行为不出现倒退。

## Background

- 本分支用 Rust 进程内 Agent 替换了 Node SEA sidecar，删除了 `desktop/sidecar/**`、`agent/**` 的桌面装配、`desktop/src-tauri/src/sidecar.rs` 等。
- 同一时间 main 累积了 24 个提交，其中 5 个修改了被删除的文件（sidecar/agent JS），直接合并会把这些修复一起丢掉。
- `git merge-tree` 预演冲突：`desktop/src-tauri/src/main.rs`、`web/src/features/board/TaskCard.tsx` 内容冲突；`src/sidecar.rs`、`desktop/sidecar/{main,desktop-device}.js`、5 个 `tests/desktop-*.test.js`、`.trellis/spec/backend/desktop-sidecar-packaging.md` 为 modify/delete。

## Requirements

### R1 合并 main

- `git merge origin/main` 产生 merge commit，冲突处理原则：删除的文件保持删除（`git rm`），文档/规格取本分支的进程内版本并补齐 main 新增事实。
- 合并后 `desktop/sidecar/**`、`src/sidecar.rs`、SEA 相关测试不得复活。

### R2 移植 upstream 修复（必须逐条落到 Rust）

| upstream | 语义 | Rust 落点 |
| --- | --- | --- |
| `0caf270` prevent inactive binding sync crash | 事件流恢复后只对活跃绑定拉取；`pullTaskSpace` 对未知 taskSpace 返回 `BINDING_INACTIVE` 而不是抛错 | `agent/runtime.rs`、`agent/task_sync.rs` |
| `80647fc` sync deferred local tasks explicitly | 显式补同步 `deferred` 任务目录；关联列表返回 `deferredCount`/`deferredTaskDirs`；新增 Tauri 命令 | `agent/task_sync.rs`、`agent/device.rs`、`agent_service.rs`、`main.rs`、permissions/capabilities |
| `d58b021` isolate task sync by repository branch | 同一 `localRepoKey` 只能有一个 approved 绑定；按真实分支选择激活绑定；分支守卫错误码持久化且不被心跳/命令结果覆盖；上传携带 `observedBranchName` | `agent/store.rs`、`agent/git.rs`、`agent/task_sync.rs`、`agent/runtime.rs`、`agent/task_command.rs`、`agent/onboarding.rs` |
| `0fd2dc0` serialize desktop task cursor updates | 游标文件加锁 + 串行写入；409 冲突按服务端 `details.requiredClientSequence` 恢复序列 | `agent/store.rs`、`agent/task_sync.rs` |
| `86bd1db` recover locked sidecar sync | 托盘「同步」菜单项与强制重启（备份 `agent.lock`、结束旧进程、等待锁释放） | `agent_service.rs`、`main.rs`（托盘），无 sidecar 时降级为进程内 runtime 重启 |

### R3 不变量

- 运行期仍不出现 `node.exe`；产物仍是单一 `trellis-board-client.exe`。
- 服务端协议（`AGENT_PROTOCOL_VERSION = 3`）与控制事件契约不变。
- `clientSequence` 仍必须以墙钟为基线（服务端要求严格递增），并叠加 `requiredClientSequence` 恢复。
- 只有真实分支匹配时才注册 watcher/上传；不匹配时持久化 `BRANCH_MISMATCH` 等错误并通知，不静默。

## Out of Scope

- 不恢复 Node sidecar、SEA 构建链或 `desktop/package.json`。
- 不重写 main 上的服务端/前端逻辑（直接随合并进入）。
- 不为移植的每处行为补 JS 测试镜像；以 Rust 单测 + 本地联调覆盖。

## Acceptance Criteria

1. `git log --oneline origin/main..HEAD` 为空；合并提交存在且无冲突标记残留。
2. `desktop/sidecar/`、`desktop/src-tauri/src/sidecar.rs`、`tests/desktop-{association,device-auth,package,sidecar-lifecycle,trellis-runtime}.test.js` 在 HEAD 中不存在。
3. 同一 `localRepoKey` 两个 approved 绑定时，只有一个分支匹配的绑定被激活；另一绑定的 `lastErrorCode` 保持 `BRANCH_MISMATCH` 且心跳不会覆盖它。
4. 分支不匹配时上传被拒绝且错误持久化；切回正确分支后错误被清除、绑定恢复 `ready`。
5. `sync_deferred_tasks` 命令可从关联列表补同步 `deferred` 任务，返回 `syncedCount`/`remainingCount`/`remainingTaskDirs`/`conflict`；前端按钮可用。
6. 409 `CONFLICT` 且带 `requiredClientSequence` 时，客户端提升序列并重试成功，不出现「clientSequence 必须严格递增」。
7. 托盘「同步」操作在运行中/暂停/异常三态下文案与行为正确，强制重启可回收陈旧锁。
8. `cargo fmt --all`、`cargo check --all-targets`、`cargo clippy --all-targets`（0 error）、`cargo test --bins`、`npm test` 全绿。
9. `cargo build --release` 产物目录只有 `trellis-board-client.exe`。

## Key Decisions

- 采用 merge commit（保留 history），不 rebase。
- upstream 修复以「行为等价」为移植标准，不追求逐行对照；JS 侧死代码（live sync）不再引入。
- 托盘「同步」菜单保留但落到进程内 runtime（`restart`/`toggle_pause`），不再有独立 sidecar 进程可重启。
- 分支隔离在 `TaskSync` 层实现（选定激活绑定），而非在每条上传路径各自判断，避免遗漏。

## Risks

- `task_sync.rs` 已重写且带 watcher，移植分支守卫时容易与最新 main 的 `_setBindings` 选择逻辑走偏 → 以「每仓库仅一个活跃 binding」不变量兜底并加单测。
- `requiredClientSequence` 恢复可能与墙钟序列冲突 → 以「取较大值」合并。
- 合并 `web/**` 冲突可能引入与已删除 Tauri 命令不一致的调用 → 合并后 grep 前端命令名核对。
