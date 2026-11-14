# E2E 报告：合并后任务归属与同步暂停

## 结论

基于 `8ddea09` 的 Windows 预构建客户端已在真实 Team 服务和真实仓库上通过功能验收：

- 已进入基线 `dev` HEAD 的 17 个历史任务被识别为 `dev` 有效归属，来源分支继续保留。
- 未进入基线 HEAD 的 `dev1` 探针仍按未合入任务暂停，没有上传，也没有生成合入证据。
- 默认任务查询只返回基线副本；`dev` 与 `feat/trellis-board` 重叠的 95 个稳定任务 ID
  没有重复展示。
- 本地服务器代理误转发已修复，客户端当前只建立到 Team 服务端的直连。
- ProjectRail 反复全量扫描任务正文造成的资源回归已修复。CPU 不再是修复前的持续高占用，
  但仍存在固定周期状态轮询带来的约 6% 单核占用，不能表述为完全无资源开销。

## 环境

- 时间：2026-11-14，Asia/Shanghai
- 服务端 PID `35308`，Team 模式，监听 `0.0.0.0:4317`
- 服务端访问地址：`http://192.168.65.27:4317`
- 数据库：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`
- 数据库状态：schema `12`、WAL、`PRAGMA integrity_check=ok`
- 当前 Agent：`08409005-9e1b-4e34-b668-6b56f92dcc91`
- 5 个正式 binding 均为 `approved/ready/listening`
- 被测客户端：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-v047-pre-8ddea09\portable\TrellisBoard_0.4.6_x64-portable\trellis-board-client.exe`
- 客户端文件名仍沿用 `v0.4.6`，实际代码为 `main@8ddea09`
- 预构建 ZIP SHA256：
  `59efb6553d776abad37a077c42a8690f99fe8547501bf07e08a893a10cb77b71`
- 预构建 CI：run `43535564677`，对应
  `8ddea095fc03a300a9e7dc5a6afc7772ca81f44f`

## 正式关联

| 仓库 | 分支 | taskSpace |
| --- | --- | --- |
| `D:\wit\mdp-backend-service` | `dev` | `7b8d00fa-f478-4c47-a0ef-615462d5bdb5` |
| `D:\wit\mdp-backend-web` | `dev` | `5efbba95-fdb1-4d09-bac1-dce7f11355c0` |
| `D:\wit\mdp-report-service` | `release/3.0.0/dev` | `06d8b69c-2be9-4fe4-9688-498980ad6bd1` |
| `D:\wit\mdp-management-web` | `release/3.0.0/dev` | `9269f774-5cd1-40e9-b3f0-4a5dc998b8b2` |
| `D:\wit\trellis-board` | `main` | `a8d34d0e-54af-4041-bb2c-4507665c7abe` |

## 合入归属

### 17 个历史任务：通过

`mdp-backend-web` 基线 taskSpace 当前为 revision `102`，索引已追平：

- `sync_task_merge_evidence`：17 条证据、17 个唯一任务 ID、7 个来源分支。
- `feat/dbx-micro-app-integration`：10 条。
- `feat/trellis-board`：2 条。
- 其余 5 个来源分支各 1 条。
- 所有证据类型均为 `tracked-in-head`。

真实归档索引页面在选中 `mdp-backend-web` 后显示“共 98 条”，并且可见：

- “补齐模型发布多引擎参数本地验收覆盖”显示“分支 dev · 来源 feat/trellis-board”。
- “模型发布新目标键与分区前端修复”显示“分支 dev · 来源 fix/model-publish-new-target”。
- “模型发布多引擎参数元数据与控件修复（前端）”显示“分支 dev · 来源 feat/trellis-board”。

### 未合入 `dev1` 探针：通过

在 `D:\wit\mdp-backend-web` 临时创建未提交目录
`.trellis/tasks/11-13-e2e-merged-ownership-v046-probe`，其中
`task.json.branch=dev1`、`base_branch=dev`。

- ProjectRail 立即出现 `ownershipPausedCount=1`。
- 等待超过 15 秒投影 TTL 和多个 3 秒状态周期后，服务端仍保持：
  merge evidence `17`、taskSpace revision `102`。
- 探针没有上传，没有生成合入证据，基线 revision 没有推进。
- 清理探针后，关联恢复 `paused=0/pending=0/ready`。

