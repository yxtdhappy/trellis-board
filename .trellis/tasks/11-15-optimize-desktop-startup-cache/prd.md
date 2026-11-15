# 优化桌面客户端冷启动持久缓存

## Goal

降低桌面客户端每次进程重启时的冷启动 CPU 和耗时：在仓库、HEAD、绑定和任务文件均未变化时，
复用经过校验的本地索引，不再重复解析全部 `task.json`、重建全部 ownership 投影或执行无效 Git 查询；
同时保持任务归属、合并证据、分支门禁和冲突处理正确。

## Background / Confirmed Facts

- 当前 ownership 投影、HEAD 跟踪路径和 baseline ownership 均为进程内缓存：
  `ownership_projection_cache`、`head_tree_cache`、`baseline_owned`。
- 每次客户端 Agent 初始化都会创建新的 `TaskSync`，上述集合重新为空：
  [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:964)、
  [runtime.rs](../../../apps/desktop/src-tauri/src/agent/runtime.rs:63)。
- 进程退出或暂停后恢复会销毁旧 runtime；点击窗口 `X` 只是隐藏窗口，不等于退出进程。
- 持久文件仍保存 config、credential、`live-cursors.json`、revision、baseline、deferred 等业务状态；
  丢失的是根据本地仓库现场计算的派生索引。
- 当前 5 个正式绑定仓库共有约 `705` 个本地 `task.json`：
  `mdp-backend-service=138`、`mdp-backend-web=98`、`mdp-report-service=39`、
  `mdp-management-web=326`、`trellis-board=104`。
- 冷启动仍会递归遍历 `.trellis/tasks` 并解析任务元数据：
  [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:5366)、
  [device.rs](../../../apps/desktop/src-tauri/src/agent/device.rs:888)。
- Git 校验不是按文件执行。一次冷 ownership 校验每仓库通常包括仓库根、当前分支、HEAD 和一次
  `git ls-tree`；`ls-tree` 一次返回 HEAD 中全部 `.trellis` 路径，再在内存 `HashSet` 中按任务查询：
  [git.rs](../../../apps/desktop/src-tauri/src/agent/git.rs:375)、
  [git.rs](../../../apps/desktop/src-tauri/src/agent/git.rs:513)、
  [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:1210)。
- `git ls-tree` 的结果由 HEAD commit 唯一决定，同一个 commit 可以安全复用；
  当前该映射只存在于内存缓存，重启后丢失。
- 2026-11-14 实测 v0.4.15：启动前 30 秒平均约 `169.69%` 单核、峰值 `306.25%`、23 个 Git 子进程；
  启动约 4 分 33 秒后 cursor 才停止启动期写入。稳定后 15 秒平均 `1.98%`、Git 子进程 `0`。
- 当前尚无启动阶段 CPU 火焰图，不能把所有启动成本仅归因于 Git；文件遍历、JSON 解析、
  baseline 比较、IPC 和 WebView 初始化仍需在同一基线中分别观测。

## Requirements

### R1 持久缓存只作为可验证索引

- 可以持久化任务文件清单、`task.json` 元数据、HEAD commit 对应的 tracked path 集合和必要的校验键。
- 不得把上一次的 `paused/localDirs` 最终结果未经校验直接当作权威 ownership。
- 上传、拉取、合并、冲突处理和 ownership 写操作前继续使用实时分支门禁与内容校验。

### R2 增量判定

- 缓存需包含 schema、binding、repo path、branch、baseline branch、HEAD/ref 指纹和 Git index 指纹。
- 每个任务目录记录 `task.json` 元数据；每个支持的任务文件记录相对路径、大小、修改时间和内容摘要。
- 正常重启先用一次 `git status -- .trellis/tasks` 识别脏任务目录；干净目录直接复用，
  只枚举并读取当前脏目录及上次脏目录。未变化的任务文件不重复读取内容或计算 SHA256。
- 新增、删除和元数据变化的文件必须精确处理；候选变化文件重新计算摘要。

### R3 HEAD 跟踪路径缓存

- 持久化 `headCommit -> HEAD 中 .trellis 路径集合`。
- HEAD 未变化时不得重新执行 `git ls-tree`。
- HEAD/ref 变化时，每个仓库最多重新计算一次 tracked path 集合。
- 分支和仓库根优先从可信本地文件读取；直接读取失败或状态不一致时回退 Git 精确校验。

### R4 失效与失败关闭

