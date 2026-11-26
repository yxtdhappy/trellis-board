# 实现报告：修复 weint-core 插件项目列表与 PRD 模板

- 任务：`.trellis/tasks/11-26-fix-witops-core-projects-prd`
- 提交：`f04013f1 fix(witops-core): read latest project snapshot and drop hardcoded PRD steps`
- 执行者：kanyifei（pi 主会话）

## 改动内容

### R1 项目列表读最新快照

- `packages/server/plugins/core-capabilities.js`
  - `createCoreCapabilities` 新增 `repositoriesProvider` 参数；新增 `repositoriesOf()`，未提供 provider 时回退构造参数 `repositories`。
  - `projectList` / `repositoryList` 改为接收取值函数，`trellis.projects.{list,get,current,branches,developers}` 与 `trellis.repositories.{list,add,remove}` 全部走 `repositoriesOf()`。
  - 内存态 add/remove 改为操作 `repositoriesOf()` 返回的数组，避免 team 模式下写入构造时的空数组。
- `packages/server/plugins/supervisor.js`
  - 创建 core capabilities 时传 `repositoriesProvider: () => this.repositories`，team 宿主 `load()`/`rescan()` 整体替换后 capability 立即可见。

### R2 PRD 占位去流程化

- `plugins/witops-core/mapper.js`
  - `prd.md` 只保留标题与一句事实：`> 平台原文在 \`task.md\`；prd.md 尚未生成，本文件为占位。`
  - 删除三步 checklist、"## 下一步"、`trellis-brainstorm` 字样。
  - 同步任务来源注释，不再推断流程。
- `plugins/witops-core/dispatch.js` 头部注释、`plugins/witops-core/README.md` 产物契约、`packages/server/plugins/task-service.js` 占位注释同步更新。

### 测试

- `packages/server/test/team-plugin-host.test.js`
  - `withHost` 支持注入 `repositoriesProvider`。
  - 新增用例：provider 快照变化后 `trellis.projects.list` / `trellis.repositories.list` / `trellis.projects.current` 读到新集合。已验证去掉 supervisor 的 provider 后该用例失败。
- `plugins/witops-core/test/index.test.js`
  - `buildTaskDraft` 与 `POST /dispatch` 断言：含 `task.md` 指针与 `prd.md 尚未生成`，不含 `trellis-brainstorm`、不含 `- [ ]`。

## 验证命令与结果

```text
node --test packages/server/test/team-plugin-host.test.js        # 7 pass / 0 fail
node --test packages/server/test/plugin-core-capabilities.test.js # 6 pass / 0 fail
node --test plugins/witops-core/test/index.test.js                # 38 pass / 0 fail
node --test plugins/witops-core/test/team-routes.test.js          # 11 pass / 0 fail
node --test plugins/witops-core/test/team-view.test.js            # 10 pass / 0 fail
node --test plugins/witops-core/test/accounts-integration.test.js # 4 pass / 0 fail
node --test packages/server/test/team-plugin-http.test.js         # 16 pass / 0 fail
TRELLIS_PYTHON=python3 PYTHON=python3 yarn test --scope=core      # 783 pass / 0 fail / 2 skip（785）
TRELLIS_PYTHON=python3 PYTHON=python3 yarn test --scope=plugins   # 140 pass / 0 fail / 1 skip（141）
npx oxfmt --check <改动文件>                                       # all matched files use the correct format
git diff --check / git -C plugins diff --check                   # 通过
```

环境说明：本机无 `python`，只有 `python3`；`yarn test` 需同时设置 `PYTHON` 与 `TRELLIS_PYTHON`，否则 `scripts/test/task-check-binding.test.js` 与 `trellis-kit.test.js` 的 11 个用例会因找不到解释器失败（与本次改动无关）。

## 偏差与未验证

- 未重启 Team 服务、未重扫插件、未做浏览器实测（用户明确选择仅自动化测试）。
- `.worktree/` 下各旧 worktree 的 `plugins/witops-core` 副本仍是旧模板，需用户后续按 `sync-all.sh` 流程同步。
- `plugins/.git` 为嵌套仓库，本次只提交主仓库；嵌套仓库工作区保留同样的文件改动。
