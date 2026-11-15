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
