# 按项目类型注入公司开发规范（Trellis-kit 可选组件）

## 1. 背景与问题

公司前后端开发规范目前散落在 Wiki：前端主入口是《01前端开发代码编写与流程规范》（pageId 114165874）及其子页，后端主入口是《后端服务开发规范》（pageId 7766573）。规范内容与具体技术栈强绑定（Vue 2 / ant-design-vue、MOM3 子应用、Java / Spring），而 Trellis 初始化生成的是通用模板：

- `trellis init` 只写通用 `.trellis/spec/frontend|backend/*`，不含公司规范。
- 开发者接入新项目时要手工从 Wiki 拷贝、改写规范，容易漏项，版本也不一致。
- 同一团队的不同项目各自维护一份 spec，无法随公司规范更新而同步。

上游 Trellis CLI 0.6.17 已原生支持自定义 spec registry（`init --registry/--template`），并在 `.trellis/config.yaml` 记录来源、由 `trellis update` 复用。因此不需要在 trellis-board 里另写一套初始化注入脚本，应该把公司规范做成符合官方格式的 registry，由桌面端按项目类型选择模板。

同时，这个能力必须**可开关**：公司规范初始化做成 trellis-kit 的可选 feature。kit 启用该 feature 时，初始化弹窗提供“公司开发规范”下拉选择；kit 未启用（或用户选择“不套用”）时，不检测、不传模板参数、不写公司规范标记。Board 插件运行时没有项目初始化钩子，也不能写目标仓库文件，因此不采用 Board 插件形态。

还有一个独立问题：**公司规范套用不等于项目第一次初始化**。项目可能早已初始化但没有公司规范，也可能已经套过旧模板需要更新或更换模板；如果只在首次 FullInit 提供入口，这些项目永远没有机会补套。因此本期同时交付“随时补套 / 同模板更新 / 更换模板”的项目级入口，并用 `.trellis/spec/.company-spec.json` 标记判断是否已套用。

## 2. 目标

1. 公司规范初始化做成 `trellis-kit` 的可选 feature `company-spec`；feature 启用时，初始化弹窗提供下拉选择（自动识别 / 具体模板 / 不套用）；未启用时完全不套用。
2. 模板 ID 与项目类型的映射放在 feature 描述文件中；调整模板内容不需要发桌面端版本，新增项目类型映射需要更新 feature.json 并随 kit 发版。
3. 首次套用结果可验证、可追溯；失败不阻断项目接入，并在界面上明确告知开发者。
4. 公司规范状态与项目初始化解耦：marker 缺失即“未套用”；已有项目可随时通过项目级入口补套、检查更新、更换模板。
5. 更新与覆盖必须可控：默认保留本地修改；覆盖类操作先备份；不自动联网、不自动覆盖。
6. 不改变现有初始化、Agent-only 初始化、monorepo 行为和 kit 的默认行为。

## 3. 用户与场景

- **主要用户**：通过 trellis-board 接入本地 Git 项目的开发者。
- **典型场景**：
  - 接入一个 Vue 2 + ant-design-vue 的前端项目，下拉默认“自动识别”，自动得到公司前端规范。
  - 接入一个 MOM3 子应用，自动识别为 MOM3 并得到子应用规范（含版本锁定、目录结构等）。
  - 接入一个 Java / Spring 后端项目，自动得到公司后端规范。
  - 接入一个 React + Node 单仓项目（不是 workspace monorepo），得到经过适配的 React/Node 规范，而不是直接套 Vue/Java 条款。
  - 自动识别不准或项目类型特殊时，开发者在下拉中手动选择具体模板；选“不套用”则本次不套用，Trellis 原生空白 spec 仍保留。
  - 项目早已初始化、但从未套过公司规范：开发者从项目菜单打开“公司开发规范”，状态显示“未套用”，选择模板并套用。
  - 公司模板发布了新版本：开发者打开“公司开发规范”点“检查更新”，看到差异后选择保留本地修改或覆盖更新。
  - 项目从 Vue 2 迁移到 React：开发者选择新模板，确认后整体替换，旧模板文件清理，原 spec 备份。
  - kit 未发布该 feature，或 feature 被公司禁用：初始化弹窗与项目入口都不出现，行为与现在完全一致。

## 4. 范围

### 4.1 In scope

- `trellis-kit` 新增可选 feature `company-spec`：
  - `features/company-spec/feature.json` 描述文件（registry 地址、模板映射、默认启用状态）。
  - `manifest.json` 注册 `kind: "feature"` 组件。
  - `apply.py` 支持 `--feature company-spec`，记录启用状态到 `.trellis/.kit-version`。
