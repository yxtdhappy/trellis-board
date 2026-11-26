---
mode: independent
agent: trellis-check
session: ses_pi_check_20261126
commit: f04013f1de1a2aa41c076b97cf81524fecf8b24f
base: cb46da98e97b64f169284b7327cbaf9ca73319bb
scope: packages/server/plugins/core-capabilities.js,packages/server/plugins/supervisor.js,packages/server/plugins/task-service.js,packages/server/test/team-plugin-host.test.js,plugins/witops-core/README.md,plugins/witops-core/dispatch.js,plugins/witops-core/mapper.js,plugins/witops-core/test/index.test.js
diff: sha256:a792ce9489e11da9b5aa30739da0806876f97492a46c57051d604abdb6ea1ee7
---
# 独立检查报告：修复 weint-core 插件项目列表与 PRD 模板

## 检查范围

审查对象为提交 `f04013f1de1a2aa41c076b97cf81524fecf8b24f`（`fix(witops-core): read latest project snapshot and drop hardcoded PRD steps`）中的以下文件：

- `packages/server/plugins/core-capabilities.js`
- `packages/server/plugins/supervisor.js`
- `packages/server/plugins/task-service.js`
- `packages/server/test/team-plugin-host.test.js`
- `plugins/witops-core/mapper.js`
- `plugins/witops-core/dispatch.js`
- `plugins/witops-core/README.md`
- `plugins/witops-core/test/index.test.js`

对照制品：`.trellis/tasks/11-26-fix-witops-core-projects-prd/` 下 `prd.md`、`design.md`、`implement.md`、`implementation-report.md`，以及 `.trellis/spec/guides/index.md`、`.trellis/spec/guides/code-reuse-thinking-guide.md`。

本次检查只读：未修改任何产品代码/测试，未重启服务，未重扫插件，未做浏览器实测，未执行任何 git 写操作，未改 `task.json`。

## 实际运行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --test packages/server/test/team-plugin-host.test.js` | pass 7 / fail 0 / skip 0 |
| `node --test packages/server/test/plugin-core-capabilities.test.js` | pass 6 / fail 0 / skip 0 |
| `node --test plugins/witops-core/test/index.test.js` | pass 38 / fail 0 / skip 0 |
| `npx oxfmt --check packages/server/plugins/core-capabilities.js packages/server/plugins/supervisor.js packages/server/plugins/task-service.js packages/server/test/team-plugin-host.test.js` | 通过（All matched files use the correct format） |
| `npx oxfmt --check plugins/witops-core/mapper.js plugins/witops-core/dispatch.js plugins/witops-core/test/index.test.js`（补充） | 通过 |
| `git diff --check` / `git -C plugins diff --check`（补充） | 均通过，无空白错误 |
| `git status --short` / `git -C plugins status --short` | 见验收标准 4 |
| 占位正则实测：`node -e` 用新占位文本跑 `/prd\.md 尚未生成\|平台原文在 \`task\.md\`/` | 命中为 `true`；`- [ ]` 与 `trellis-brainstorm` 均为 `false` |

补充证据（静态核对，非运行）：

- `packages/server/team/http.js:509-521` 生产 Team 宿主只传 `repositoriesProvider`，不传 `repositories`、不传 `repositoryService`，因此修复前 core capability 读到的是构造默认空数组 —— 与 `prd.md` Background 描述一致。
- `packages/server/team/plugins/host.js:169-176`（`load()`）与 `:196-200`（`rescan()`）只整体替换 `supervisor.repositories`；`packages/server/plugins/supervisor.js:77,112-114` 传 `repositoriesProvider: () => this.repositories`，刷新后立即可见。
- `plugins/witops-core/index.js:1372-1400` 的 `GET /projects` 先 `trellis.projects.list`，再逐项目调 `trellis.projects.branches`；本次未改动该文件，列表完整性完全由 capability 修复决定。
- 三处占位正则未被修改：`packages/server/plugins/task-service.js:39`、`plugins/witops-core/dispatch.js:603`、`plugins/witops-workbench/index.js:998`，文本均为 `/prd\.md 尚未生成|平台原文在 \`task\.md\`/`。
- `plugins/witops-core/dispatch.js:688,732` 写入的 `prd` 均来自 `buildTaskDraft().prd`，没有第二条生成路径绕过新模板。
- 产品代码与文档中已无遗留的 `trellis-brainstorm` 字样（命中仅剩 `.agents/skills/*` 流程文档、历史归档任务目录，以及 `plugins/witops-core/test/index.test.js:192,278` 的 negative 断言）。

## 逐条验收标准结论

1. **`node --test packages/server/test/team-plugin-host.test.js` 通过，且新增测试证明 provider 项目可从 capability 读到 —— 满足。**
   7 pass / 0 fail。新增用例「核心 capability 读取 repositoriesProvider 的最新项目快照」（`packages/server/test/team-plugin-host.test.js:90-146`）在 `host.load()` 后断言 `trellis.projects.list` = `['project-a']`，再替换 provider 数据并二次 `host.load()`，断言 `trellis.projects.list` / `trellis.repositories.list` = `['project-a','project-b']`、`trellis.projects.current { repositoryId: 'project-b' }` 命中。该用例在缺少 supervisor 侧 provider 时必然失败：`withHost` 未向 `createTeamPluginHost` 传 `repositories`，首个断言会拿到 `[]`，因此是有效回归测试。

