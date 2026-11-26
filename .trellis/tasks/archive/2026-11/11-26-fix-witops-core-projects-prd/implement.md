# 执行计划：修复 weint-core 插件项目列表与 PRD 模板

## 实施清单

1. 修改 `packages/server/plugins/core-capabilities.js`
   - `createCoreCapabilities` 增加 `repositoriesProvider` 可选参数，默认返回构造时的 `repositories`。
   - `projectList` / `repositoryList` 统一通过 provider 获取当前 repositories。
2. 修改 `packages/server/plugins/supervisor.js`
   - 创建 core capabilities 时传入 `repositoriesProvider: () => this.repositories`。
3. 修改 `packages/server/test/team-plugin-host.test.js`
   - 扩展已有 provider 用例，断言 capability 读取到 provider 提供的项目。
4. 修改 `plugins/witops-core/mapper.js`
   - `prd` 只保留标题与一句事实：`> 平台原文在 `task.md`；prd.md 尚未生成，本文件为占位。`
   - 删除三步 checklist 与 `trellis-brainstorm` 字样；不写任何流程指令或阶段顺序。
5. 修改 `plugins/witops-core/test/index.test.js`
   - 更新 `buildTaskDraft` 与 `/dispatch` 对 `prd.md` 的断言：不含 `trellis-brainstorm`、含 `task.md`、含占位标记。
6. 修改 `plugins/witops-core/README.md`
   - 更新任务产物契约描述，不再说等待 `trellis-brainstorm`，改为指向当前 Trellis 流程。
7. 修改 `plugins/witops-core/dispatch.js` 头部注释
   - 删除“等 trellis-brainstorm 生成后再覆盖”的过期描述。

## 验证命令

在仓库根目录执行：

```bash
node --test packages/server/test/team-plugin-host.test.js
node --test packages/server/test/plugin-core-capabilities.test.js
node --test plugins/witops-core/test/index.test.js
git diff --check
git -C plugins diff --check
```

## 注意点

- 不改动 `packages/server/plugins/task-service.js` / `plugins/witops-workbench/index.js` / `plugins/witops-core/dispatch.js` 的占位检测正则。
- 不重启 Team 插件服务、不执行 `task.py start` 之前的用户确认关卡。
- 任务目录 `.trellis/tasks/11-26-fix-witops-core-projects-prd/` 纳入任务提交范围。
- 环境没有 `python`，所有 Trellis 脚本使用 `python3`。