- 单仓项目（Trellis 非 monorepo 模式）的自动识别与模板套用。
- 识别以下技术栈：Vue 2、MOM3 子应用、Java / Spring、React、Node 后端、Tauri（作为前端证据）。
- 完整初始化（FullInit）时，feature 启用；用户选“自动识别”且识别到唯一模板，或手动选择 feature 中已登记的模板，向 `trellis init` 追加 registry/template 参数。
- 初始化后校验模板标记与入口文件。
- 初始化弹窗展示“公司开发规范”下拉选择（自动识别 / 具体模板 / 不套用，默认取 `enabledByDefault`），并反馈套用成功或失败原因。
- **公司规范生命周期**：
  - 用 `.trellis/spec/.company-spec.json` 判断是否已套用；不单独增加“首次初始化”布尔状态。
  - 项目级“公司开发规范”入口，支持未套用项目补套、同模板更新、更换模板、修复不完整状态。
  - 更新前展示差异/冲突；默认保留本地修改；覆盖类操作先备份。
  - 独立的 spec-only helper，不重跑 `trellis init`，不调用 `trellis update --force`。
- 内网 Git registry 的格式、内容生产、构建校验与发布流程。
- registry 维护文档与 trellis-board 配置/回滚说明。

### 4.2 Out of scope

- 把能力做成 Board 插件（`plugins/<id>/plugin.json`）。现有插件宿主没有 `project.init` 事件、没有文件系统能力，新增该能力会扩大宿主权限模型，本任务不做。
- 全局插件管理 UI、全局公司规范设置页。
- 自动批量为所有项目补套/刷新；本期只做单个项目的显式操作。
- 定时自动检查更新或在应用启动时联网拉取模板。
- 停用/删除公司规范（本期只做套用、更新、更换模板；删除通过 Git 或手工操作）。
- monorepo 按包自动套用（MVP 跳过并提示；后续再评估）。
- 允许用户输入 feature.json 之外的任意模板 ID（下拉只列 feature.templates 中已登记的模板）。
- 修改或内置 Trellis CLI；把模板打进桌面端安装包。
- CI 规范符合性检查、lint 门禁（本任务只注入 spec）。
- 定时抓取 Wiki（内容生产采用脚本 + 人工评审，不在每次 init 或更新时抓取）。
- 删除 Trellis 原生的空白 `.trellis/spec` 骨架。feature 关闭时只表示“不套用公司规范”，不表示“不生成任何 spec 文件”。

### 4.3 交付拆分

本任务按两个可独立验收的里程碑实施；如需分批交付，可拆为两个子任务，依赖关系如下：

1. **M1 首次套用与状态**：kit feature、类型识别、首次 FullInit 下拉、marker 校验、状态检测。
2. **M2 随时补套/更新**：项目级入口、spec-only helper、同模板更新、换模板、冲突/备份、命令与权限。

M2 依赖 M1 的 feature.json、marker 格式与 `CompanySpecStatus`；M1 不依赖 M2。当前按单任务分阶段实现，阶段门禁见 `implement.md`。

## 5. 功能需求

### R1 kit feature 契约

- `trellis-kit/features/company-spec/feature.json` 至少包含：
  - `schemaVersion`：1；
  - `id`：`company-spec`；
  - `name`、`version`、`description`；
  - `enabledByDefault`：布尔值，决定初始化弹窗下拉的默认值（`true` = 自动识别，`false` = 不套用）；
  - `registry`：公司规范 registry 的内网 Git 地址；
  - `templates`：项目类型 → 模板 ID 的映射。
- `trellis-kit/manifest.json` 增加一个 `kind: "feature"` 组件，`id` 为 `company-spec`，`descriptor` 指向上述文件；feature 组件不复制到目标项目。
- `apply.py` 增加可重复的 `--feature <id>`：
  - 校验 feature 在 manifest 中存在、descriptor 可解析且 `id` 一致；
  - 不复制 feature 文件，只把启用列表写入 `.trellis/.kit-version` 的 `features` 字段；
  - `--feature` 是追加语义：未传 `--feature` 时保留 `.kit-version` 中已有 features（重新 attach 不丢记录）；
  - `--agent-only` 与 `--feature` 同时使用时报错；
  - 不传 `--feature` 时，`apply.py` 的复制行为与现在完全一致。
- feature 文件缺失、JSON 非法、`id` 不匹配、registry 为空、templates 为空时，桌面端视为“feature 不可用”，不显示选项、不传模板参数、不报错阻断初始化。
- kit 版本从 `0.3.4` 升到 `0.4.0`（新增 feature 能力）。

### R2 项目类型识别

- 读取仓库根目录及一层包的 `package.json`、`pom.xml` / `build.gradle(.kts)`、`src-tauri/tauri.conf.json`。
- 输出结构化识别结果：命中的技术栈、证据（文件/依赖/版本）、是否 monorepo、是否存在冲突。
- 判定规则至少覆盖：
  - Vue 2：`vue` 依赖主版本为 2，或存在 `vue-template-compiler`，或使用 `ant-design-vue`。
  - MOM3：存在 `@micro-zoe/micro-app`，或包名/目录名明确包含 `mom3`。
  - React：存在 `react` 依赖。
  - Node 后端：存在 `express` / `koa` / `fastify` / `@nestjs/core` / `hono`，或约定目录 `packages/server`、`server`、`backend` 下的 Node 包。
  - Java：存在 `pom.xml` 或 `build.gradle(.kts)`；有 Spring 依赖时在证据中注明。
  - Tauri：存在 `@tauri-apps/api` 或 `src-tauri/tauri.conf.json`；Tauri 只作为前端证据，不推断 Node 后端。
