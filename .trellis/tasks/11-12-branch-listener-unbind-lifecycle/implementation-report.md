# 实施报告

## 实施边界

- 任务：分支监听状态与主动解绑生命周期。
- 当前 `main` 基线：`87346c3`，仓库已迁移为 `apps/server`、`apps/web`、
  `apps/desktop`、`packages/shared` 的 monorepo，桌面 Agent 使用 Rust/Tauri。
- 早期实现位于 `D:\wit\trellis-board-branch-listener-unbind-lifecycle`，分支
  `codex/branch-listener-unbind-lifecycle`，只作为旧 Node sidecar 结构的迁移来源。
- 当前集成分支：`codex/branch-listener-unbind-lifecycle-main`。
- 当前集成工作区：`D:\wit\trellis-board-branch-listener-unbind-integration`。
- 主工作区 `D:\wit\trellis-board` 保持 `main` 和原有未提交/未跟踪内容，本任务未修改该目录。

## 核心实现

### 数据库与服务端

- `apps/server/database.js` 将 SQLite schema 升到 v11，为 `sync_agent_binding` 增加
  `is_listening`、`listener_reported_at`、`last_listener_at` 和监听查询索引。
- 支持 v6-v10 -> v11 幂等补列、迁移前备份和失败回滚。
- `apps/server/team/sync-agent-service.js` 支持 `listenerReportVersion=1` 和
  `listeningTaskSpaceIds`；服务端在事务内校验 binding/localRepoKey 后更新真实监听状态。
- `apps/server/team/task-space-service.js` 返回关联数、在线监听数、监听上报数、
  最后监听时间和五态 `listenerState`。
- 新增 `GET /api/task-spaces/:taskSpaceId/listeners`，只允许可管理用户查看脱敏客户端详情。
- 新增 Agent detach 接口；事务内撤销 binding、取消未完成命令、删除 cursor 并写一次审计。
- `apps/server/team/task-command-service.js` 增加 `TASK_SPACE_NO_ONLINE_LISTENER` 门禁；
  既有幂等命令仍在监听门禁之前重放。

### Rust 桌面 Agent

- `apps/desktop/src-tauri/src/agent/detach.rs` 实现本地解绑生命周期；先原子写入
  `detach_pending=true`，再请求服务端确认。
- `detach_pending` 后立即从 watcher、拉取、上传、任务命令和 cursor 链路排除；网络失败保留
  待确认状态，由后续心跳重试。
- 拉取、上传和 cursor 写入前重新读取本地配置，避免 watcher 刷新延迟期间继续访问服务端。
- 心跳只上报运行时实际激活且分支匹配的 taskSpace；切换分支不会撤销 binding。
- `agent_service.rs`、`main.rs` 和 Tauri capability/permission 增加
  `detach_local_association`，且不会恢复用户此前手动暂停的后台同步。
- 新增的 Rust 单元测试位于对应 `#[cfg(test)]` 模块；本机无 Rust 工具链，未实际编译执行。

### Web

- `apps/web/src/components/layout/ProjectRail.tsx` 按 taskSpace 展示
  `online/inactive/unassociated/unknown_legacy/disabled` 五态。
- “全部项目”范围展示每个项目的逐分支监听摘要。
- 当前客户端 approved 关联提供“不再同步此分支”二次确认入口；待确认时展示真实服务端原因。
- 新增 `BranchListenersDialog`，仅对可管理用户显示监听详情入口。
- 创建和改派复用 `taskCommandState()`，零在线监听时禁用并显示原因。

### 规范与任务

- 更新 backend 的实时同步、扫描持久化、架构、HTTP 和测试规范。
- 更新 frontend 的监听五态、解绑交互和创建/改派门禁规范。
- 任务文档已修订为当前 monorepo/Rust 实施路径；真实页面/桌面 E2E 保持未完成状态。

## 验证结果

- 最终全量 `npm test`：427 项，426 通过，0 失败，1 跳过。
- `npm run build:desktop`：通过，桌面 Web UI 资源构建成功。
- `npm run build`：通过，TypeScript 与 Vite 构建成功。
- `npm run check:boundaries`：通过。
- `npm --prefix apps/web run lint`：退出码 0；仅有仓库既有 warning。
- 本任务文件 `oxfmt --check`：通过。
- 仓库级 `npm run format:check`：仍命中 14 个与本任务无关的既有未格式化文件，
  按范围约束未批量修改。
- `git diff --check`：通过。
- 首轮全量测试曾因桌面 UI 未构建失败；完成构建后第二轮通过。另一次 Windows 临时目录
  `EPERM` 单独重跑通过，最终全量结果无失败。

## 未完成与限制

- 本机没有 `cargo`、`rustc`、`rustfmt`，Rust 编译、Clippy 和 Rust 单测未执行。
- 未连接真实三客户端 Team 环境，未执行真实页面、断网重试和 Windows 安装包 E2E。
- 未执行真实浏览器浅色/深色和窄屏布局验收。
- 以上未验证项不得在验收结论中标记为已通过。
