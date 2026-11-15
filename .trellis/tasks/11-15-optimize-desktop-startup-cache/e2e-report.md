# 桌面冷启动持久缓存 E2E 报告

## v0.4.18 验证

### 环境与构建

- 客户端：`TrellisBoard 0.4.18` 正式 Release 便携包。
- 构建：GitHub Actions run `43681976942`，Node、Rust（166 tests）、Tauri 打包、便携包 smoke test
  和 Release 发布均成功。
- Release：<https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.18>。
- 包 SHA256：`4db17c55df066547d24149451767cc3dda9afebdc19afc0f5fc4bbe9408bbf8b`。
- 服务端：`http://192.168.65.27:4317`。
- 本地绑定：5 个 approved binding，706 个任务目录，4726 个受支持任务文件。
- 证据目录：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-e2e-v0418-20261115-134508`。

### v1 → v2 迁移启动

- 首次迁移会全量重建文件摘要索引，属于一次性成本。
- 5–30 秒进程树 CPU 平均 `124.50%`、峰值 `172.94%`。
- 该结果不用于判断稳定温启动是否达标。

### 正常温启动

有效证据只使用 `warm-restart-clean` 与 `warm-cpu-breakdown`。`warm-restart` 当时存在残留配置锁，
登录页失败，其 CPU 和截图结果无效，不作为结论依据。

- ProjectRail：5 秒和 30 秒截图均显示 5 个项目“已关联、同步正常”，满足 5 秒内可用。
- ownership：`taskFilesHashed=0`、`taskJsonParsed=0`、`gitCalls=0`，文件摘要和 HEAD 缓存均命中。
- CPU：5–30 秒进程树平均 `90.45%` 单核、峰值 `163.75%`。
- CPU 角色拆分：客户端主进程平均 `90.14%`，WebView 合计约 `4.80%`。
- 结论：正文读取和哈希已消除，但启动仍递归枚举约 4726 个任务文件元数据，CPU 未达 `<5%`。

## v0.4.19 待验证

- 索引 schema 升级为 `3`，保存 `filesComplete` 和 `dirtyTaskDirs`。
- 正常温启动每个仓库先用一次受限 `git status -- .trellis/tasks` 获取脏目录，再与上次脏目录取并集。
- 干净仓库不再递归枚举全部任务目录；只有脏目录参与文件枚举和 size/mtime 校准。
- rename/copy 或 Git 状态读取失败时回退全量扫描；写操作仍继续实时校验真实分支和文件内容。
- v0.4.19 首次启动会执行一次 v2 → v3 全量重建；只有之后的无变化温启动才按 `<5%` CPU 验收。

## 当前判定

- “5 秒内 ProjectRail 可用”：v0.4.18 通过。
- “正常重启不重新解析未变化 task.json、不重新哈希未变化任务文件”：v0.4.18 通过。
- “5–30 秒平均 CPU <5%”：v0.4.18 失败。
- “干净仓库温启动不递归枚举全部任务目录”：v0.4.19 尚未完成真实发行包 E2E。

## v0.4.24 验证

### 环境与构建

- 客户端：`TrellisBoard 0.4.24` 正式 Release 便携包。
- 构建：GitHub Actions run `43695625948`（tag push）与 `43695632049`（workflow dispatch）均成功；
  Node、Rust、Tauri、portable smoke test 和 Release 发布全部通过。
- Release：<https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.24>。
- 包 SHA256：`30780fd9312243e5fb9a36db6316b26f42dab7d930383d7c71df7000b100b8ef`。
- 默认数据：5 个 approved binding、706 个任务目录；`live-cursors.json` 中 pending 上传为
  `0`，5 个 taskSpace 的 deferred 均为空。
- 证据目录：`C:\Users\yuhaojie\AppData\Local\Temp\trellis-e2e-v0424-20261115`。

### 启动缓存与同步

- 5 个仓库均命中 `ownership-index.json`；`taskJsonParsed=0`、`taskFilesHashed=0`、
  `headCacheHit=true`，每仓库只执行一次 `git status`。
- 干净仓库显示 `scanMode=reused`；有变化的仓库只扫描 `dirtyTaskDirs`，没有递归枚举全部任务目录。
- 每仓库仍保留一次真实分支门禁校验，这是写操作安全要求，不属于重复扫描。
- 5.21 秒截图时 ProjectRail 已显示 5 个项目“已关联·同步正常”，但任务列表仍为 0。
- 约 19 秒时任务列表恢复为与重启前一致的 5 个进行中任务；`v0.4.24` 尚未达到
  “5 秒内任务集合一致”。

### CPU 归因

- 正常默认数据温启动 5–30 秒进程树平均约 `52%`、峰值约 `107%`；主进程占绝大部分。
- 空 `TRELLIS_DESKTOP_HOME` 对照仍为平均 `55.46%`，证明与 binding、任务解析和同步扫描无关。
  默认数据日志长度前后均为 `523095`，证明隔离目录没有读取默认 Agent 数据。
- 线程级采样显示 Tauri `main` 线程只消耗约 `0.22s`，Tokio worker 接近 `0`；单个注入线程
  在约 19 秒内持续吃满单核，累计约 `16.39s`。
- 默认数据启动的指令指针采样共 35 次落在
  `C:\Program Files (x86)\Qianxin\Tianqing\security\LHShield64.dll`，其余 18 次为 `ntdll.dll`
  调度路径。文件签名为有效，产品为“奇安信天擎”，版本 `1.0.0.1801`。
- 扣除非 Trellis 注入线程后，Trellis 自身线程合计约 `0.25s / 25s`，即约 `1%` 单核。
- 启动热点结束后继续观察 30 秒，进程 CPU 只增加约 `0.34s`，平均约 `1.1%` 单核，没有发现
  新的同步或轮询持续热点。
- 结论：客户端自身的启动缓存和同步 CPU 已达到目标；当前 `<5%` 总量验收被奇安信天擎注入线程
  阻塞。不得通过绕过、卸载或篡改企业安全组件来满足指标。

### 当前判定

- “5 秒内 ProjectRail 可用”：v0.4.24 通过。
- “未变化 task.json 不重新解析、文件不重新哈希、HEAD 不变不执行 ls-tree”：v0.4.24 通过。
- “干净仓库温启动不递归枚举全部任务目录”：v0.4.24 通过。
- “重启后任务集合最终一致、无 pending/deferred 积压”：v0.4.24 通过。
- “5 秒内任务集合一致”：v0.4.24 失败，任务约 19 秒恢复。
- “5–30 秒进程总 CPU <5%”：环境阻塞。Trellis 自身约 `1%`，总量约 `52%` 来自奇安信天擎。