- Vue 2 与 React 同时命中视为冲突：不套用模板，返回可读原因。
- JS workspace / pnpm workspace / lerna 视为 monorepo：MVP 不套用模板，返回可读原因，不改变原有 monorepo 初始化行为。

### R3 模板选择

- 模板映射来自 `feature.json` 的 `templates`，Rust 侧不硬编码模板 ID；至少覆盖：
  - `vue2` → `wit-frontend-vue2`
  - `mom3` → `wit-frontend-mom3`
  - `react` → `wit-frontend-react`
  - `java` → `wit-backend-java`
  - `node` → `wit-backend-node`
  - `react-node` → `wit-fullstack-react-node`
  - `vue2-java` → `wit-fullstack-vue2-java`
  - `mom3-java` → `wit-fullstack-mom3-java`
  - `react-java` → `wit-fullstack-react-java`
- 识别出组合但 `templates` 中没有对应 key（例如 `vue2+node`）时，不猜测回退，返回“没有匹配模板”的 warning。
- 无法识别、冲突、monorepo 时，自动识别不选择模板。
- 初始化弹窗提供下拉选择，选项由 `feature.templates` 的 value 生成，按前端 / 后端 / 全栈分组，并包含：
  - `auto`：自动识别（推荐，默认值之一）；
  - `none`：不套用（默认值之一）；
  - 每个已登记模板 ID：手动指定，跳过自动识别。
- 手动选择优先于自动识别；Rust 侧必须校验请求的模板 ID 在 `feature.templates` 的 value 集合内，不接受任意字符串或路径。
- 用户手动选择的模板与项目实际技术栈不一致时，仍按用户选择执行，但在结果中保留识别证据，便于排查。
- monorepo 例外：即使手动选择模板，MVP 也不套用，返回 monorepo warning；避免 `trellis init` 把同一模板写到每个包。

### R4 首次初始化时套用

- 仅在 `InitializationMode::FullInit` 且 feature 可用、本次选择为 `auto` 或具体模板时，向 `trellis init` 追加：
  `--registry <feature.registry> --template <template-id> --append`
- 选择语义：
  - `auto`：执行 R2 检测与 R3 自动选择；
  - `<template-id>`：跳过自动选择，校验 ID 属于 `feature.templates` 的 value 后直接使用；
  - `none`：不检测、不追加参数、不产生公司规范标记。
- 保留现有 `-y --skip-existing -u <developerId>` 与 Agent 工具参数不变。
- feature 不可用、选择 `none`、自动识别失败/冲突/monorepo：不追加参数，不产生公司规范标记。
- `AgentsOnly` / `None` 模式不尝试套用模板，也不产生相关提示。
- 首次初始化不新增 Tauri command、capability 或权限；沿用现有 `initialize_pending_project` / `initialize_associated_project_agents`，只给前者增加一个可选字符串参数 `companySpecSelection`。生命周期入口新增的命令见 R14。

### R5 首次套用结果校验与失败处理

- 模板根必须包含 `.trellis/spec/.company-spec.json` 标记文件，字段至少包括：
  `schema`、`template`、`version`、`generatedAt`、`bundles`、`sources`。
- 初始化完成后校验：
  1. 标记文件存在且 JSON 可解析；
  2. `template` 与本次选择一致；
  3. 标记声明的 layer 入口文件存在（`frontend/index.md` 和/或 `backend/index.md`）。
- 校验通过：`applied=true`，并在 `apply.py` 中记录 `features: ["company-spec"]`。
- 校验失败或 CLI 下载失败：`applied=false`，返回可操作的 warning；初始化本身仍按现有逻辑成功返回，且不记录 feature 为已启用。
- 典型失败原因要能区分：registry 不可达、认证失败、模板不存在、模板缺少标记、入口文件缺失。
- CLI 在模板下载失败时会回退空白模板并以 0 退出，因此不能以 CLI 退出码作为套用成功依据，必须以标记校验为准。

### R6 首次初始化界面反馈

- `inspect_local_project` 返回 `{ ok, project, companySpec }`，其中 `companySpec` 为 `{ available, enabledByDefault, name, templates, detected }` 或 `null`；`normalizeProjectInspection` 继续只取 project，不受影响。
  - `templates`：`[{ id, label, group }]`，供下拉渲染；
  - `detected`：`{ projectType, template }` 或 `null`，用于显示“检测到 X，将套用 Y”的提示。