### 默认查询去重：通过

`mdp-backend-web` 有两个相关 taskSpace：

- `dev`：98 个索引任务、98 个唯一稳定任务 ID。
- `feat/trellis-board`：95 个索引任务、95 个唯一稳定任务 ID。
- 两边稳定任务 ID 重叠 95 个，来源 taskSpace 特有任务为 0。

真实鉴权 API `/api/tasks/query` 请求基线项目并读取归档任务：

- `total=98`，返回 98 条。
- 98 个唯一稳定任务 ID，重复数为 0。
- 返回的 taskSpace 只有基线 `dev`。
- 来源分布为 81 条 `dev`、17 条非 `dev`。

真实鉴权 API `/api/board` 在 `archived=1&limit=200` 时同样返回 98 条，
且 98 条均包含 `sourceBranchName`。

## 代理与连接

修复前，客户端的本地/私网地址请求可能误走系统代理 `127.0.0.1:7897`。
回环、私网、链路本地、IPv6 ULA/link-local 和 `.local` 现在默认绕过 HTTP 代理。

本轮稳定运行时检查到：

- 没有连接 `127.0.0.1:7897`。
- 只有两条到 `192.168.65.27:4317` 的已建立直连。

## 资源回归

### 已修复的根因

- ProjectRail 每 3 秒读取本地关联并展示归属状态。
- 旧实现会把该展示刷新扩大到递归读取、解析任务文件和计算摘要。
- 5 个关联同时刷新时，真实采样曾达到约 `25%` 单核平均和 `101.56%` 单次尖峰。

当前实现：

- 归属投影只枚举任务元数据并读取 `task.json.branch`。
- 15 秒内复用完整投影。
- TTL 到期后只校验分支和 HEAD；HEAD 未变时不重新扫描目录。
- watcher、binding 或 HEAD 变化会使缓存失效。
- 上下代计数阻止慢速旧计算在失效后回写缓存。
- 真正上传、冲突覆盖和延后补同步仍走完整文件读取和精确 CAS 门禁。

### 最终采样

`8ddea09` 预构建客户端：

- 首次 30 秒平均：`4.22%` 单核，最大 `14.06%`。
- 第二次 30 秒平均：`4.69%` 单核。
- 本轮复测 Board 页面：平均 `5.99%`、最小 `0`、最大 `17.19%`。
- 本轮复测归档页面：平均 `6.72%`、最小 `0`、最大 `18.75%`。
- 工作集约 `109.6 MB` 至 `111.7 MB`。
- 没有再出现周期性约 `100%` 的尖峰。

代码中仍有三个固定 3 秒状态轮询：Team 状态、本地关联、sidecar 状态。任务文件同步本身
仍由 watcher 和 SSE 驱动，不是每 3 秒重新同步任务正文。残余 CPU 尚未做逐项火焰图归因，
因此只能确认它不是旧的全量任务扫描回归；不能宣称已经降至 `<2%`。

## CI 与构建

run `43535564677` 全部成功：

- Node/Web 测试：成功。
- Desktop bundle：成功，包含 Rust 单测。
- Windows portable 打包、SHA256、smoke test 和 launch smoke test：成功。
- 同 head 的 dispatch build 按工作流条件跳过。

中间失败 run `43535060506` 位于 `b96bfcf`，原因是测试把 `Arc<HashSet>` 当作可移动集合；
`8ddea09` 已修正断言，最终 run 无需重复排查。

## 发布

annotated tag `v0.4.7` 指向 `2bd2e88`，tag push run `43538744681` 成功转发构建。

正式 Windows 构建 run `43538753452` 全部成功：

- Node/Web 全量测试：成功。
- Rust 单测：成功。
- Desktop bundle、portable 打包、SHA256、smoke test、launch smoke test：成功。
- Release 草稿创建、两个资产上传和公开发布：成功。

Release：

- 地址：`https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.7`
- `TrellisBoard_0.4.7_x64-portable.zip`：`3839625` bytes
- ZIP SHA256：
  `d1ed484138dfc333586816a0f6bd9611affd96d6933400eed25fbf18dfedc4e1`
- `TrellisBoard_0.4.7_x64-portable.zip.sha256`：`103` bytes

`v0.4.6` 继续固定在 `71b62f1`，没有被覆盖。
