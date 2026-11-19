# WitOps 运行测试弹窗与测试大纲关联流程改造

## Goal

修复 WitOps 工作台「运行测试」弹窗的横向滚动条；把测试大纲从“全局下拉框 + 静默兜底”升级为“可关联需求/任务、可解析、可生成、可供回归复用”的显式资产；让从 worktree 下发或接手的 Trellis 任务可以在同一个弹窗内完成“生成大纲 → 关联需求 → 运行测试”的闭环。

## Background

- 当前「运行测试」弹窗的大纲列表是 `outlinesDir` 下的全局文件列表，不区分需求、任务和模块。
- 工作台面板用 `defaultOutline` 兜底，scenario-copilot 服务端却先尝试文件名猜测、再退到默认大纲或第一个大纲；UI 显示的大纲和实际执行的大纲可能不一致。
- 任务没有已生成大纲时，弹窗没有生成入口，用户必须跳到「自动化测试」面板手动生成再回来，worktree 任务验收流程是断的。
- 当前大纲只有 `.md`/`.txt` 文件，没有“这个大纲属于哪个需求/任务”的元数据，回归无法可靠复用。
- 宿主 `.tb-dialog` 宽 440px，插件 `dialog form` 最小宽 460px，已在 1006px 视口复现横向滚动条（`scrollWidth=460 > clientWidth=438`）。

## Confirmed Decisions

- 大纲元数据放 `outlinesDir/outlines.manifest.json` sidecar，不写进 Markdown frontmatter；解析器会把 frontmatter 当正文。
- 默认生成“需求级大纲”，作为回归资产；任务级大纲作为可选，仅在任务范围明显小于需求时使用。
- 没有任何已关联大纲时，阻止运行并提示“生成测试大纲”；不做静默自动生成，也不静默使用默认/第一个大纲。
- 回归默认只使用已确认关联的大纲；缺失时阻止并列出缺失项，不静默兜底。
- 目标环境地址不写进大纲元数据；元数据只保存可复用的路由，运行时地址仍由任务 `testUrl`、binding、弹窗输入或配置决定。
- 现有 `.md` 大纲和 `binding:<subject>` 继续兼容；未关联的旧大纲可以手动选择或一次性关联。

## Requirements

### R1 弹窗布局

- 「运行测试」弹窗在 360 / 768 / 1006 / 1280 视口下都不出现横向滚动条。
- 长测试大纲名称、长 URL、长错误信息不能撑宽弹窗。
- 修复范围限定在 `#test-dialog` / `#test-form`，不改变宿主 `.tb-dialog` 的全局行为，也不影响回归、详情弹窗。

### R2 大纲元数据与关联

- 在 `outlinesDir` 下维护 `outlines.manifest.json`，记录每个大纲的标题、范围、关联需求、关联任务、路由、来源、状态、内容哈希和更新时间。
- 一个大纲可以关联多个需求（模块级大纲，例如 `dm-model-publish.md` 覆盖 R35499/R35505）；一个需求可以关联多个大纲。
- 新增 `outlines.resolve`，批量返回指定需求/任务解析到的大纲、来源、置信度、候选列表和目标地址来源。
- 新增 `outlines.associate`，把已有大纲关联到需求/任务，供旧大纲迁移和人工确认使用。
- 扩展 `outlines.save`，保存时接受关联信息；manifest 写入必须是原子替换，manifest 缺失或损坏时降级为空，不影响已有大纲读取。
- `outlines.list` / `defaults.get` 返回元数据，面板可以展示关联来源。

### R3 统一解析优先级

按以下顺序解析，且返回来源标识：

1. 弹窗显式选择
2. 任务上次使用 `binding:<taskKey>`
3. 需求上次使用 `binding:requirement:<id>`
4. manifest 中 `taskKeys` 命中
5. manifest 中 `requirementIds` 命中
6. 文件名/标题模糊匹配（标记为“推测”）
7. `config.defaultOutline`（仅在显式允许或没有需求上下文时使用，标记为“默认”）
8. 无（返回 `needOutline`，阻止运行）

- `startRun` 删除 `listOutlines(config)[0]` 兜底；需求/任务没有大纲时返回结构化错误，包含 `needOutline`、`subjectKey`、`requirementId`、`taskKey` 和候选列表。
- UI 与服务端使用同一份解析结果，不允许面板自己用 `defaultOutline` 猜。

### R4 运行测试弹窗

- 测试对象切换时，自动带出该对象解析到的大纲和目标地址。
- 大纲区域显示来源：
  - 绿色：需求关联 / 任务关联 / 上次使用；
  - 黄色：文件名推测 / 默认大纲，并提示人工确认；
  - 红色：未关联，禁用“开始运行”。
