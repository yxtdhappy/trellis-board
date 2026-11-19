# Worktree 自动接入与懒显示 — 契约摘要

本文件只摘录本任务实施/检查需要反复引用的契约；权威内容以
`.trellis/spec/backend/desktop-realtime-sync.md`、
`.trellis/spec/desktop/tauri-commands/index.md` 和现有接入/同步代码为准。

## 产品模型

- taskSpace = `remote_identity_hash + branchName`；同一项目可有多个 taskSpace。
- 本任务：每个 worktree 自动接入为独立分支 taskSpace；不合并到源分支，不新增服务端 origin。
- 分支只在“自动接入 + 首次候选上传成功”后显示；发现/候选阶段隐藏。
- 分支显示后动态可见：worktree 删除立即隐藏；本地无活动任务且服务端 active=0 时隐藏；
  本地无活动但服务端 active>0 时保持显示并等待归档同步；新任务出现后重新显示。
- 只跟踪 baseline 之后新增、`task.json.branch == worktree 分支` 的活动任务。
- 客户端关闭期间创建的任务不补发现（方案 A）。

## 发现与候选

- 监听 `<common_dir>/worktrees`；事件去抖后 `git worktree list --porcelain`。
- 发现时记录 `baselineHead` 和 baseline `.trellis/tasks` 目录集合。
- 为每个未接入 worktree 安装轻量 `.trellis` watcher；只读候选检测，不上传/不写 cursor。
- 候选：不在 baseline、活动目录、`task.json.id` 非空、`task.json.branch == worktree 分支`。
- `branch` 为空 → 等待 `task.py start`；其他分支 → 忽略；归档/删除 → 清理候选。
- 不安装 Git hook；`--no-checkout` 可发现但不会立即接入。

## 自动接入

- 复用 `inspect_project` → `preflight` → `attach`；不弹确认。
- team/project 来自源 binding；developer ID 取 `.trellis/.developer`（回退主 checkout），
  已存在项目成员可省略；缺失且服务端要求 → error。
- 首次同步模式固定 `safe`；接入成功后显式上传 tracked 候选，不批量上传继承任务。
- 失败进入 error，保留候选，退避重试/人工刷新；不重复创建 binding/taskSpace。
- 同一 worktree 的 attach/upload 串行。

## 上传过滤

- 首次上传只允许 `trackedTaskDirs` 候选；TaskSync 的 watcher/upload/deferred 补传必须先过滤。
- 接入后正常同步允许非 baseline、分支匹配的新活动任务，并加入 `trackedTaskDirs`；隐藏分支中
  的新任务也能上传。
- 继承任务、同分支旧任务、非 tracked 目录不得进入首次上传批次。
- 首次上传成功才 `visible`；失败保持隐藏并显示非阻塞错误。
- 空 taskSpace（候选在首次上传前消失）只记录诊断，不自动删除。

## 可见性与归档

- 服务端归档同步默认 `enabled=1`、`interval_seconds=300`；导入 archive 后
  `purgeArchivedTaskFiles` 对 active 写墓碑并递增 revision。
- 客户端不传 archive；`GET /api/agent/task-spaces/:id/tasks` 只返回 `sync_task.archived=0`
  的 active 任务，可作为 active 计数。
- 可见性计算需要同时看本地活动任务和服务端 active；查询失败保持上次状态，不因不确定隐藏。
- 服务端 taskSpace 不删除；隐藏仅是本客户端 ProjectRail/Board 活动视图过滤。

## Tauri 命令与权限

- 新命令必须 `ensure_board_caller`，只对当前 Board origin 可用。
- 同时加入 `permissions/desktop.toml` 和 `capabilities/board-local-association.json`。
- `desktop-state-changed` 增加 topic `worktrees`；事件只是失效通知，前端仍调用
  `list_worktree_status`。
- 无确认弹窗；只保留错误/重试/刷新。

## Git worktree 事实（本机验证）

- `git worktree list --porcelain` 输出 path/HEAD/branch/detached/locked/prunable，没有来源分支；
  本方案不需要来源。
- `git worktree add` 会触发 `post-checkout`（`--no-checkout` 不触发）；删除 worktree 没有 hook。
- linked worktree 的 `.git` 是文件；客户端已有 `resolve_git_dir` 读取 `gitdir:`/`commondir`。
- 主工作树、bare 仓库不登记。

## 关键文件

- `packages/desktop/src-tauri/src/agent/git.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/watch.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/*`（tracked 过滤/上传）
- `packages/desktop/src-tauri/src/agent/worktree/*`（新）
- `packages/desktop/src-tauri/src/agent/onboarding.rs`（复用 attach）
- `packages/desktop/src-tauri/src/main.rs`
- `packages/desktop/src-tauri/permissions/desktop.toml`
- `packages/desktop/src-tauri/capabilities/board-local-association.json`
- `packages/web/src/components/layout/ProjectRail.tsx`