2. **`node --test plugins/witops-core/test/index.test.js` 通过，且断言 `prd.md` 只含标题与一句事实占位 —— 满足（含 1 条 P2 加固建议）。**
   38 pass / 0 fail。`plugins/witops-core/test/index.test.js:186-195` 断言 `prd` 命中 `平台原文在 \`task.md\`` 与 `prd.md 尚未生成`，且 `doesNotMatch trellis-brainstorm`、`doesNotMatch /- \[ \]/`；`plugins/witops-core/test/index.test.js:274-280` 对 `POST /dispatch` 落盘的 `prd.md` 做同样断言并额外要求以 `# ` 开头。实测新模板文本（`plugins/witops-core/mapper.js:293-301`）为 `# <code> <name>` + 空行 + `> 平台原文在 \`task.md\`；prd.md 尚未生成，本文件为占位。`，只含事实，无流程指令、无 skill 名、无 `- [ ]` 清单。

3. **`node --test packages/server/test/plugin-core-capabilities.test.js` 通过，证明原有 `repositories` 构造参数未回归 —— 满足。**
   6 pass / 0 fail。该测试文件未改动，全部用例走 `createHarness({ repositories: [...] })` 的构造参数路径（不传 provider），覆盖 `trellis.repositories` list/add（`:26-58`）、`trellis.projects` 读取、`developers` 解析；证明 `repositoriesOf()` 在无 provider 时回退到构造数组，`core-capabilities.js:352-370` 的内存态 add/remove 仍作用于同一数组。

4. **`git -C plugins status --short` 与根仓库 `git status --short` 无意外文件改动 —— 满足，附 1 条 P2 说明。**
   - 根仓库：` M .trellis/tasks/11-26-fix-witops-core-projects-prd/.state-events.jsonl`、` M .../task.json`（Trellis 状态机写入，非本次检查改动）、`?? .../implementation-report.md`（实现者产物）、以及本报告 `?? .../check-report.md`。无产品代码/测试意外改动。
   - 嵌套仓库 `plugins/`：4 个 `M`（`README.md`、`dispatch.js`、`mapper.js`、`test/index.test.js`）。逐文件比对 `git hash-object` 与 `git rev-parse f04013f1:...`，四处 blob 完全相同（`48ef3d81` / `2854d6ca` / `ee294725` / `1fb58b72`），即无内容漂移，只是嵌套仓库尚未提交同一改动；不属于「意外改动文件」。

## Findings

**No P0 / P1 issues found.** 以下为 P2（不阻塞合并）：

- **P2-1 团队模式内存态 repository 增删新语义无测试覆盖**（`packages/server/plugins/core-capabilities.js:352-370`）。改动后 `trellis.repositories.add/remove` 的无 `repositoryService` 分支改为操作 `repositoriesOf()` 返回的数组：team 模式下会改动 `supervisor.repositories` 快照（此前是改动构造时的空数组并因此 `NOT_FOUND`），行为可观察到变化且无测试。最小建议：在 `packages/server/test/team-plugin-host.test.js` 的 provider 用例后追加一次 `trellis.repositories.remove` 断言，或明确该分支仅供 standalone/harness。
- **P2-2 provider 约定「返回活数组」无注释/无守卫**（`packages/server/plugins/core-capabilities.js:249-251`）。若将来有人把 `repositoriesProvider` 传成 `() => [...rows]`，`remove` 的 `current.splice(...)` 会改到临时副本，响应报成功但数据未变。当前唯一调用方（`supervisor.js:114`）返回 `this.repositories` 活引用，因此不是现存缺陷。最小建议：在 `repositoriesOf` 上方一行注释写明「provider 必须返回调用方持有的可变数组（remove 会就地修改）」。
- **P2-3 「prd.md 只含标题与一句事实」缺少强断言**（`plugins/witops-core/test/index.test.js:186-195,274-280`）。现有断言是「含 A、含 B、不含 skill 名、不含 `- [ ]`」，不能拦住后续再加一段散文（如 `## 背景` 或「下一步…」）。最小建议：把断言收紧为 `assert.equal(draft.prd, '# T10001 ...\n\n> 平台原文在 \`task.md\`；prd.md 尚未生成，本文件为占位。\n')`，或至少补 `assert.doesNotMatch(draft.prd, /##/)`。
- **P2-4 嵌套 `plugins/` 仓库存在同内容未提交改动**。见验收标准 4：内容与主仓库提交逐字节一致，非漂移；若仓库约定 `plugins/` 也需独立提交，请实现者补提交（本次检查按约束未执行任何 git 写操作）。
- **P2-5 `work_type=fullstack` 但无 `api-e2e-report.md`**。`prd.md` R3.3 明确「仅做自动化测试验证；不重启 Team 服务、不重扫插件、不做浏览器实测」，属用户显式选择；按 `trellis-check` 该条为软性流程要求，记录为不适用而非失败。

## Merge verdict

**OK with notes.**

四条验收标准全部满足，四条必跑命令全部通过（7 + 6 + 38 = 51 pass、0 fail），格式检查与 `git diff --check` 通过，改动严格落在 R1/R2/R3 范围内（`core-capabilities.js` + `supervisor.js` 读最新快照；`mapper.js` 去流程化模板；`task-service.js` 仅改注释；测试与 README 同步）；三处占位正则未改且对新占位文本仍命中。P2-1～P2-5 均为可选加固与记录项，不构成阻塞。