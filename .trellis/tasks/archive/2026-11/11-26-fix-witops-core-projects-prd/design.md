# 设计：修复 weint-core 插件项目列表与 PRD 模板

## 架构与边界

### 1. 项目列表 capability 动态读取

当前问题源于两层快照不一致：

- `PluginSupervisor` 构造时把 `repositories` 作为闭包传给 `createCoreCapabilities`；
- `createTeamPluginHost` 的 `repositoriesProvider()` 只在 `load()`/`rescan()` 更新 `supervisor.repositories`。

方案是把 core capabilities 的项目访问改为始终通过 supervisor 的**可替换 getter**，而不是闭包里的固定数组：

1. `createCoreCapabilities` 新增可选参数 `repositoriesProvider`，默认回退到传入的 `repositories` 数组；
2. `projectList(repositories, repositoryService)` 与 `repositoryList(...)` 改为接受 `repositoriesProvider()` 的返回值；
3. `PluginSupervisor` 构造时传入 `repositoriesProvider: () => this.repositories`，使 `this.repositories` 的任何刷新立即可见；
4. team host 的 `load()`/`rescan()` 继续只刷新 `supervisor.repositories`，无需重复配置 core capabilities。

这样保留构造函数 `repositories` 参数的兼容性（standalone、测试 harness、既有测试都走默认 provider），也保留 `repositoryService.addMany/remove` 之后的列表行为。

### 2. PRD 模板去流程绑定

原则：`prd.md` 只陈述事实，不承载流程。插件拥有的制品只有 `task.md`；`prd.md` 的内容归属 Trellis。

不可接受的做法（含早期提案）：任何形式的「下一步」指令，包括抽象化的「按当前流程生成 PRD 后再实施」——它仍固化了“PRD 先于实现”的阶段顺序，而 Trellis 允许 lightweight / PRD-only / 制品集合变化。

**已决策：方案 A（一句式事实占位）**

`buildTaskDraft` 的 `prd` 只生成标题与一句事实：

```markdown
# <code> <name>

> 平台原文在 `task.md`；prd.md 尚未生成，本文件为占位。
```

该文本同时命中 `prd.md 尚未生成` 与 `平台原文在 \`task.md\`` 两个占位标记，三处消费者无需改动。不写清单、不写 skill/命令名、不写任何阶段顺序。

被否方案（记录理由）：

- B：不传 `prd` 保留 `task.py create` 骨架——插件零散文更彻底，但需改三处占位检测与 DoR 语义，本任务范围外。
- 任何含「下一步/先…再…」措辞的模板：仍固化阶段顺序，会再次过期。

长期方向（不在本任务）：散文正则改为结构化标记（如 `task.json.meta.witops.prdPlaceholder`）。

占位检测正则保持可用，下游消费者位置：

- `packages/server/plugins/task-service.js`
- `plugins/witops-core/dispatch.js`
- `plugins/witops-workbench/index.js`

## 数据流

```text
Team DB repositories
  → repositoriesProvider() (team/http.js)
  → host load()/rescan(): supervisor.repositories = [...]
  → coreCapabilities repositoriesProvider: () => supervisor.repositories
  → trellis.projects.list / trellis.repositories.list
  → witops-core GET /projects
  → panel #dialog-project
```

```text
WitOps work item
  → mapper.buildTaskDraft()
  → prd.md 占位文本（task.md 是真源 + 当前流程）
  → task.py 创建任务目录
  → AI agent 从 task.md 开始
```

## 兼容性

- `createCoreCapabilities({ repositories, ... })` 的旧调用方式继续有效；未提供 provider 时使用原数组。
- `PluginSupervisor` 的 `repositories` 字段仍可被外部刷新，现在 capability 读取与握手参数都看到同一份数据。
- `repositoryService` 的写操作仍通过既有 `repositoryList(repositories, repositoryService)` 逻辑返回更新后的列表。
- 历史任务中的旧 `prd.md` 不迁移；占位识别仍能识别旧模板。

## 测试策略

- `packages/server/test/team-plugin-host.test.js`：在已有 `repositoriesProvider` 用例上断言 `coreCapabilities` 读到的项目（`trellis.projects.list` / `trellis.repositories.list`）。
- `packages/server/test/plugin-core-capabilities.test.js`：保留原有测试，确认构造参数路径不变。
- `plugins/witops-core/test/index.test.js`：更新/新增断言，`buildTaskDraft` 与 dispatch 写出的 `prd.md` 不含 `trellis-brainstorm`、指向 `task.md`、保留占位标记。
- 用户已选择不重启服务、不做浏览器实测。

## 风险与回滚

- 风险：provider 动态读取改变 capability 可见的列表快照时机；通过只读取 `supervisor.repositories`、不调用 provider 本身，避免把 DB 查询引入热路径，且与 `load()`/`rescan()` 现状一致。
- 回滚点：恢复 `createCoreCapabilities` 的闭包数组读取与 `mapper.js` 的模板即可；测试隔离在变更文件内。
