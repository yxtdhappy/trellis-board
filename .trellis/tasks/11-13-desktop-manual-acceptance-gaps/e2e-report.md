# E2E 验收报告 · 桌面接入真机验收补齐

对应任务：`11-13-desktop-manual-acceptance-gaps`
对应 PRD：`prd.md`（R1–R8、AC1–AC8）
执行人：flyfly6（AI 协助，用户手动完成三次原生文件选择）
执行时间：2026-11-13 17:05–18:20 +08:00

## 1. 测试拓扑

| 层 | 进程 / 地址 | 证据 |
| --- | --- | --- |
| 真实桌面客户端 | `trellis-board-client.exe`（源码 `main` 自构建，`cargo tauri build` 5m47s），PID `32188` → `20008` → `19152` | 数据目录 `C:\projects\trellis-board\.tmp-verify\clients\c1`；UI 由服务端 URL 加载 |
| 真实 Team 服务 | `apps/server/index.js`，`http://127.0.0.1:4399`，PID `27424`（过程中被停用以模拟断网） | `/api/health` 200 |
| 隔离数据根 | `C:\projects\_trellis-board-e2e`（`server-data` / `repo` / `origin.git`） | 满足 `TRELLIS_BOARD_DATA_DIR` 必须位于源码工作树之外 |
| 测试仓库 | `C:\projects\_trellis-board-e2e\repo`，分支 `main`，远端 `C:\projects\_trellis-board-e2e\origin.git` | 首轮无任务；第二轮含 `11-13-fixture-write-probe`；第三轮补 `.trellis/scripts/`（`3582330`）、新增超限探针（`400f62c`，1101 文件）、随后删除（`1d0fa1f`） |
| 观测通道 | WebView2 CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9301`） | 只连 index 页面，过滤 `control.html` target |
| 数据库 | `C:\projects\_trellis-board-e2e\server-data\board.sqlite` | 只读查询校验写入与审计 |

用户自己的 `0.4.0` 便携客户端（PID `12596`）在测试开始前已按用户选择终止，避免单实例转发干扰。

## 2. 证据（按 AC）

### AC1 三客户端在线切换 — 阻塞

- 同机第二个真实客户端（用户 `e2e_b`、独立数据目录 `c2`、独立 CDP 9302）启动后立即 `exited 0`，未产生第二个进程；`Get-Process trellis-board-client` 始终只有首实例 PID `19152`。
- 根因：`apps/desktop/src-tauri/Cargo.toml:15` 注册 `tauri-plugin-single-instance`，`apps/desktop/src-tauri/src/main.rs:906` 无条件初始化；后启动实例把 argv 转发给首实例后退出。
- 结论：**本轮无法完成**。需求是“三台独立机器”，同机多开需改动产品代码（禁用单实例插件），超出“只补验收证据、不改代码”的范围。建议在多台真机或临时构建上补测。
- 已有替代证据：`11-12-branch-listener-unbind-lifecycle` 用隔离 DB fixture + 真实服务聚合 + 真实 UI 覆盖了 `3/3 → 2/2 → 0/0` 的展示与聚合。

### AC2 真实 60s 超时自动离线 — 通过

| 观测点 | 值 |
| --- | --- |
| 杀进程前 | `listenerState=online`、`onlineListenerCount=1`、心跳 `listenerReportedAt=2026-11-13T09:23:37.606Z` |
| 最后一次心跳 | `2026-11-13T09:23:54.078Z`（PID `20008` 被 `taskkill /F` 后不再更新） |
| 翻转时刻 | 杀进程后第 `63s` 采样：`listenerState=inactive`、`onlineListenerCount=0`、`listeners[0].online=false` |
| 60s 内 | 第 `3s` 采样仍为 `online`，无抖动 |
| approved binding | 始终保持 `approved`（仅在线标记翻转） |

判定依据源码：`apps/server/team/task-space-service.js:113` `listenerState()` 与 `:78-104` `listenerSummaries()` 的 `staleCutoff`（`config.agentStaleMs || 60_000`，`apps/server/team/http.js:1420`）。

### AC3 断网解绑 → `detachPending` → 恢复重试 — 通过

| 步骤 | 证据 |
| --- | --- |
| 停服务端（PID `27424`）后点“不再同步此分支” | UI 变为 `已关联 · 服务端解绑待确认`；详情：`本地已停止同步，服务端未确认：无法连接服务端: error sending request for url (http://127.0.0.1:4399/api/agent/task-spaces/bd825555-3c23-4d32-9682-acc0c8f4527a/detach)`；分支行出现 `服务端解绑待确认` |
| 客户端本地状态 | `runtime.json` `status=error`、`lastError` 为心跳请求失败；该分支 watcher 已停 |
| 重启服务端 | `/api/health` 200 后 30s 内 `sync_agent_binding.sync_status` 变为 `revoked`、`is_listening=0` |
| UI 恢复 | 变为 `未关联 · 关联本地仓库`、`在线监听 0 / 已关联 0 · 无客户端关联`，`服务端解绑待确认` 消失 |
| 本地清理 | `agent/config.json` `bindings: []`；`agent/live-cursors.json` `taskSpaces: {}` |
| 审计不重复 | `audit_event` 中 `task_space_binding_detached` 计数 `1`（失败的一次未产生审计，恢复后成功一次） |

### AC4 解绑后停止写入 — 通过

| 步骤 | 证据 |
| --- | --- |
| 解绑前基线 | `sync_task_space_file=2`、`sync_task_space_batch=1`、`agent_command=0` |
| 服务端在线状态下点“不再同步”（关联态 `在线监听 1 / 已关联 1`） | 1.6s 内 UI 变 `未关联 · 关联本地仓库`、`0/0 无客户端关联` |
| 解绑后本地新增任务目录并提交 | `git commit e318ae6`（`.trellis/tasks/11-13-after-detach-probe/prd.md`） |
| 20s 后复测 | `sync_task_space_file=2`、`sync_task_space_batch=1`、`agent_command=0`（无变化） |

### AC5 浅色/深色 × 1440/1024/860px — 通过（附带新缺陷）

用 `Emulation.setDeviceMetricsOverride`（900 高）+ 应用内主题切换，同一连接内截图（避免覆盖失效）。

| 宽度 | 浅色 | 深色 | 横向溢出 | 项目栏 | 主区滚动容器 |
| --- | --- | --- | --- | --- | --- |
| 1440 | 通过 | 通过 | 无 | 显示 | `MAIN.flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4`（唯一） |
| 1024 | 通过 | 通过 | 无 | 显示（`lg` 断点） | 同上 |
| 860 | 通过 | 通过 | 无 | 隐藏 | 同上 |

根字号为应用偏好 `20px`（非 CSS media），符合 `11-13-appearance-settings` 的实现。

**新发现既有缺陷（与本任务无关，未修）**：TopBar 导航在 1024/860px 下折行。
`measure`：导航项高度 `1440 → 38px`、`1024 → 62px`、`860 → 132px`（“任务流水线”竖排 4 行、“团队视角/归档索引”错列并与 `Trellis Board` 重叠）。截图见 `.tmp-verify/rs-1024-light.png`、`.tmp-verify/rs-860-light.png`。应答文案本身未截断，横向无溢出，但视觉破损。建议另开响应式修复任务。

### AC6 正常接入弹窗完成临时项目绑定 — 通过

两轮均通过正常 UI 路径（用户手动在原生框选择 `C:\projects\_trellis-board-e2e\repo`）：

| 轮次 | 证据 |
| --- | --- |
| 首轮（服务端无该分支快照） | 弹窗渲染仓库 `repo` / 分支 `main` / 远端 `C:\projects\_trellis-board-e2e\origin.git` / `Trellis 已初始化` / `Git 状态 相关路径干净` / 团队 `E2E 验收` / developer ID `e2e_a` / 19 个 Agent 选项；“检查任务差异”约 2.5s 后变为“暂不接入 / 接入并上传本地任务 + 服务端还没有这个分支的任务快照…”；全程无“没有返回有效的任务预检结果”；点击“接入并上传本地任务”约 5.5s 后弹窗关闭，侧栏 `已关联 · 正在同步已有任务` → 3s 后 `已关联 · 同步正常`、`在线监听 1 / 已关联 1` |
| 次轮（服务端已有快照） | 预检返回“双方任务一致，可以安全接入”“服务端版本 1，没有需要额外处理的差异。”，按钮为“接入任务空间”；接入后 `已关联 · 同步正常` |

同时验证了 PRD 修复项：弹窗内滚动容器只有 `DialogBody`（`DIV.min-h-0 flex-1 overflow-y-auto overscroll-contain flex flex-col gap-4`，`scrollHeight 887 / clientHeight 599`），内层 Agent 网格无独立滚动条。

### AC7 其余报告验证边界 — 部分完成 / 部分标注原因

| 报告 | 要求 | 本轮结论 |
| --- | --- | --- |
| `11-12-branch-listener-unbind-lifecycle` | 三客户端 / 60s 超时 / 断网重试 / 停止写入 / 响应式 / 接入弹窗 | 除三客户端（阻塞）外全部通过，见 AC1–AC6 |
| `11-13-fix-agent-task-scan-file-limit` | 真实单批边界拒绝（单任务目录 >1024 文件被拒） | 已通过：1101 文件的真实任务目录在补传时被 `单批任务文件不能超过 1024 个` 明确拒绝，服务端无副作用，见 §3 |
| `11-10-team-archive-index-query` | 独立模式归档在独立实例的浏览器回归 | 未执行：需以 `TRELLIS_BOARD_MODE=standalone` 另起实例并用浏览器回归归档索引；与桌面接入链路无交集，建议随该功能下次变更验证 |
| `11-11-fix-project-rail-sync-status-leak` | 用真实 WebView2 替换最小 IPC mock | 已覆盖：本轮真实项目栏展示了 `已关联 · 同步正常`、`已关联 · 服务端解绑待确认`、`未关联 · 关联本地仓库`、`在线监听 0 /… · 旧客户端，监听状态未知`、`在线监听 0/0 无客户端关联` 五种状态，无状态泄漏 |
| `11-12-support-dsh-agent-onboarding` | 真实 WebView2 路径替换 IPC mock | 未执行：需安装 DSH agent 并在真机跑完整 onboarding；mock 与真实差异集中在 agent 探测，与本任务链路无关，建议单独排期 |
| `11-12-harden-desktop-sidecar-lifecycle` | 侧车超时与 ProjectRail 防重入可复现夹具 | 未执行：需要可控的侧车挂起注入（会污染本机运行环境），建议在该任务内用独立构建补夹具 |

### AC8 结论回写 — 已完成

- 本文件。
- `11-12-branch-listener-unbind-lifecycle/e2e-report.md` §7 追加真机复核结论，§8 更新整体结论。

## 3. 单批 1024 文件边界（补充验证，第三轮已执行）

构造超限数据：在真机仓库内新增 `.trellis/tasks/11-13-oversize-probe/`（`task.json` + `f0000.md`…`f1099.md`，共 1101 个文件），提交 `400f62c`。

| 步骤 | 证据 |
| --- | --- |
| 前置 | 客户端仍需用户手动在原生框选择 `C:\projects\_trellis-board-e2e\repo`（第三次），弹窗与首轮一致 |
| 预检不拦 | “检查任务差异”约 5.1s 返回“本地与服务端的任务需要确认：服务端独有 0 个，本地独有 1 个，内容冲突 0 个”，按钮为 `暂不接入 / 仅同步无冲突项 / 查看并处理差异`——超限判定不在预检阶段 |
| 接入 | 点“仅同步无冲突项”约 10.2s 后弹窗关闭，侧栏 `已关联 · 正在同步已有任务`；首次同步策略把本地独有任务目录记为 `deferred`（`agent/live-cursors.json` `taskSpaces.<id>.deferred` 记录了整目录 1101 个文件），不上传 |
| 首次补传被其它门拦截 | 点侧栏“上传 main 的 2 个本地任务”→ toast `项目缺少 .trellis/scripts/task.py，请检查 Trellis 初始化`。根因：上传前会调用 `set_task_directory_branch`（`apps/desktop/src-tauri/src/agent/task_sync.rs:1695`、`apps/desktop/src-tauri/src/agent/task_command.rs:800-813`）执行 `task.py set-branch`，脚本缺失即失败（`apps/desktop/src-tauri/src/agent/task_command.rs:726-733`）。夹具仓库补入 `.trellis/scripts/`（提交 `3582330`）后重试 |
| **明确拒绝** | 重试 toast：`单批任务文件不能超过 1024 个`（`apps/desktop/src-tauri/src/agent/task_sync.rs:368-374` `validate_upload_batch`，上限 `TASK_SNAPSHOT_MAX_FILES = 1024`，`:16`）；侧栏保持 `已关联 · 2 个本地任务未同步`，详情 `11-13-after-detach-probe、11-13-oversize-probe` |
| 服务端无副作用 | 拒绝后 `sync_task_space` 仍 `revision=1`、`indexed_revision=1`、`status=active`、`last_error=null`；`sync_task_space_file` 只有 `fixture-write-probe` 的 2 行；`sync_task_space_batch` 仍 1 行 |
| 恢复 | 删除超限目录并提交 `1d0fa1f`，约 9s 后侧栏自动降为 `已关联 · 1 个本地任务未同步`（详情仅 `11-13-after-detach-probe`），说明拒绝不会污染本地游标；随后的补传返回 `仍有 1 个本地任务待处理，请查看同步确认窗口`（服务端无该任务快照，需要在同步确认窗口处理，属预期交互） |

结论：单任务目录超过 1024 文件时，客户端在单批校验处以可读文案明确拒绝，服务端与游标均无残留；`11-13-fix-agent-task-scan-file-limit` 的“真实单批边界拒绝”验证边界就此闭合。

## 4. 环境限制与风险

- 单实例插件使同机多客户端不可行（AC1），产品行为本身符合便携客户端预期，但对验收手段形成硬约束。
- 客户端 UI 由服务端 URL 加载：停服务端时页面仍可交互（SPA 已加载），这正是断网解绑可被触发的前提；服务端恢复后页面同样无需重启即可恢复。
- 客户端数据目录必须与服务端数据目录分离；本轮回填时 `agent/runtime.json` 在一次服务端停机窗口内记录了心跳失败，恢复后自行消除。

## 5. 清理

- `.tmp-verify/`（夹具脚本与截图）与 `C:\projects\_trellis-board-e2e`（隔离服务端数据、仓库、bare 远端）为临时产物，验收后删除。
- 测试客户端进程在验收结束时关闭；用户自己的 `0.4.0` 便携客户端不受影响。
