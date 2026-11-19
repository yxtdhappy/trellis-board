# 当前运行测试与测试大纲链路证据

日期：2026-11-19
范围：`plugins/witops-workbench`、`plugins/scenario-copilot`、`packages/server/plugin-ui/v1`

## 1. 弹窗横向滚动条

- 宿主对话框宽度：`packages/server/plugin-ui/v1/ui.css:243-251`
  - `.tb-dialog { width: min(440px, calc(100vw - 32px)); padding: 0; }`
- 插件表单最小宽度：`plugins/witops-workbench/panel/app.css:259-265`
  - `dialog form { min-width: min(460px, 84vw); padding: 18px; }`
- 浏览器实测（1006px 视口）：
  - `#test-dialog`：`clientWidth=438`，`scrollWidth=460`，`overflow-x=auto`
  - `#test-form`：`width=460`，`minWidth=460`
  - 横向滚动条来自表单最小宽度 460 大于对话框内容宽度 438。

## 2. 工作台弹窗当前如何选大纲

- `plugins/witops-workbench/panel/app.js:298-311` `fillOutlineOptions`：
  - 只渲染 `/test-defaults` 返回的全局大纲列表，没有需求/任务关联信息。
- `plugins/witops-workbench/panel/app.js:313-322` `applySubject`：
  - 有 `target.outline` 用它；
  - 否则直接选择 `state.defaults.defaultOutline`。
- `plugins/witops-workbench/panel/app.js:324-344` `openTest`：
  - 测试对象来自 `item.testTargets`，默认选需求级或点击的任务级。
- `plugins/witops-workbench/panel/index.html:104-127`：
  - 弹窗只有“测试对象 / 测试大纲 / 目标地址 / 仅生成并校验”，没有生成大纲入口。

## 3. 工作台服务端如何组装 testTargets

- `plugins/witops-workbench/index.js:400-423` `testTargetsFor(item, bindings)`：
  - 需求级：`outline: binding.outline`，`targetUrl: binding.targetUrl`。
  - Trellis 级：`outline: binding.outline`，`targetUrl: task.testUrl || binding.targetUrl`。
  - 不读取大纲元数据，不读取 scenario-copilot 实际会解析到的文件名匹配结果。
- `plugins/witops-workbench/index.js:427-473` `attachTestInfo`：
  - 只调用 `runs.list` 和 `bindings.get`；没有调用大纲解析。
- `plugins/witops-workbench/index.js:475-500` `startTest`：
  - 将 `body.outline`、`body.targetUrl` 透传给 `runs.start`。
- `plugins/witops-workbench/index.js:502-537` `startRegression`：
  - 需求级 target 缺失时会退到任意带 `targetUrl` 的 target；outline 同样回退。
  - 缺失地址只返回 `2010`，没有区分缺大纲/缺地址。

## 4. scenario-copilot 当前解析顺序

- `plugins/scenario-copilot/index.js:364-372` `outlineForTask`：
  - 用任务 `relativeDir` 的 basename 与大纲文件 stem 互相 `includes`，属于文件名猜测。
- `plugins/scenario-copilot/index.js:408-430` `startRun`：
  ```js
  const binding = await bindingOf(subject)
  const outlineName =
    text(input.outline) ||
    text(binding.outline) ||
    outlineForTask(task) ||
    text(config.defaultOutline) ||
    listOutlines(config)[0]?.name ||
    ''
  ```
  - 最后两级会静默使用默认大纲或第一个大纲。
  - 目标地址顺序：`input.targetUrl || binding.targetUrl || taskTarget(task) || config.targetUrl`。
- `plugins/scenario-copilot/index.js:103-115` `listOutlines`：
  - 只返回 `{ name, title, size }`，没有关联元数据。
- `plugins/scenario-copilot/index.js:617-629` `defaultsResult`：
  - 返回全局 `defaultOutline` 和扁平 `outlines`。
- `plugins/scenario-copilot/index.js:807-850` `generateOutline`：
  - 已有 `requirementText`、`title`、`notes`、`requirementId`、`targetRoute`、`caseCount` 入参。
- `plugins/scenario-copilot/index.js:852-890` `saveOutline`：
  - 只校验 H1、写 `.md`，没有关联元数据。
- `plugins/scenario-copilot/index.js:930-937`：
  - 已有 `/outlines`、`/outlines/generate`、`/outlines/save` HTTP 路由。
- `plugins/scenario-copilot/plugin.json`：
  - capability 已有 `outlines.list/generate/save`，没有 `outlines.resolve` / `outlines.associate`。

## 5. 大纲解析器对 frontmatter 的行为

- `tmp/project/mom-cli/packages/scenario-copilot/src/parser/outline-parser.ts:40-79`：
  - `---` 会被当作 paragraph 节点；
  - 未识别的 `key: value` 也会进入正文节点。
- 结论：元数据不写进 `.md` frontmatter，使用同目录 sidecar manifest。

## 6. 现有大纲与目标环境

- 当前 `outlinesDir`：`/opt/app/work/github/trellis-board/tmp/data/scenario-output`
- 现有大纲是模块/页面级，例如：
  - `dm-business-category.md` 覆盖 R35627
  - `dm-model-publish.md` 覆盖 R35499 / R35505
- 结论：关联模型必须支持一个大纲关联多个需求，一个需求关联多个大纲。

## 7. 回归与深链

- `plugins/scenario-copilot/index.js:661-670` 回归逐 subject 调用 `startRun`，`outline` 为空时仍会走上面的静默回退链。
- 工作台面板是 sandbox iframe，不能 `window.confirm/alert/prompt`；见 `.trellis/spec/backend/plugin-runtime.md:7.1`。
- 面板 E2E 只能靠无障碍快照/截图，不能 `page.evaluate` 进 iframe；见同文件 7.1。
