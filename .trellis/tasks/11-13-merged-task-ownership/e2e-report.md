# E2E 报告：合并后任务归属与同步暂停

## 当前结论

修复前客户端 `v0.4.2` 的真实 E2E 未通过，已确认两个产品缺陷：

1. `mdp-backend-web` 的 17 个来源分支不是 `dev`、但 `task.json` 已进入当前
   `dev` HEAD 的历史任务，仍被 ProjectRail 显示为“因分支不匹配暂停”。
2. 新客户端启动后没有主动为这 17 个已有任务补交 `tracked-in-head` 合入证据。

工作区已有对应修复，但尚未编译进正在分发的 `v0.4.2` 客户端，因此不能把本轮结果
记作修复后 E2E 通过。

## 环境

- 时间：2026-11-13
- 服务端：PID `38092`，`http://127.0.0.1:4317`，`status=ok`，`mode=team`
- 数据库：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`
- Schema：`12`
- 客户端：PID `35016`，版本 `0.4.2`
- 客户端路径：
  `C:\Users\yuhaojie\AppData\Local\TrellisBoard_0.4.2_x64-portable\TrellisBoard_0.4.2_x64-portable\trellis-board-client.exe`
- 客户端 SHA256：
  `1FAC1CF40D26BF925143D7477154DB6C7F45D34479C037F6E611F1A913E25D05`
- 被测仓库：`D:\wit\mdp-backend-web`
- 仓库分支：`dev`
- 仓库 HEAD：`4a405396a24274d55c31c805033ff3eded947652`

## 修复前用例

### 1. 启动接纳：通过

新客户端启动后，`trellis-board/main` 自动接纳 3 个来源分支任务：

- `branch-listener-unbind-lifecycle`
- `branch-retirement-lifecycle`
- `desktop-ui-shadcn-migration`

数据库 `sync_task_merge_evidence` 新增 3 条证据，审计事件 ID 25-27 为
`task_merge_evidence_accepted`。UI 显示有效分支 `main` 和对应来源分支。

### 2. 已合入历史任务：失败

`mdp-backend-web` 当前有 17 个 `task.json.branch != dev` 的历史任务，17 个
`task.json` 全部存在于当前 `dev` HEAD。

实际结果：

- ProjectRail：`mdp-backend-web · 17 个任务因分支不匹配暂停`
- `sync_task_merge_evidence`：`mdp-backend-web` 证据数为 0
- 默认任务查询能返回这 17 个唯一任务，但 `sourceBranchName=dev`

根因：

- 本地关联计数仍只比较 `task.json.branch` 与 binding 分支。
- 启动流程没有 watcher 事件，因此没有触发既有任务的主动 reconciliation。

### 3. 未合入反向探针：通过

创建未提交到 HEAD 的 `.trellis/tasks/11-13-e2e-merged-ownership-unmerged`，
内容为 `branch=dev1`。

实际结果：

- 约 8 秒后暂停计数从 17 变为 18。
- 服务端没有新增合入证据或审计事件。
- 删除探针后计数恢复 17，目录已清理。

### 4. 服务端来源副本去重：通过

`mdp-backend-web`：

- 基线 `dev` taskSpace：98 个索引任务
- 来源 `feat/trellis-board` taskSpace：95 个索引任务
- 95 个稳定任务 ID 全部重叠
- 默认查询只返回 98 个基线任务，没有显示 193 个重复项

## 工作区修复

- `device.rs`：本地关联暂停数复用同步门禁的 HEAD 判定。
- `task_sync.rs`：基线绑定共享 HEAD tree 缓存；启动或 binding 更新后补一次
  已有错分支任务的合入证据。
- `runtime.rs`：向关联列表暴露运行时 `TaskSync`。
- `agent_service.rs`：Agent 运行时存在时把同一 `TaskSync` 传给关联列表。

当前实现只在以下条件读取 HEAD tree：

- binding 是项目基线；
- 存在 `task.json.branch != binding.branch` 的候选任务；
- 同一 taskSpace 的 branch/HEAD 尚未缓存。

普通同分支任务不执行 `git ls-tree`。同一 HEAD 的多个任务共享一次 tree 扫描；
HEAD 未变化时只执行轻量 `git rev-parse`。启动 reconciliation 只在初始 pull 或
binding 发生变化时执行，不挂到普通 watcher 或每次 SSE 上报。

## 代码级验证

- `node --test` 聚焦回归：`64/64` 通过。
- `npx tsc -b apps/web/tsconfig.json --pretty false`：通过。
- Web lint：通过，仅已有 warning。
- `git diff --check`：通过。
- Rust 聚焦测试/编译：未执行。当前机器没有 `cargo`、`rustc`、`rustfmt`。

## 待执行

1. 用包含工作区修复的提交构建新的 portable 客户端。
2. 重启客户端并确认新 EXE 的启动时间和版本。
3. 确认 ProjectRail 的暂停数从 17 收敛到 0。
4. 确认数据库新增 17 条 `mdp-backend-web` 合入证据，且来源分支保留。
5. 确认默认查询的 17 个任务返回非 `dev` 的来源分支。
6. 重新创建并删除未合入探针，确认临时计数 `+1` 且服务端无证据。
7. 观察 30-60 秒，确认无重复证据、无持续 `ls-tree`、客户端 CPU 不明显异常。
