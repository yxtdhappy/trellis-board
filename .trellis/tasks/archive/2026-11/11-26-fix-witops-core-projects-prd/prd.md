# 修复 weint-core 插件项目列表与 PRD 模板

## Goal

修复下发任务时项目下拉框不完整，以及生成任务目录中的 `prd.md` 写死某个 Trellis 流程步骤、导致 AI agent 无法按当前流程从 `task.md` 开始任务的问题。用户可直接选用完整项目列表，并让 `prd.md` 只指向任务真源 `task.md`、不绑定会演进的具体 skill/命令。

## Background

- 用户把插件称为 weint-core；仓库中对应实现是 `plugins/witops-core`，下发入口为 `POST /dispatch`，面板由 `plugins/witops-core/panel/app.js` 渲染。
- 项目下拉的数据链：面板 `GET /projects` → `plugins/witops-core/index.js:1372` 调用宿主 `trellis.projects.list` → `packages/server/plugins/core-capabilities.js:285` 的 `projectList(repositories, repositoryService)`。
- Team 插件宿主在 `packages/server/team/plugins/host.js:31` 接收 `repositoriesProvider`，并在 `:168`/`:198` 刷新 `supervisor.repositories`；但 `PluginSupervisor` 在 `packages/server/plugins/supervisor.js:112-117` 创建 core capabilities 时把构造参数 `repositories` 作为闭包传入，后续刷新 `this.repositories` 不会同步到闭包。构造时 team host 未传 `repositories`，默认空数组，因此 `trellis.projects.list` 与 `trellis.repositories.list` 返回空/不全。现有测试 `packages/server/test/team-plugin-host.test.js:55,84` 只断言 `supervisor.repositories`，没有覆盖 capability 读路径。
- 任务生成链：`plugins/witops-core/dispatch.js:532` 调 `buildTaskDraft`（`plugins/witops-core/mapper.js:151`），其中 `mapper.js:295-302` 生成的 `prd.md` 写了三步 checklist，含 `trellis-brainstorm`。
- 占位 PRD 检测依赖稳定文本：`packages/server/plugins/task-service.js:39`、`plugins/witops-core/dispatch.js:603`、`plugins/witops-workbench/index.js:998` 均用 `/prd\.md 尚未生成|平台原文在 \`task\.md\`/` 判定“不是正式 PRD”，避免把占位内容当作需求上下文。

## Requirements

### R1 项目列表完整

- R1.1 Team 插件场景下，`trellis.projects.list` 和 `trellis.repositories.list` 必须读取到 `repositoriesProvider()` 提供的最新项目集合，不再因为 `repositories` 闭包过期返回空/部分项目。
- R1.2 `witops-core` 面板的 `GET /projects` 必须返回 provider 中的全部项目，供下发任务下拉框展示；分支信息仍按每个项目调用 `trellis.projects.branches`。
- R1.3 现有构造参数 `repositories` 的行为保持不变；standalone 与测试 harness 不受回归。

### R2 PRD 模板不绑定具体流程

- R2.1 `prd.md` 不得包含任何流程指令、步骤清单或阶段顺序；它只能陈述事实（`task.md` 是平台原文/任务来源、本文件是否为占位）。下一步走什么流程由 agent 读取仓库当前 Trellis 流程决定。
- R2.2 `prd.md` 不得写死 `trellis-brainstorm` 或任何固定 skill/命令名，也不得以 `- [ ]` 待办清单规定流程。
- R2.3 保留稳定的占位标记（至少 `prd.md 尚未生成` 或 `平台原文在 \`task.md\`` 之一），使下游插件/看板仍能识别占位 PRD 并避免把它当正式需求上下文。
- R2.4 已存在任务、legacy 回退和占位判定的既有行为不回归。

### R3 验证与文档

- R3.1 为两个缺陷补充自动化测试，覆盖 host capability 读路径和 `buildTaskDraft`/dispatch 生成的 `prd.md`。
- R3.2 更新 `plugins/witops-core/README.md` 中任务产物契约描述，使文档与新模板一致。
- R3.3 按用户选择，仅做自动化测试验证；不重启 Team 服务、不重扫插件、不做浏览器实测。

## Acceptance Criteria

- [ ] `node --test packages/server/test/team-plugin-host.test.js` 通过，且新增测试证明 `repositoriesProvider()` 的项目可从 `trellis.projects.list` / `trellis.repositories.list` capability 读到。
- [ ] `node --test plugins/witops-core/test/index.test.js` 通过，且断言生成的 `prd.md` 只含标题与一句事实占位：指向 `task.md`、不含 `trellis-brainstorm`、不含 `- [ ]` 清单与流程指令，并保留占位标记。
- [ ] `node --test packages/server/test/plugin-core-capabilities.test.js` 通过，证明原有 `repositories` 构造参数与 capability 行为未回归。
- [ ] `git -C plugins status --short` 与根仓库 `git status --short` 中无意外文件改动；只改本任务范围内的代码、测试、文档与任务目录。

## Out of Scope

- 不修改 Trellis Workflow 本身、`.trellis/workflow.md` 或 `trellis-brainstorm` skill 内容。
- 不重设计插件权限/鉴权、不新增 capability 协议方法。
- 不做浏览器实测或生产/本机服务端重启。
- 不迁移历史任务目录里的旧 `prd.md` 内容。

## Risks / Deferred

- 占位文本是跨插件的隐式契约；修改时只删除流程性描述，保留原有检测文本，避免 `task-service` DoR 统计与 workbench 需求上下文读取失效。
- Team host 的 `repositoriesProvider()` 当前只在 `load()`/`rescan()` 刷新快照；本任务沿用该时机，不改成每次 capability 调用都查库，除非测试证明必要。