- 目标地址显示来源（任务 `testUrl` / 上次使用 / 默认配置 / 手动输入），允许覆盖。
- 未关联大纲时，弹窗内提供「生成测试大纲」按钮；生成并保存后自动选中，不需要关闭弹窗。
- `startTest` 在无大纲时返回可操作的错误信息，而不是让 scenario-copilot 在后台猜一个大纲。

### R5 生成大纲并关联需求

- 工作台新增 `POST /tests/outline`，支持 `preview` 和 `save` 两种模式。
- 生成上下文由工作台组装：需求标题/描述、该需求下的 Trellis 任务标题与 `prd.md`、任务 `testUrl`；传给 scenario-copilot 的 `--requirement-id` 和 `--route`。
- 生成结果先预览再保存；保存时默认写需求级关联（`requirementIds` + `requirementCodes`），可选“仅当前任务”。
- 默认文件名 `R<需求编号>-<标题 slug>.md`；允许用户改名；同名文件默认要求确认覆盖。
- 保存后自动刷新弹窗大纲列表、选中新大纲，并让后续打开该需求/任务时自动解析到它。
- 如果需求级大纲已存在，任务运行优先复用它，不重复生成。

### R6 回归预检

- 工作台在打开回归弹窗或提交回归前，对每个需求执行解析预检。
- 缺失时返回结构化原因：`outline-missing` / `outline-guessed` / `url-missing`，并列出需求编号、标题和建议操作。
- 默认阻止回归；不允许用其他任务的 target 静默替代需求级大纲/地址。
- 预检通过后才调用 `regressions.start`；回归运行记录继续绑定需求、任务和大纲。

### R7 Worktree 任务闭环

- 从 worktree 下发或接手的 Trellis 任务，运行测试时按任务元数据中的 `requirement_id` 继承需求级大纲。
- 需求没有大纲时，弹窗内用需求描述 + 当前任务 PRD 生成，并关联到需求；任务级大纲可选。
- 任务运行结果继续按 `taskKey` / `requirementId` 记录，回归后续复用需求级大纲。
- 本期不要求在任务下发时自动生成大纲；只要求在运行测试入口可完成闭环。

### R8 兼容性

- 现有 `outlinesDir` 中的 `.md`/`.txt` 不改内容、不改文件名即可继续出现在列表中。
- 现有 `binding:<subject>` 继续作为“上次使用”来源。
- 现有运行记录、回归记录、历史 spec 不受影响。
- `config.defaultOutline` 仍可配置，但只在显式允许或没有需求上下文时生效。

## Non-goals

- 不修改 scenario-copilot CLI 的大纲生成算法、提示词或 Playwright 生成/执行链路。
- 不在 Trellis 任务下发/派发时自动生成大纲。
- 不实现一个需求多个任务级大纲的批量回归编排（P2 后续）。
- 不改变目标环境、登录凭据和 `storageState` 的现有模型。
- 不改变 Team 权限、插件宿主协议或宿主 `.tb-dialog` 的全局样式。

## Acceptance Criteria

- [ ] 1006px 视口打开「运行测试」弹窗，`dialog.scrollWidth === dialog.clientWidth`；360px 视口也无横向滚动。
- [ ] 长大纲名、长 URL、长错误文案不会撑宽弹窗；回归/详情弹窗样式不回归。
- [ ] R35627 无关联时，弹窗显示“未关联”，开始运行被阻止，并出现「生成测试大纲」入口。
- [ ] 在弹窗内生成并保存后，新大纲自动选中；关闭再打开同一需求/任务时自动解析到它；后续回归复用它。
- [ ] 已有大纲（如 `dm-business-category.md`）可通过 `outlines.associate` 关联到 R35627，之后任务运行自动带出。
- [ ] 需求/任务没有大纲时，`runs.start` 返回 `needOutline` 结构化错误，不再使用默认大纲或第一个大纲。
- [ ] 回归缺少大纲/地址时返回 `outline-missing` / `url-missing`，不静默使用其他 target。
- [ ] manifest 缺失、损坏、条目对应文件被删除时，`outlines.list` 仍可用且不抛错。
- [ ] 新增的 scenario-copilot 解析/关联测试通过；`yarn test:plugins` 通过。
- [ ] 面板 E2E 使用无障碍快照/截图验证，不依赖 `page.evaluate` 进入 sandbox iframe。
- [ ] 日志、HTTP 响应、manifest 不包含密码、token、storageState 内容。

## Risks

- LLM 生成大纲需要几十秒到两分钟，且质量需要人工确认；因此采用“预览后保存”，不在运行按钮里静默生成。
- manifest 与手工重命名/删除文件可能漂移；列表读取以实际文件为准，孤立条目忽略并在下次保存时清理。
- 一个需求可能存在多个候选大纲；首期用 binding 优先 + manifest 最新 `active` 记录，UI 展示候选供人工切换。
- 不同 worktree 的目标地址可能不同；地址不写入 manifest，继续由任务 `testUrl` / binding / 弹窗输入决定。
