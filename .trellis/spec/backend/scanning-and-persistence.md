# 扫描与持久化

## 扫描输入

每个仓库的扫描根为 `.trellis/tasks`。只有包含 `task.json` 的任务目录成为任务；`archive/` 下任意嵌套层级的任务仍会被发现并标记为归档。

任务证据主要来自：

- `task.json`、`prd.md`、`design.md`、`implement.md`。
- `implementation-report.md`、`check-report.md`、`e2e-report.md`。
- `research/` 目录。
- `implement.jsonl`、`check.jsonl` 条数。
- 开发者 workspace 的 `index.md` 和 `journal-*.md`。
- Git 分支元数据。

阶段判断读取原文件。详情展示时每个产物预览截断到 `40_000` 字符，但截断不能影响阶段推导。

## 阶段语义

13 个阶段顺序为：

```text
prd -> research -> design -> implementPlan -> context -> review
    -> implement -> check -> e2e -> spec -> commit -> archive -> journal
```

推导依据包括 PRD 的 Requirements/Acceptance Criteria 语义、报告内容、`task.status`、JSONL 记录、workspace journal、相关文件、提交和归档位置。进度只统计必需阶段；`e2e` 标记为可选，缺少它不阻塞后续收尾。

E2E 只接受明确的执行完成证据。`implement.md` 中的计划、条件句或“下一步做 E2E”不能计为完成；否定语句也不能计为完成。[tests/loader.test.js](../../../tests/loader.test.js) 对这些分支有回归。

人工阶段由 `setManualStage()` 写入 SQLite `task_stage` 表，键为 `${projectId}/${relativeDir}`。`withManualStages()` 只覆盖被勾选的阶段，不自动补齐前序阶段。移除项目时必须在同一事务中清理该 `${projectId}/` 前缀下的人工阶段，避免项目重新加入或任务路径复用时继承旧值。

## 列表与详情

`scanRepository()` 生成完整扫描结果。列表 API 使用 `toTaskListItem()` 白名单字段，避免把 `artifacts` 正文和额外详情带出；`scanTask()` 为详情返回最新单任务扫描结果。

`taskKey` 是 `${project.id}::${relativeDir}`。缓存、前端选中态、详情合并和人工阶段相关请求都以稳定身份匹配。

详情合并使用 `mergeTaskDetail()`：先合并磁盘详情与缓存列表/分组字段，再应用 SQLite 当前人工阶段。SQLite 人工阶段必须是最终值，缓存中的 `stages`、`manualStage` 和 `derivedStage` 不得反向覆盖。

## 缓存

`loader.js` 维护模块级 `taskScanCache` 和 `gitMetadataCache`：

- 任务缓存按文件 stat 签名判断是否复用。
- Git 元数据缓存 TTL 为 `60_000ms`。
- 消失的任务会从缓存中清理。
- 单个任务变化可以走 `refreshCachedTask()`；workspace 或关系变化可能要求更宽范围重算。

HTTP 层把完整 board 持久化到 SQLite `scan_cache` 单行，并用 `SCAN_SCHEMA_VERSION` 校验。读取旧版本缓存时视为无效。SQLite `board_state` 保存刷新运行状态；两者都不是业务事实来源，仓库任务文件和 SQLite `task_stage` 才是。

## SQLite 持久化

`data/board.sqlite` 使用 Node 24 内置 `node:sqlite`，没有第三方驱动。主线程共享一个进程级连接，扫描 Worker 在自身线程内另开连接；`DatabaseSync` 不跨线程传递。

`database.js` 是 schema 和迁移的唯一所有者：

- schema v1 包含 `app_meta`、`repositories`、`task_stage`、`scan_cache`、`board_state`。
- 启用 WAL、外键、`busy_timeout=5000` 和 `synchronous=NORMAL`。
- 首次初始化在 `BEGIN IMMEDIATE` 中一次性导入四个旧 JSON，并写入 `legacy_json_imported_v1`。
- 迁移后不再读写旧 JSON；它们只作为迁移来源和回滚备份。
- 损坏的旧 JSON 记录警告并跳过，不阻止服务启动。
- 项目批量新增、删除及重排、看板状态多字段更新必须在事务中完成。

扫描缓存中的 JSON 损坏或 schema 版本不匹配都视为 cache miss。SQLite 打开、schema、迁移和运行期查询失败是致命错误，不回退到旧 JSON。

## 刷新与监听

[server/watcher.js](../../../server/watcher.js) 只监听白名单仓库的：

- `.trellis/tasks`
- `.trellis/workspace`
- `.trellis/.developer`

路径统一为 `/`。当前使用递归 `fs.watch`，主要面向 Windows/macOS 本机；Linux 或网络盘不支持递归监听时保留手动刷新回退。

事件进入 [server/index.js](../../../server/index.js) 后经过：

1. 默认 `400ms` 防抖，可由 `TRELLIS_WATCH_DEBOUNCE_MS` 调整，最低 `100ms`。
2. 合并多个事件。
3. 若已有 `inflightScan`，写入 `queuedRefresh`。
4. 当前扫描结束后再执行排队刷新，避免最后一次变更丢失。

扫描范围由事件类型决定：

- `tasks/` 下能解析到具体任务目录的事件只调用 `refreshCachedTask()`，刷新该任务。
- `workspace/`、`.developer` 或无法解析到任务目录的 `tasks/` 事件会重扫对应仓库。
- Worker 冷启动、`POST /api/board/refresh` 和 `POST /api/board/refresh/start` 触发仓库级完整扫描；单任务和仓库级增量刷新复用 Worker 内存中的其他仓库结果。

无论本次文件扫描范围多大，`createBoard()` 都会把当前缓存中的全部仓库任务交给 `linkTaskGroups()` 重建跨仓库关系，再生成列表投影。因此监听刷新不是“每次全量重扫全部仓库”；除非同时处理缓存与跨仓库关系，也不要删掉这一步全局关系重建。

## 父子任务

关系来源包括明确 `parent`、`children` 和约定的 `meta.*Task`。仓库允许跨项目引用。冲突、缺失、自引用和循环会产生警告；关系无效时父任务停止继承子任务进度。

父任务只在子任务具备实现、检查等真实证据时汇总对应阶段，不凭空补齐父任务的规划阶段。

## 修改检查

- [ ] 扫描只把包含 `task.json` 的目录认作任务。
- [ ] 新证据文件已加入读取和缓存签名范围。
- [ ] 缓存失效范围覆盖 workspace、关系和 Git 元数据影响。
- [ ] E2E 计划/否定/完成三种语义均有测试。
- [ ] 输出结构不兼容时更新 `SCAN_SCHEMA_VERSION`。
- [ ] 删除或重命名任务后缓存能清理旧项。
- [ ] 移除项目时同一事务清理对应 `task_stage`，且不会误删相似项目 ID 的人工阶段。