- schema 不兼容、缓存损坏、路径越界、符号链接、读取失败、绑定变化或关键 Git 指纹变化时，
  丢弃对应缓存并全量重建。
- 缓存写入必须原子化，支持崩溃恢复和旧版本滚动升级；不得扩大现有路径或安全边界。
- 客户端运行期 watcher 发生变化时更新持久索引，不能只在正常退出时写盘。

### R5 Runtime 未就绪时的只读投影

- Agent runtime 尚未完成启动时，`list_local_associations` 也必须优先读取持久索引，不能回退到
  递归读取全部任务正文。
- 无缓存、缓存损坏或 schema 不匹配时允许沿用现有冷扫描，但每次启动只能发生一次。
- 后台权威校验完成后更新内存投影并通过现有状态事件通知 Board。

### R6 可观测性

- 记录每个仓库的缓存命中/未命中原因、枚举数量、重新解析数量、Git 调用次数和耗时。
- 不新增后台高频轮询；不得以常驻扫描换取启动速度。
- 修复前后使用同一机器、同一绑定、同一任务量和同一客户端页面做 A/B 测量。

### R7 正确性回归

- 覆盖正常工作区、未合入 `dev1` 任务、已合入基线任务、分支切换、HEAD/ref 变化、任务新增/修改/删除、
  缓存损坏、schema 升级、worktree、packed-refs 和 detached HEAD。
- 现有任务同步、ownership、deferred、冲突、分支门禁和断线恢复测试必须继续通过。

## Acceptance Criteria

- [ ] 正常重启且仓库与任务未变化时，不重新解析未变化的 `task.json`，ownership 路径不执行
      `git ls-tree` 或其他 Git 子进程。
- [ ] 正常重启时 ProjectRail 在 `5` 秒内恢复可用；从第 5 秒到第 30 秒，客户端进程树平均
      CPU `<5%` 单核，不再出现当前约 `169%` 的持续高占用。
- [ ] Agent runtime 尚未 ready 时，5 个关联仍从持久索引返回，不触发全任务正文读取。
- [ ] 正常重启后任务集合、paused/pending 数量、sidecar 状态和 5 个关联状态与重启前一致。
- [ ] 新增或修改单个任务时，只重新读取和解析受影响任务；删除任务时只移除对应索引项。
- [ ] 正常重启的启动 pull 不读取未变化任务文件正文；单个文件变化时只重新读取和哈希该文件。
- [ ] 干净仓库的温启动不得递归枚举全部任务目录；只有 `git status` 标出的脏目录参与增量扫描。
- [ ] HEAD 变化时，每个受影响仓库最多执行一次 `ls-tree`；未变化仓库不执行。
- [ ] 绑定变化、schema 升级、缓存损坏或路径安全校验失败时全量重建，不沿用旧 ownership。
- [ ] 分支不一致、合并后归属基线、deferred、冲突和上传前门禁行为保持不变。
- [ ] 同一环境下正常重启达到已确认的启动耗时和 CPU 目标。
- [ ] 真实 Windows 客户端完成 A/B、缓存命中、缓存失效、分支切换和重启 E2E。
- [ ] 不新增服务端 Git、协议变更、WebSocket 或新的高频后台扫描。

## Out Of Scope

- 取消分支门禁、`ls-tree` 合并判定或同步前的权威校验。
- 把 ownership 最终结果无校验地当作权威数据。
- 服务端接入 Git、改变任务快照协议或引入新的实时同步通道。
- 为了提升启动速度而跳过路径安全、符号链接或缓存损坏校验。

## Confirmed Decisions

- 2026-11-15 用户确认：缓存命中但后台权威校验尚未完成时，允许 ProjectRail 先展示缓存中的
  ownership/同步状态。
- 后台校验完成后通过现有 `desktop-state-changed`/权威查询合并结果。
- 上传、拉取、合并、冲突处理和 ownership 写操作仍必须实时校验；缓存不进入写操作信任边界。
- 2026-11-15 用户确认最终目标：ProjectRail 在 `5` 秒内恢复可用；缓存命中不重新解析未变化
  `task.json`、不执行 `git ls-tree`；启动 5 秒后的 25 秒进程树平均 CPU `<5%` 单核。
- 文件 ID 不作为缓存键：当前跨平台标准库不能稳定取得文件 ID，使用 size、mtime 与上次
  内容 SHA256，并由 task/Git watcher、Git index 指纹和写操作实时校验兜底。该同 size+mtime
  低概率漏检边界已在 design 的风险章节明确记录。
