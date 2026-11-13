# PRD 证据索引

## 现行事实来源

### 产品与运维

- `README.md`：产品定位、standalone/team、任务数据来源、SQLite、当前功能范围和非目标。
- `docs/team-operations.md`：Team 部署边界、容量基线、项目接入、快照同步、冲突、
  分支切换、备份和故障处置。
- `apps/web/README.md`：Web 页面、组件分层、构建产物和前端职责。
- `apps/desktop/README.md`：Rust 单 EXE 客户端、环境门、本地项目接入、单 Agent、
  Tasks-only 同步、分支门禁、Tauri 权限和验证清单。

### 核心交互源码

- `apps/web/src/pages/board/BoardPage.tsx`：主导航、项目栏、流水线、团队视角、
  归档、插件、任务详情和操作弹层。
- `apps/web/src/features/board/ExecutionHeader.tsx`：个人执行视图、搜索与组合筛选。
- `apps/web/src/features/board/FlowSignals.tsx`：WIP、阻断、条件缺口与焦点建议。
- `apps/web/src/features/board/AttentionQueue.tsx`：注意力队列及排序。
- `apps/web/src/features/board/TaskCard.tsx`：任务卡、阶段条、关注信号和复制任务名。
- `apps/web/src/features/board/dialogs/TaskDetailDialog.tsx`：阶段证据、条件检查、
  计划字段、依赖、任务产物和派发。
- `apps/web/src/features/board/dialogs/CreateTaskDialog.tsx`：创建并派发任务。
- `apps/web/src/features/board/TaskOperationList.tsx`：创建/改派操作项状态。
- `apps/web/src/components/layout/ProjectRail.tsx`：项目/分支导航、本地关联状态、
  监听状态、待处理归属、补同步和解绑。
- `apps/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`：首次项目接入、
  初始化、推送检查、预检和差异处理。
- `apps/web/src/desktop/ControlApp.tsx`：首次差异、文件冲突、任务归属和同步错误。
- `apps/web/src/pages/admin/AdminPage.tsx`：项目协作、用户、团队、设备和审计管理。
- `apps/web/src/pages/login/LoginPage.tsx`：Team 登录和无公开注册的产品表达。
- `apps/web/src/features/plugins/PluginsView.tsx`：插件状态、启停和日志。

### 边界与当前状态源码

- `apps/server/team/permissions.js`：系统管理员、团队管理员、项目三角色和能力校验。
- `apps/server/team/task-space-service.js`：团队访问、项目成员、任务空间授权和 Agent
  绑定可见性。
- `apps/server/team/gitless-board-service.js`：当前 Board 查询、任务编辑、接受任务和
  团队范围偏好。
- `apps/server/team/task-space-index.js`：Team 同步状态、分支查询和任务空间索引。
- `apps/server/team/http.js`：Team 模式插件端点返回禁用状态。
- `packages/shared/trellis-agent-tools.js`：当前支持的编码 Agent 列表和探测规则。
- `apps/web/src/lib/execution-filter.js`：13 阶段和 9 个内置执行视图。
- `apps/web/src/features/board/task-view.ts`：任务卡泳道、推荐任务、进度和关注原因。

## 关键归档任务

### 个人执行控制

- `.trellis/tasks/archive/2026-10/10-30-personal-execution-enhancements/prd.md`
  - 从“展示任务”升级为个人执行控制面。
  - 首屏按“推荐任务 → 注意力队列 → 轻量 Kanban + 流动信号”组织。
  - Board 扩展字段与 Trellis 任务文件分离；不伪造历史。
- `.trellis/tasks/archive/2026-10/10-31-task-copy-shortcut/prd.md`
  - 任务列表和详情提供复制任务目录名入口。

### 团队协作与权限

- `.trellis/tasks/archive/2026-11/11-05-team-isolation/prd.md`
  - 团队边界、团队成员、项目角色、审计和设备权限。
- `.trellis/tasks/archive/2026-11/11-05-user-registration/prd.md`
  - 无公开注册，仅系统管理员建号、配置团队和重置密码。
- `.trellis/tasks/archive/2026-11/11-08-support-multi-team-board/prd.md`
  - 从单活动团队切换演进为全部授权团队聚合与团队筛选。
  - 保存视图和 WIP 按团队独立。

### 实时同步与任务空间

- `.trellis/tasks/archive/2026-11/11-10-no-server-git-live-task-sync/prd.md`
  - 服务端 Git 模式被客户端 Tasks-only 快照替代。
  - 创建/改派由唯一在线 Agent 在本地执行。
- `.trellis/tasks/archive/2026-11/11-11-all-projects-task-list/prd.md`
  - 全部项目可跨任务空间查询；同 taskKey 在不同分支是不同实例。
- `.trellis/tasks/archive/2026-11/11-12-branch-aware-task-sync-isolation/prd.md`
  - 同一本地仓库只允许一个有效分支绑定；同步前校验真实分支。
- `.trellis/tasks/archive/2026-11/11-12-local-task-deferred-sync/prd.md`
  - “仅同步无冲突项”后的本地任务必须显式展示并确认补传。

### 桌面客户端

- `.trellis/tasks/archive/2026-11/11-05-client-collaboration/prd.md`
  - 桌面客户端、SSE、团队隔离和仅管理员建号的最初产品决策。
- `.trellis/tasks/archive/2026-11/11-12-rust-desktop-agent-single-exe/prd.md`
  - Node SEA sidecar 被 Rust 单 EXE 进程内 Agent 替代。
  - 首次启动环境门安装 Node 与 Trellis CLI。
- `.trellis/tasks/archive/2026-11/11-12-project-rail-quick-agent-init/prd.md`
  - 已关联项目可快速追加本机编码 Agent。
- `.trellis/tasks/archive/2026-11/11-12-desktop-ui-shadcn-migration/prd.md`
  - 桌面环境页、登录页和实时确认窗与 Web 共用 shadcn/token。

### 视觉与交互基线

- `.trellis/tasks/archive/2026-11/11-05-design-fidelity/prd.md`
  - 1440 宽设计基线、shadcn Select、lucide 图标、ScrollArea 和看板列高度。
- `.trellis/tasks/archive/2026-11/11-08-remove-team-cadence-emphasize-edit-plan/prd.md`
  - 移除含义不准确的“团队节奏”，突出“编辑计划”。
- `.trellis/tasks/archive/2026-11/11-12-web-controls-unification/prd.md`
  - 32/28/24px 三档控件高度和 shadcn 优先。

### 插件

- `.trellis/tasks/archive/2026-11/11-04-plugin-architecture/prd.md`
  - 独立子进程、JSON-RPC、权限声明、崩溃隔离、A2A 入站和 ACP 出站。
  - 当前 Team 模式禁用插件。

## 历史替代关系

| 历史方案 | 当前事实 |
| --- | --- |
| 服务端 clone/fetch 项目 Git、稀疏检出 `.trellis` | 服务端不访问项目 Git；客户端上传 `.trellis/tasks/**` 快照 |
| Node SEA sidecar + `trellis-agent.exe` | Rust 单 EXE 进程内 Agent，无 sidecar |
| 登录时固定一个活动团队 | 默认全部授权团队，按团队筛选 |
| 绿色 ZIP 含 sidecar 和内置 Trellis runtime | 当前单 EXE；环境门按需准备 Node 与 Trellis CLI |
| Team 模式加载插件 | 当前 Team 模式插件接口明确返回禁用状态 |