- 完整初始化前，若 feature 可用，初始化弹窗显示“公司开发规范”下拉选择；默认值取 `enabledByDefault`（`true` → `auto`，`false` → `none`）；feature 不可用或非 FullInit 时不显示。
- 下拉选项：`auto`（自动识别）、`none`（不套用），以及 `templates` 中按前端/后端/全栈分组的模板。
- `initialize_pending_project` 增加可选参数 `companySpecSelection`（`auto` / `none` / `<template-id>`）；未传时按 feature 的 `enabledByDefault` 处理。Rust 侧校验值合法，非法值按 `none` 处理并返回 warning。
- 完整初始化成功且 `applied=true`：在现有初始化反馈中显示“已套用公司规范模板 `<id>`”。
- `applied=false` 且有 warning：显示警告文案，不阻断后续接入流程。
- 用户选择 `none`：不显示公司规范相关提示。
- `AgentsOnly` / `None`：不显示下拉，不显示公司规范提示。
- 反馈样式与现有初始化反馈一致；新增 warning 语义只用于该场景。

### R7 registry 内容

- registry 仓库使用官方 marketplace 格式：根 `index.json` + `specs/<template-id>/`。
- `index.json` 的 `templates[].type` 固定为 `spec`，`path` 指向 `specs/<template-id>`。
- 每个模板是完整的 `.trellis/spec` 树：
  - `frontend/index.md` 或 `backend/index.md`（入口）
  - `frontend|backend/quality-guidelines.md`
  - `frontend|backend/references/*.md`（按需加载的细节）
  - `.company-spec.json`
  - 通用规范放 `guides/`（含 `guides/index.md`）
- 模板内容必须标注来源（Wiki pageId / 版本 / 导出日期），便于追溯与更新。
- 模板 ID 与 R3 映射一致；新增/删除模板必须同步更新 index 与 feature.json 的 `templates`。

### R8 内容生产流程

- `sync-wiki`：按固定 pageId 清单导出 Wiki 页面为 Markdown；PAT 只从本机环境读取，不写入仓库。
- `build-templates`：从 `bundles/` 组合生成 `specs/*`，生成入口 `index.md`、`quality-guidelines.md`、`.company-spec.json`；`--check` 供 CI 校验 index/模板/标记一致性。
- 内容变更走人工评审后合并；`trellis init` 与更新入口都不实时抓取 Wiki。
- React/Node 适配内容需要单独编写与评审，不能直接把 Vue/Java 条款改个名字。

### R9 可追溯性

- 套用成功时，目标项目同时具备：
  - `.trellis/spec/.company-spec.json`（模板来源与版本）；
  - `.trellis/config.yaml` 的 `registry.spec`（供 `trellis update` 使用）；
  - `.trellis/.kit-version` 的 `features: ["company-spec"]`（首次初始化时 kit feature 状态）。
- 生命周期操作在 `.trellis/.runtime/company-spec-state.json` 记录最近一次动作、时间、模板、备份路径；该文件不是“是否已套用”的判定依据。
- 套用失败或未启用时，`.kit-version` 不记录该 feature；不写半成品标记。
- 日志只记录模板 ID、识别证据条数、失败分类；不记录 PAT、URL 凭据或完整认证信息。

### R10 公司规范状态与标记

- 公司规范是否已套用，**只看** `.trellis/spec/.company-spec.json`：
  - marker 不存在 → `not_applied`；
  - marker 存在且可解析、`template` 可读、声明的入口 index 存在、`.trellis/config.yaml` 有 `registry.spec` → `applied`；
  - marker 存在但 `template` 与当前选择/期望不同 → `template_mismatch`；
  - marker 存在但 `.trellis/config.yaml` 缺 `registry.spec` → `update_source_missing`（可查看，但不能自动更新）；
  - marker 存在但 JSON 不可解析或入口 index 缺失 → `incomplete`。
- 不使用 `.trellis` 是否存在、是否有 tasks、是否 FullInit 来判断公司规范状态；这些只决定“首次初始化入口是否出现”。
- 不单独创建 `.trellis/.company-spec-state.json` 之类的“未初始化标记”；marker 是随模板分发、可被 Git 跟踪的共享状态，缺失就是未套用。
- `.trellis/.runtime/company-spec-state.json` 只记录本地操作历史与备份路径，不参与状态判定。
- 状态检测必须离线完成，不访问 registry；只有用户点“检查更新/套用”时才联网。

### R11 项目级入口与已有项目补套

- 在项目侧边栏的 `ProjectEntry` 增加“公司开发规范”图标按钮（`BookOpenCheck`），仅对 `status === 'approved'` 的本地关联显示；点击打开 `CompanySpecDialog`。
- 打开对话框只调用 `inspect_company_spec`（离线），不自动下载模板。
- `not_applied` 时提供“选择模板并套用”：
  - 下拉包含 `auto`（自动识别）、`none` 和模板列表；默认 `auto`；
  - 选择后调用 `plan_company_spec` 生成差异预览；
  - 确认后调用 `apply_company_spec`，策略固定为 `replace`（已有项目通常已有通用 `frontend/index.md`/`backend/index.md`，append 不可用）。
