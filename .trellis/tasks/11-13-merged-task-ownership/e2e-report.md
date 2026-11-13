# E2E 报告：合并后任务归属与同步暂停

## 结论

`v0.4.6` 预构建客户端已通过真实服务和真实仓库验收：

- 已合入基线的来源分支任务不再误显示为暂停，`mdp-backend-web` 稳定生成 17 条唯一合入证据。
- 未进入基线 HEAD 的 `dev1` 探针仍按未合入处理，没有生成合入证据。
- ProjectRail 每 3 秒轮询导致的资源回归已修复，稳定采样从 `v0.4.5` 的约
  `107%` 单核降到 `0.05%–0.16%`，工作集约 `54 MB`。
- 服务端仍不执行项目 Git；所有 Git 判定都在客户端完成。

## 环境

- 时间：2026-11-14
- 服务端：PID `14404`，`http://127.0.0.1:4317`，Team 模式
- 数据库：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`
- 被测仓库：`D:\wit\mdp-backend-web`
- 仓库分支：`dev`
- 仓库 HEAD：`4a405396a24274d55c31c805033ff3eded947652`
- 客户端：`v0.4.6` 预构建 portable
- 客户端路径：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-v046-pre\TrellisBoard_0.4.6_x64-portable\trellis-board-client.exe`
- 预构建 CI：run `43460129753`，Node/Web 测试、Rust 单测、desktop bundle、
  portable smoke test 全部通过

## 归属验收

### 已合入任务：通过

`mdp-backend-web` 的基线 taskSpace 为
`5efbba95-fdb1-4d09-bac1-dce7f11355c0`，当前数据库中：

- `sync_task_merge_evidence`：17 条证据
- 唯一 task ID：17
- 唯一任务目录：17
- 对应基线 HEAD：1 个
- 来源分支正确保留，包括：
  - `feat/dbx-micro-app-integration`：10
  - `feat/trellis-board`：2
  - 其余 5 个来源分支各 1

### 未合入探针：通过

创建未提交目录
`.trellis/tasks/11-13-e2e-merged-ownership-v046-probe`，`task.json.branch=dev1`。

- 等待超过 15 秒缓存 TTL 后，数据库证据总数仍为 17。
- 该探针的合入证据数为 0。
- 删除探针后目录已清理。

### 服务端去重：通过

`mdp-backend-web` 同项目存在两个 taskSpace：

- `dev`：98 个索引任务，98 个唯一 execution key
- `feat/trellis-board`：95 个索引任务，95 个唯一 execution key
- 两个 taskSpace 的稳定任务 ID：95 个完全重叠
- 默认查询继续以当前基线 taskSpace 为准，没有把来源副本重复展示

## 资源回归

### `v0.4.5` 问题

`v0.4.5` 已避免重复 `ls-tree`，但 ProjectRail 每 3 秒仍会重新递归读取并解析
所有本地任务文件。5 个本地关联同时计算时，真实采样仍达到约 `107%` 单核，
无法接受。

### `v0.4.6` 修复

- 在 `TaskSync` 中缓存完整归属投影：暂停集合和本地任务目录集合。
- 缓存键按本地关联区分，同时校验分支、基线分支和仓库路径。
- 展示投影 TTL 为 15 秒；ProjectRail 的 3 秒轮询只复用缓存。
- 绑定集合或仓库关联变化时立即清空缓存。
- 真正上传、冲突处理和同步门禁仍逐次精确校验分支、HEAD 和工作区，不放宽信任边界。

### 修复后采样

预构建客户端稳定运行后，连续 30 秒采样：

- 主进程 CPU：`0.16%` 单核
- 无直连 Git 子进程
- 工作集：`54.1 MB`

执行并清理未合入探针后再次采样 30 秒：

- 主进程 CPU：`0.05%` 单核
- 工作集：`54.1 MB`

预构建 CI 的 Rust 单测包含：

- 连续轮询复用 HEAD tree；
- 缓存过期后重新校验；
- 完整归属投影在 TTL 内复用；
- TTL 过期后能发现新增未合入任务。

## 代码级验证

- 本地 Node 全量测试：486 项，484 通过、1 跳过；唯一
  `team-static` 临时目录 `EPERM` 清理失败单测复跑 `3/3` 通过。
- GitHub Actions Node/Web 测试：通过。
- GitHub Actions Rust 单测：通过。
- Desktop bundle：通过。
- Portable ZIP 和 SHA256 校验：通过。
- Portable smoke test：通过。
- `git diff --check`：通过。

## 发布

预构建通过后再创建 `v0.4.6` tag。tag 触发的 GitHub Actions 负责最终带版本号
stamp、重新构建、便携包 smoke test 和 immutable Release 资产上传。
