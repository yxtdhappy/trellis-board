# 技术设计

## 1. 边界与职责

### 前端

- `ProjectRail` 负责判断入口可见性、携带当前项目/分支摘要打开弹窗。
- `AgentQuickInitDialog` 负责按 `taskSpaceId` 读取仓库预检、维护选择状态、校验 developer ID 和提交初始化。
- `AgentToolSelector` 作为接入向导与快速弹窗共用的具体业务组件，统一完整 Agent 目录、搜索、已初始化置灰和多选展示。
- `web/src/lib/project-inspection.js` 统一规范化 sidecar 返回的项目预检结构，避免两个弹窗对同一响应作不同解释。

### Tauri / Rust

- 新增两个仅面向当前登录 Board origin 的命令：
  - `inspect_associated_project_agents(taskSpaceId)`
  - `initialize_associated_project_agents(taskSpaceId, developerId, agentTools)`
- 两个命令都先用 `validate_live_id()` 校验任务空间 ID，再调用 `sidecar::list_associations()` 找到本地关联。
- 只有 `status == "approved"` 的关联可用于解析 `repoPath`；未找到时返回“请先关联本地 Git 项目”一类错误。
- 预检和初始化继续调用既有 `sidecar::inspect_project()` / `sidecar::initialize_project()`，不复制 Git、工具探测或 Trellis CLI 逻辑。

### Sidecar

- 不新增 sidecar CLI 命令。现有 `inspect-project` 与 `initialize-project` 已提供所需行为。
- `initializeProject()` 继续只在实际缺少所选工具时调用初始化器，因此重复提交是安全的。

## 2. 数据流

```text
ProjectRail approved association
  -> AgentQuickInitDialog(taskSpaceId)
  -> inspect_associated_project_agents
  -> list_associations + approved 校验
  -> sidecar inspect-project(repoPath)
  -> normalizeProjectInspection
  -> existingAgentTools 置灰
用户选择缺失 Agent
  -> initialize_associated_project_agents
  -> list_associations + approved 校验 + 输入校验
  -> sidecar initialize-project(repoPath, developerId, agentTools)
  -> 返回最新 inspection
  -> 关闭弹窗并提示成功
```

## 3. UI 契约

- 入口使用 lucide `Bot` 图标，仅渲染在 `activeAssociation.status === 'approved'` 的分支图标右侧。
- 弹窗标题为“初始化编码 Agent”，说明“只影响当前电脑，不影响团队任务空间和其他设备”。
- developer ID 默认取 `runtime.user.username`，用户编辑后不再被默认值覆盖。
- Agent 列表使用共享组件；已初始化项 `disabled`、降低不透明度，并显示“已初始化”。
- 全部 Agent 已初始化时显示明确完成提示；部分可初始化时按钮文案包含选中数量。
- 加载中禁用提交；错误文本保留在弹窗正文，不使用 toast 代替全部错误信息。

## 4. 安全与兼容

- 远程页面不传路径；`taskSpaceId` 只作为本地关联查询键。
- Rust 仍执行 Board 同源校验，capability 不开放任意文件系统、dialog 或 shell 权限。
- developer ID 与 Agent ID 的校验规则抽成 Rust 内部共享校验函数，现有 pending 初始化命令同步复用，避免两套入口规则漂移。
- 不修改现有命令签名、本地 binding schema、sidecar 协议或服务端接口。
- 新入口依赖新版桌面客户端。旧客户端缺少新命令时前端显示初始化失败原因，不静默假装成功；发布时必须重新构建并安装桌面客户端。

## 5. 关键取舍

- 选择新增专用 Tauri 命令，而不是允许前端传 `repoPath`：多两个命令，但保留“远程页面不能指定本地路径”的边界。
- 选择抽取具体 Agent 列表组件，而不是复制接入向导的列表：只服务两个真实消费者，目标是消除同一规则的 UI 漂移。
- 不引入前端状态库、路由或新的依赖。

## 6. 回滚

- 前端可移除入口和弹窗，不影响已有接入流程。
- Rust 新命令与权限独立新增；回滚时从 invoke handler、capability 和 permission 同时移除即可。
- 不涉及数据迁移，回滚不会修改已有本地关联或任务数据。

## 7. 验证策略

- 纯逻辑：覆盖项目预检响应规范化和 Rust 已批准关联筛选。
- 配置契约：更新桌面 capability/permission 测试，确保仅远程 Board 命令集合包含新命令。
- 回归：现有 onboarding/project-rail 测试必须通过。
- 最终端到端：构建后用真实 Tauri 客户端打开已关联项目，验证入口可见性、已初始化置灰、追加初始化、重开后的状态和错误路径。