- `apply` 前必须备份现有 `.trellis/spec` 到 `.trellis/.runtime/company-spec-backups/<timestamp>/spec`；界面明确提示“将替换现有 spec，已备份”。
- 补套不重跑 `trellis init`，不调用 `trellis update --force`；使用 R13 的 spec-only helper。
- 补套成功写入 marker、`.trellis/config.yaml` 的 `registry.spec`、`.template-hashes.json` 与本地操作记录。
- 补套失败（registry 不可达、认证失败、模板不存在等）不修改目标文件；界面显示可操作 warning，不泄露凭据。

### R12 同模板更新、换模板与冲突处理

- `applied` 且 marker.template 与当前选择相同：提供“检查更新”：
  - `plan_company_spec` 下载同模板并比较哈希/内容；
  - 无差异 → `action=none`，显示“已是最新”，不写文件；
  - 有差异 → 展示 `add/update/keep/conflict/delete/keepDeleted` 文件列表。
- 同模板更新默认策略 `keep-local`：
  - 新增文件补齐；
  - 本地未修改的文件更新到模板内容；
  - 本地修改过的文件保留，列入 `conflict`，界面提示“这些文件保留本地修改”；
  - 模板已删除且本地未修改的文件删除；本地修改过的保留。
- 用户可选择 `overwrite`：覆盖所有模板文件（包括冲突），覆盖前备份；界面必须二次确认。
- `template_mismatch` 或用户主动“更换模板”：策略固定为 `replace`；备份后整体替换，旧模板文件不残留，旧 marker 被新 marker 替代。
- `update_source_missing`：允许查看状态；补写 `registry.spec` 通过一次 `keep-local` 更新或 `replace` 完成。
- `incomplete`：提供“修复”，按 marker 可读则用同模板 `replace`，否则要求重新选择模板。
- 不自动执行更新；不在应用启动时联网；所有写操作必须由用户点击确认。

### R13 spec-only helper 契约

- 新增 `trellis-kit/features/company-spec/apply.mjs`，由桌面端用 Node 调用：
  ```
  node apply.mjs --cli <cli_path> --target <repo> --registry <url> --template <id> \
    --mode plan|apply --strategy keep-local|overwrite|replace --json
  ```
- `plan`：下载模板到临时目录，读取 marker/hashes，输出：
  `{ action, current, target, files: { add, update, keep, conflict, delete, keepDeleted }, requiresBackup, warnings }`；不写目标仓库。
- `apply`：重新计算 plan 并写入；写 marker 所在模板文件、`registry.spec`、`.template-hashes.json` 与本地操作记录；返回：
  `{ applied, action, template, version, backupPath, written, kept, deleted, warning }`。
- helper 不调用 `trellis init`，不调用 `trellis update --force`；只复用 CLI 包内的 `template-fetcher`、`registry-config`、`template-hash` 导出。
- 哈希规则：
  - 写入模板文件 → 记录模板内容哈希；
  - 保留本地修改 → 保留旧哈希（或保持缺失），让后续 `trellis update` 识别为 modified；
  - 删除模板文件 → 删除哈希条目。
- 备份：覆盖类操作前复制 `.trellis/spec` 到 `.trellis/.runtime/company-spec-backups/<timestamp>/spec`；备份失败则中止，不写目标文件。
- helper 对 CLI 版本/导出做兼容检查；导出缺失或版本 < 0.6.17 时返回 `helper_incompatible`，不静默写坏。
- 日志不输出 PAT、URL userinfo 或完整凭据。

### R14 生命周期界面、命令与权限

- 新增 `CompanySpecDialog`：
  - 状态卡：`not_applied` / `applied` / `template_mismatch` / `update_source_missing` / `incomplete`，显示当前模板、版本、生成日期、入口文件；
  - 操作：`not_applied` → 选择模板并套用；`applied` → 检查更新；`template_mismatch` → 更换模板；`incomplete` → 修复；
  - `plan` 预览：新增/更新/保留/冲突/删除/保留删除的数量与文件列表（可折叠）；
  - 策略选择：`keep-local`（默认，更新）/ `overwrite`（覆盖，需确认）/ `replace`（补套或换模板，需确认）；
  - 应用后展示结果、备份路径；失败展示 warning。
- 新增 Tauri command：
  - `inspect_company_spec(repo_path)`：离线状态；返回 `{ ok, status }`，`status` 为 `null` 表示 feature 不可用。
  - `plan_company_spec(repo_path, selection)`：联网下载并计算差异；`selection` 为 `auto` / `none` / `<template-id>`；返回 `{ ok, plan }`。
  - `apply_company_spec(repo_path, selection, strategy)`：执行写入；返回 `{ ok, result }`。
