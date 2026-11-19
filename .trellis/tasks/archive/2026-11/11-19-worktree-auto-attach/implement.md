# 实施记录：worktree 自动接入与懒显示

## 完成内容

- 自动发现：从已批准 binding 的 Git common dir 枚举 `git worktree list --porcelain`，跳过主工作树、bare、prunable；以发现时的 HEAD tree 和工作区任务为 baseline。
- 候选检测：只接受 baseline 之后新增、`task.json.branch` 与 worktree 分支一致、任务 id 非空的活动任务；归档目录、继承任务、旧任务不上传。
- 自动接入：复用 `onboarding::attach_project`，不再弹确认；team 来自同 remote 的 binding，developer 从 `.trellis/.developer` 回退，初始同步固定 `safe`。
- 懒显示：首次候选上传成功前 `firstUploadCompleted=false`，ProjectRail 不显示该分支；上传成功后才显示。
- tracked allowlist：自动接入的 binding 持久化 `tracked_task_dirs`；第一次上传只允许候选目录，后续只允许非 baseline、分支匹配的新活动任务加入。
- 可见性：同分支所有活动任务数 > 0 → visible；本地 0 且服务端 active > 0 → visible + `archiveSyncPending`；本地 0 且服务端 active 0 → hidden_empty；worktree 删除 → hidden_missing；同路径重新出现时重置 baseline/tracked/firstUploadCompleted，重新按发现后新增任务处理。
- 归档：客户端不上传 `archive/**`，不删除服务端 active；服务端归档同步清空 active 后隐藏分支。
- 失败处理：自动接入/上传/首次同步/可见性查询失败保留 lastError/lastVisibilityError，分支保持隐藏；首次同步未完成时按退避重试 `sync_task_spaces`，不重复 attach；ProjectRail 顶部显示非阻塞错误与重试入口。
- 手工 binding：`autoManaged=false` 的既有 approved binding 不参与自动接入、tracked 过滤或隐藏规则。

## 代码结构

- `packages/desktop/src-tauri/src/agent/worktree/registry.rs`：`worktree-registry.json` schema 1，`WorktreeEntry`/`WorktreeStatus`/`WorktreeVisibility`。
- `packages/desktop/src-tauri/src/agent/worktree/discovery.rs`：worktree 枚举、baseline、候选、开发者/来源 binding；缺失路径的 binding 不执行 `git worktree list`。
- `packages/desktop/src-tauri/src/agent/worktree/watch.rs`：common dir `worktrees` 与 worktree `.trellis/tasks` watcher，250ms 去抖。
- `packages/desktop/src-tauri/src/agent/worktree/visibility.rs`：服务端 active 计数。
- `packages/desktop/src-tauri/src/agent/worktree/mod.rs`：`WorktreeService`、15s 轮询、自动接入、tracked 上传、可见性、重试。
- `packages/desktop/src-tauri/src/agent/git.rs`：`GitOperation::WorktreeList`、`worktree_list`、`common_dir`。
- `packages/desktop/src-tauri/src/agent/task_sync/bindings.rs`：`set_tracked_task_dirs`；缺失路径的自动 binding 暂时退出活动集合，路径恢复后重新加入。
- `packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs`：`upload_dirty` 按非空 tracked allowlist 过滤。
- `packages/desktop/src-tauri/src/agent/runtime.rs`：创建/启动/停止 `WorktreeService`，启动顺序在 `prepare_startup_bindings` 之后。
- `packages/desktop/src-tauri/src/main.rs`、`agent_service.rs`、`permissions/desktop.toml`、`capabilities/board-local-association.json`：三个 Tauri 命令与权限。
- `packages/web/src/components/layout/ProjectRail.tsx`：加载 worktree 状态、过滤隐藏分支、归档 pending 提示、错误与重试 UI、隐藏当前 taskSpace 时回到 all。

## 验证

- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：300 passed。
- `yarn test`：659 tests，656 pass，3 skipped，0 fail。
- `yarn build`：通过。
- `cargo check`：通过。
- `yarn oxfmt`：已执行。
- `rustfmt --check`（`agent/worktree/*`）：通过。
- `git diff --check`、`git ls-files --eol`（含未跟踪文件）：无 CRLF、无空白错误。

## 未覆盖

- 已在真实 Tauri 窗口 + 真实 worktree 验收自动发现、自动接入、首次上传后显示、归档隐藏/恢复、worktree 删除/重建；错误重试入口未在真实失败场景触发验证。
- 未修复既有 `desktop-realtime-sync.md` 69,842 bytes / `rendering-and-state.md` 36,367 bytes 超过 32,768 注入上限的问题；已由 `research/worktree-sync-contracts.md` 摘要补充。
