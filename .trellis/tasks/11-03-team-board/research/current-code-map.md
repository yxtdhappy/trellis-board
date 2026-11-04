# 当前代码事实与接入点

本文件只记录实现团队版前已核验的本仓库事实，不描述已实现能力。

## 运行与入口

- `README.md` 明确当前是单机 MVP；团队化缺口包括认证授权、共享数据、多主机仓库访问/Agent 和真实身份。
- `server/index.js` 当前固定调用 `server.listen(port, "127.0.0.1", ...)`，并在本机项目选择时调用 `powershell.exe`。
- `server/config.js` 默认项目是 `D:/wit/...` 本机绝对路径；`server/repositories.js` 校验本机目录与 `.trellis`。
- `package.json` 要求 Node `>=24`，测试命令是 `node --test tests/*.test.js`，没有 lint、typecheck 或 build。

## 持久化与扫描

- `server/database.js` 当前 `DATABASE_SCHEMA_VERSION=3`。
- 现有表包括 `repositories`、`task_stage`、`scan_cache`、`board_state`、`task_execution`、`task_tag`、`saved_view`、`task_event`、`task_dependency`、`app_meta`。
- `server/loader.js` 从 `project.path` 扫描；`server/scan-worker.js` 在 Worker 内使用自己的 SQLite 连接；`server/watcher.js` 监听本机 `.trellis`。
- `server/execution-store.js` 负责看板扩展数据；`server/task-location.js` 负责任务路径和稳定身份解析。
- `relativeDir` 相对仓库根；`taskKey=${projectId}::${relativeDir}`；`executionTaskKey=${projectId}::${task.id||dirName}`。三者用途不能混用。

## 任务写入

- `server/actions.js` 的 `createTask()` 调用本机 `task.py create`，先校验负责人目录 `.trellis/workspace/<assignee>`。
- `server/actions.js` 的 `assignTask()` 校验 workspace 后直接原子更新 `task.json.assignee`。
- `server/actions.js` 的 `runTaskPython(repoPath,args)` 当前在本机 spawn `python`；团队模式必须替换环境/位置，但不能复制其输入规则。
- 任务路径必须先经 `resolveTaskLocation()`，确认位于 `.trellis/tasks` 根内，并拒绝归档或身份冲突写入。
- `.trellis/scripts/common/task_store.py:1215` 在有 remote 的仓库中拒绝 `branch` 与 `base_branch` 同为真且相等；因此团队任务固定写 `branch=<sync_branch>`、`base_branch=null`，不能把两个字段都写成同一个共享分支。

## HTTP 与前端

- 现有 API 包括 `/api/board`、`/api/repositories*`、`/api/tasks*`、`/api/task`、依赖、撤销、保存视图和 WIP。
- 错误当前统一为 `{error: "中文错误"}`，多数为 400；团队协议需要增加稳定 `code` 和 401/403/409/502/503。
- `public/app.js` 通过 `/api/*` 轮询，所有服务端/用户文本须经过 `safe()`，Markdown 只走 `markdown.js` 的 `renderMarkdown()`。
- 原生 HTML/CSS/ESM，无框架、无构建；现有创建/委派对话框、项目筛选和团队视图可复用。

## 关键规范

- 多行 DB 写使用 `withTransaction()`。
- 文件写入使用临时文件 + rename。
- 长扫描放入 Worker，HTTP 主线程读取缓存。
- 看板投影形状不兼容变化时递增 `SCAN_SCHEMA_VERSION`（当前 11）。
- 改 HTTP、Worker 或刷新路径时必须做真实服务请求和页面验收，不能只跑单元测试。