- 新命令只允许操作**已批准本地关联**的仓库路径；Rust 侧用现有本地关联存储校验，拒绝任意路径。
- 新命令必须同时注册：
  - `packages/desktop/src-tauri/permissions/desktop.toml` 的 `allow-inspect-company-spec`、`allow-plan-company-spec`、`allow-apply-company-spec`；
  - `packages/desktop/src-tauri/capabilities/board-local-association.json` 的对应权限。
- 首次初始化弹窗（R6）与生命周期对话框共用 `templates`/`detected` 数据结构与 warning 样式；`AgentQuickInitDialog` 不接入。
- 不新增 Board 插件、不新增全局设置页；不改变现有初始化命令的权限。

### R15 安全与边界

- 生命周期命令只接受已批准关联的 `repo_path`；不能通过对话框操作未关联目录。
- 不新增凭据存储；使用本机 Git 凭据访问内网 registry；日志与错误文案不回显 token、URL userinfo 或完整认证信息。
- 模板 ID 只接受 feature.templates 的 value；不接受路径、URL、`..` 或任意字符串。
- 备份目录固定在 `.trellis/.runtime/`（已被 gitignore）；不把备份写入 `.trellis/spec` 或 Git 跟踪范围。
- `replace`/`overwrite` 必须先备份；备份失败时中止，不执行删除/覆盖。
- 同一项目同时只允许一个 plan/apply 操作；界面在请求期间禁用按钮；Rust 侧对同一仓库的写操作串行化或拒绝并发（实现阶段二选一，并在测试中覆盖）。

## 6. 非功能需求

- **兼容性**：Trellis CLI ≥ 0.6.17（桌面端环境门已要求）；现有初始化、Agent-only、monorepo 行为不变；`apply.py` 不传 `--feature` 时与原行为逐字节等价；旧桌面端不返回 `companySpec` 时 Web 无行为变化。
- **性能**：首次模板下载与套用的额外耗时不超过 30 秒；生命周期 `plan`/`apply` 在正常内网下不超过 60 秒；helper 总超时 120 秒，不无限挂起。
- **可用性**：registry 不可达时最多等待超时；失败不阻断项目接入；对话框打开不联网，避免启动卡顿。
- **安全**：不新增凭据存储；命令只操作已批准关联仓库；日志脱敏；不执行用户输入的 shell 片段。
- **可观测性**：记录 feature 是否可用、状态、模板 ID、识别证据数量、plan 统计、校验结果与失败分类；不记录仓库绝对路径以外的敏感信息。
- **可维护性**：技术栈识别、模板选择、plan 差异计算为纯函数，便于单测；模板映射、registry 内容、桌面端代码解耦；helper 与 CLI 内部导出的耦合有版本门与失败分类。
- **可回滚**：把 `feature.json` 的 `enabledByDefault` 改为 `false` 可让新项目默认不套用（仍可手动选择）；移除 feature 文件可完全关闭新入口；已套用项目保留已有 spec，不自动删除；覆盖操作有备份可手工恢复。

## 7. 约束与前置条件

- registry 使用内网 GitLab 时，项目路径必须是两段 `group/repo`；Trellis CLI 的 `parseRegistrySource` 把前两段当作 repo、其余当作 subdir，存在 subgroup 会解析错误。需要先确认公司 GitLab 的实际地址与 group 结构。
- registry 必须对所有目标开发者可读；若为私有仓库，开发者本机需已有 Git 凭据（HTTPS token 或 SSH key）。
- 需要新建内网 registry 仓库的权限，以及 Wiki 导出所需的 PAT。
- registry 是**独立仓库**：本任务交付其脚手架、构建脚本与内容，以及 trellis-board 侧的接线/文档；正式仓库由团队在内网 Git 创建并推送，不把 registry 内容混入 trellis-board 的产品提交。
- feature 描述文件随 `trellis-kit` 嵌入桌面端（`build.rs` 递归收集 `trellis-kit/`，新增文件无需额外清单）；因此改 registry 地址或默认开关需要发 kit/桌面端版本，改模板内容不需要。
- 生命周期 helper 依赖 `@mindfoldhq/trellis` 的内部 ESM 导出（`template-fetcher`/`registry-config`/`template-hash`）；CLI 版本固定 0.6.17，升级 CLI 时必须回归 helper，并在导出缺失时返回 `helper_incompatible`。
- 本机没有 Rust 工具链，Rust 侧只能通过 CI 验证（见 `memory/no-local-rust-toolchain`）。

### 7.1 配置入口与生效时机

| 配置项 | 位置 | 谁配置 | 何时生效 |
| --- | --- | --- | --- |
| feature 是否存在、registry 地址、模板映射、`enabledByDefault` | `trellis-kit/features/company-spec/feature.json`（trellis-board 源码） | trellis-board 维护者 | 随 kit/桌面端发版；应用启动释放 kit 后读取 |
| 新项目是否套用、套用哪个模板 | 初始化弹窗“公司开发规范”下拉 | 开发者 | 本次 `initialize_pending_project` |
| 已有项目补套/更新/换模板 | 项目侧边栏“公司开发规范”入口 → `CompanySpecDialog` | 开发者 | 用户点击“检查更新/套用/更换”并确认后 |
| 公司规范是否已套用 | 目标项目 `.trellis/spec/.company-spec.json` | registry 模板 / helper 写入 | 状态检测与所有生命周期操作的前提 |
| 更新来源 | 目标项目 `.trellis/config.yaml` 的 `registry.spec` | CLI 首次写入；helper 修复/补写 | `trellis update` 与 helper 读取 |
| 最近一次生命周期操作 | `.trellis/.runtime/company-spec-state.json` | helper | 仅用于展示/排查，不参与状态判定 |
| 备份 | `.trellis/.runtime/company-spec-backups/<timestamp>/spec` | helper | 覆盖类操作前；失败即中止 |
| 全局紧急关闭 | 环境变量 `TRELLIS_COMPANY_SPEC_ENABLED=0` | 运维/开发 | 下次 inspect/initialize；新入口与首次下拉都不显示 |
| registry 测试覆盖 | 环境变量 `TRELLIS_COMPANY_SPEC_REGISTRY` | 开发/测试 | 下次初始化 / 生命周期 plan |
| 模板内容 | 独立 registry 仓库 `specs/*` | 规范维护者 | `trellis init` / helper / `trellis update` 拉取时 |

- 没有独立的“插件市场/全局设置”开关；feature 随 kit 发版，项目级入口在项目侧边栏。
- 若后续需要全局启用/停用 UI，应新增桌面设置项并持久化到 `client.json`；本期不做。

## 8. 验收标准

### 8.1 首次套用

- [ ] kit feature 启用 + 单仓 Vue 2 项目：初始化后 `.trellis/spec/.company-spec.json` 的 `template` 为 `wit-frontend-vue2`，`frontend/index.md` 存在，`.kit-version.features` 包含 `company-spec`，界面显示已套用。
- [ ] kit feature 启用 + 单仓 Java 项目：模板为 `wit-backend-java`，`backend/index.md` 存在。
- [ ] kit feature 启用 + 单仓 React + Node 项目：模板为 `wit-fullstack-react-node`，`frontend/index.md` 与 `backend/index.md` 均存在。
- [ ] 初始化弹窗选择“不套用”：不追加模板参数，不写 `.company-spec.json`，`.kit-version` 不记录 feature，初始化成功；Trellis 原生空白 spec 保留。
- [ ] feature 文件缺失/非法：弹窗不显示下拉，初始化行为与现在完全一致，不报错。
- [ ] `enabledByDefault=false`：下拉默认“不套用”；用户改选“自动识别”或具体模板后仍能正常套用。
- [ ] 自动识别失败（unknown/冲突/monorepo）时手动选择 `wit-frontend-vue2`：跳过自动识别，模板套用成功，结果保留识别证据。
- [ ] 请求不在 `feature.templates` 中的模板 ID：不追加模板参数，返回 warning，初始化成功。
- [ ] 无技术栈证据：不追加模板参数，初始化成功，返回“未识别项目类型”的 warning。
- [ ] JS workspace monorepo：不追加模板参数，原有 monorepo 初始化行为不变，返回 monorepo 相关 warning。
- [ ] Vue 2 + React 冲突：不套用模板，返回冲突原因，初始化仍成功。
- [ ] registry 不可达、模板不存在、认证失败：初始化仍成功，`applied=false`，warning 可操作且不泄露凭据；`.kit-version` 不记录 feature。
- [ ] `AgentsOnly` / `None`：不尝试模板，不显示下拉，不显示公司规范提示。
- [ ] `apply.py` 回归：不传 `--feature` 时，现有 kit 测试全绿，`.kit-version` 除新增 `features` 字段外无行为变化；重复 attach 保留已有 features。
- [ ] `apply.py` 新行为：`--feature company-spec` 记录 feature 且不复制 feature 文件；未知 feature、`--agent-only --feature` 返回非零并给出可读错误。

### 8.2 生命周期

- [ ] 已初始化但无 marker 的项目：打开“公司开发规范”显示 `not_applied`；打开对话框不发起网络请求。
- [ ] `not_applied` 项目选择模板并套用：plan 展示新增/冲突文件；确认后写 marker、`registry.spec`、哈希并备份；`frontend|backend/index.md` 存在。
- [ ] 已有通用 `.trellis/spec` 的项目补套：`replace` 前备份，旧文件被替换；备份目录存在且可恢复；没有残留旧 `index.md` 覆盖公司入口。
- [ ] `applied` 且无差异：检查更新返回 `action=none`，不写任何文件。
- [ ] 同模板更新 + 本地修改：默认 `keep-local` 保留本地修改文件（列入 `conflict`），未修改文件更新，新文件补齐，模板删除且未修改的文件删除；哈希符合 R13。
- [ ] 同模板更新 + `overwrite`：覆盖所有模板文件，覆盖前备份；界面二次确认。
- [ ] 换模板：`replace` 后旧模板文件不残留，marker.template 为新模板，备份可恢复。
- [ ] `template_mismatch`、`update_source_missing`、`incomplete` 三种状态都能在对话框识别，并提供对应的更新/修复动作。
- [ ] 用户选 `none` 或取消确认：不写任何文件、不改 marker、不改 config。
- [ ] registry 不可达、认证失败、模板不存在、备份失败：目标文件不变，返回可操作 warning，不泄露凭据。
- [ ] 新命令只接受已批准关联路径：未关联路径返回错误；命令权限已注册，Web 调用不需要额外权限提示。
- [ ] 现有测试全绿；新增 Rust 单测覆盖状态、plan、策略、哈希、命令参数；Web 通过 `tsc`/lint；helper 有 Node 单测。
- [ ] registry 仓库 `build-templates --check` 通过；index 中所有模板可被 CLI/helper 下载（至少一个真实内网端到端验证）。
- [ ] 文档包含 kit feature 开关、项目级入口、更新/备份/回滚、registry 维护手册、发布步骤。
- [ ] 代码中不存在硬编码 PAT；日志无凭据。

## 9. 评审确认记录

> 2026-11-25 验证与确认：第 1 项已实测网络并创建 `prod-mdp/weint-dev-specs`；第 2–10 项用户确认“按建议”。

1. **registry 落点（已创建）**：
   - 已创建 `prod-mdp/weint-dev-specs`（project id `1262`，2026-11-25 22:42，默认分支 `main`，README 初始提交），registry 地址为 `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`；两段路径，独立仓库，SSH `git ls-remote` 已验证 `refs/heads/main`。
   - `http://git.weintdata.cn/devops/weint-spec-board` 已验证存在、私有、默认分支 `main`、两段路径；SSH `ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git` 已用当前 SSH key 验证 `git ls-remote` 成功。
   - **但 `weint-spec-board` 是 Trellis Board 产品仓库**：根目录没有 `index.json`，也没有 `specs/`，不能直接作为 registry；因此另建 `weint-dev-specs`。
   - **HTTP 不可用**：Trellis CLI 会把自托管 URL 的 git/raw 地址重建为 `https://...`（`template-fetcher.js:96`、`:217`），而该主机 HTTPS 返回 404；必须用 SSH URL（`preferGit=true`，不依赖 raw）。
   - **落点调整原因**：原计划 `devops/weint-dev-specs` 无法创建——当前账号 `can_create_project=false`、`projects_limit=0`，`devops` 组要求 Maintainer；`POST /api/v4/projects` 返回 `namespace is not valid`。改用 `prod-mdp` 组（`project_creation_level=developer`）后创建成功。详见 `research/registry-verification.md`。
   - **后续**：Phase 7 在该仓库提交 `index.json`/`specs/`；当前只有 README 初始提交。
   - **落点性质（2026-11-25 用户确认）**：`prod-mdp` 仅作为当前验证落点，后续会申请中性组；迁移时新项目只改 `feature.json` 的 `registry`，已有项目在下一次套用/更新时由 helper 重写 `.trellis/config.yaml` 的 `registry.spec.source`。迁移前 `trellis update` 仍读旧地址，需在文档中说明。
2. **monorepo 范围**：已确认按建议——MVP 只支持单仓；monorepo 跳过并提示，不传模板，不使用 `--no-monorepo` 根级 spec。
3. **React/Node 内容**：已确认按建议——首批交付最小适配版（`frontend-react`、`backend-node`）；内容评审人待团队指定（实现前补名字）。
4. **默认选择**：已确认按建议——首版 `enabledByDefault=false`（默认“不套用”，仍可手动选择），灰度后再评估是否改为 `true`。
5. **空白 spec 语义**：已确认按建议——feature 关闭时保留 Trellis 原生空白 `.trellis/spec` 骨架，只表示“不套用公司规范”；不改上游。
6. **项目级入口形态**：已确认按建议——`ProjectEntry` 图标按钮（`BookOpenCheck`），不放在 `ProjectManagerDialog` 或全局设置页。
7. **备份保留**：已确认按建议——`.trellis/.runtime/company-spec-backups/<timestamp>/spec` 本期永久保留，后续再加清理。
8. **更新默认策略**：已确认按建议——同模板更新默认 `keep-local`，用户可切 `overwrite`，不默认覆盖。
9. **停用/删除**：已确认按建议——本期不做“停用/删除公司规范”，删除通过 Git 或手工操作。
10. **helper 依赖**：已确认按建议——接受 helper 直接 import CLI 0.6.17 内部 ESM 导出（`template-fetcher`/`registry-config`/`template-hash`），以 `helper_incompatible` 兜底；若上游导出变化，先修 helper 或锁版本，不改用不存在的公开 spec-only 命令。
