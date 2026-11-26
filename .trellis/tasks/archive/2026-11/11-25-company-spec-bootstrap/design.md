# 技术设计：Trellis-kit 可选组件注入公司规范

## 1. 结论

公司规范分成四层：

1. **Trellis-kit feature**：`trellis-kit/features/company-spec/feature.json` 提供 registry 地址、项目类型→模板 ID 映射、默认启用状态；`manifest.json` 注册 `kind: "feature"` 组件；`apply.py --feature company-spec` 只记录启用状态，不复制文件。
2. **首次初始化**：FullInit 前读取 kit feature；feature 可用且本次选择为 `auto` 或具体模板时，自动识别或直接使用所选模板，给 `trellis init` 追加 `--registry/--template/--append`；init 后校验 marker，通过才把 feature 传给 `apply.py`。
3. **生命周期（补套/更新/换模板）**：项目级入口读取 `.trellis/spec/.company-spec.json` 判断状态；已有项目通过 spec-only helper 下载模板、计算 diff、备份并写入；不重跑 `trellis init`。
4. **registry**：独立内网 Git 仓库，官方 marketplace 格式（`index.json` + `specs/<id>/`），内容由 Wiki 导出脚本 + 人工评审 + 构建脚本生成。

```
首次初始化：
初始化弹窗
  → inspect_local_project 返回 feature 可用性、模板列表、识别结果与默认选择
  → 用户下拉选择 auto / 具体模板 / none
  → initialize_pending_project(companySpecSelection)
  → FullInit 且选择非 none：
      auto → detect → select(template map)
      template-id → 校验属于 feature.templates
  → trellis init --registry --template --append
  → verify .company-spec.json + index.md
  → 通过：apply.py --feature company-spec（写入 .kit-version.features）
  → 返回 { ok, project, companySpec }

已有项目：
项目侧边栏“公司开发规范”
  → inspect_company_spec（离线读 marker/config）
  → not_applied → 选择模板 → plan_company_spec → 预览 → apply_company_spec(replace, 备份)
  → applied 同模板 → plan_company_spec → 预览 → apply_company_spec(keep-local|overwrite)
  → template_mismatch → 选择新模板 → plan → apply_company_spec(replace, 备份)
  → incomplete/update_source_missing → 修复（replace 或 keep-local）
  → 返回 { ok, result }；写 marker、registry.spec、哈希、本地操作记录
```

这样“feature 启用 = 初始化时可选择公司规范，且项目内可持续补套/更新；feature 不启用 = 完全不套用”，且不改变 kit 在未启用时的任何行为。

## 2. 端到端调用链

1. `ProjectOnboardingDialog.tsx:147` 调 `invoke('inspect_local_project', { path })`。
2. `main.rs:541-563` → `agent_service::inspect_project`（`agent_service.rs:1057-1066`）；在返回的 `{ok, project}` 上追加 `companySpec: company_spec::availability(trellis_kit_root(app), repo_path)`，其中包含模板列表与当前项目的识别结果。
3. 弹窗读取 `value.companySpec`，初始化下拉（默认 `enabledByDefault ? auto : none`）；`normalizeProjectInspection` 仍只取 `project`（`project-inspection.js:9-32`）。
4. `ProjectOnboardingDialog.tsx:257` 的 `initialize()` 调 `invoke('initialize_pending_project', { developerId, agentTools, companySpecSelection })`。
5. `main.rs:565-584` 增加 `company_spec_selection: Option<String>`，传给 `agent_service::initialize_project`（`agent_service.rs:1126-1150`）。
6. `agent_service` 用 `trellis_kit_root(app)`（`agent_service.rs:1097-1124`）读 feature；解析选择（`auto` / `none` / 模板 ID），构造 `CompanySpecRequest` 放进 `InitializeOptions.company_spec`。
7. `onboarding::initialize_project`（`onboarding.rs:490-546`）：
   - `inspect_project` → `initialization_mode`；
   - 仅 `FullInit` 且 `company_spec.is_some()`：
     - `Auto` → `detect` → `select_template`；
     - `Template(id)` → 校验 ID 属于 `feature.templates` 的 value；
     - `None` → 不进入；
   - `Selected` → `trellis_cli::initialize_trellis(..., Some(CompanySpecInit))`；
   - `Skipped` → 不传参，构造 warning outcome；
   - `verify`（仅 Selected）；
   - `apply_kit_overlay(..., features)`：仅 verify 通过时传 `["company-spec"]`；
   - `ensure_agent_gitignore` → 再次 `inspect_project`。
8. `trellis_cli.rs:267-278` 的 `init_args` 在现有参数后追加 `--registry <feature.registry> --template <id> --append`。
9. CLI：解析 registry → clone → 读 index → 下载模板到 `.trellis/spec` → `createWorkflowStructure(skipSpecTemplates=true)` → 写 `.trellis/config.yaml` 的 `registry.spec` → 登记哈希。
10. 桌面端返回 `{ok, project, companySpec}`；Web 展示成功/警告。

### 2.1 生命周期调用链（已有项目）

1. `ProjectEntry` 的“公司开发规范”按钮被点击；`ProjectRail` 打开 `CompanySpecDialog`，传入 `repoPath` 与 `invoke`。
2. `CompanySpecDialog` 调 `invoke('inspect_company_spec', { repoPath })`；命令离线读取 feature、marker、`.trellis/config.yaml`、入口文件与本地操作记录，返回 `{ ok, status }`。
3. 用户选择动作：
   - `not_applied`：选择 `auto` / 模板 / `none`；`auto` 复用 R2 检测；
   - `applied`：检查更新，selection 缺省为 marker.template；
   - `template_mismatch`：选择新模板；
   - `incomplete` / `update_source_missing`：修复。
4. 调 `invoke('plan_company_spec', { repoPath, selection })`；Rust 运行 `apply.mjs --mode plan`，helper 下载模板到临时目录、读 marker/hashes、计算 diff，返回 `CompanySpecPlan`，不写目标仓库。
5. 对话框展示差异与策略；用户确认后调 `invoke('apply_company_spec', { repoPath, selection, strategy })`。
6. Rust 运行 `apply.mjs --mode apply`；helper 重新计算 plan，按策略备份并写入 spec、marker、`registry.spec`、`.template-hashes.json`、`.trellis/.runtime/company-spec-state.json`。
7. 返回 `CompanySpecApplyResult`；对话框刷新状态并展示备份路径。
8. 所有命令在 Rust 侧先校验 `repoPath` 属于已批准本地关联；未关联路径直接拒绝。

## 3. Trellis-kit feature 契约

### 3.1 feature.json

`trellis-kit/features/company-spec/feature.json`：

```json
{
  "schemaVersion": 1,
  "id": "company-spec",
  "name": "公司开发规范",
  "version": "1.0.0",
  "enabledByDefault": false,
  "registry": "ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git",
  "templates": {
    "vue2": "wit-frontend-vue2",
    "mom3": "wit-frontend-mom3",
    "react": "wit-frontend-react",
    "java": "wit-backend-java",
    "node": "wit-backend-node",
    "vue2-java": "wit-fullstack-vue2-java",
    "mom3-java": "wit-fullstack-mom3-java",
    "react-java": "wit-fullstack-react-java",
    "react-node": "wit-fullstack-react-node"
  }
}
```

- key 是 `Detection` 归一化后的项目类型；value 是 registry 中的模板 ID。
- 新增组合只改 feature.json + registry，不需要发桌面端；改 registry 地址或默认开关需要发 kit/桌面端。
- `enabledByDefault` 只是下拉默认值（`true` → `auto`，`false` → `none`）；用户可改选具体模板或 `none`。

### 3.2 manifest 注册

`trellis-kit/manifest.json` 增加：

```json
{
  "id": "company-spec",
  "kind": "feature",
  "descriptor": "features/company-spec/feature.json",
  "description": "初始化时按项目类型套用公司开发规范（可选）"
}
```

- `kind: "feature"` 的组件不参与文件复制；`apply.py` 只做校验与记录。
- kit version 升到 `0.4.0`。

### 3.3 apply.py 行为

新增 `--feature <id>`（`action="append"`）：

- 构建 `feature_components = {c["id"]: c for c in components if c.get("kind") == "feature"}`。
- 校验每个请求的 ID 存在；descriptor 必须位于 `KIT_ROOT / descriptor`，JSON 可解析，`id` 与请求一致。
- `--agent-only` 与 `--feature` 同时使用 → 非零退出，提示 feature 只用于完整初始化。
- 组件复制循环中 `kind == "feature"` 直接 `continue`，不复制 descriptor。
- `.trellis/.kit-version` 增加 `features`：
  - 无 `--feature`：保留已有 `features`（旧 marker 无此字段则为 `[]`）；
  - 有 `--feature`：`sorted(set(existing) | requested)`，追加语义，重复 attach 不丢记录；
  - `--agent-only` 未传 `--feature`：保留已有值，不清空。
- `--dry-run` 打印 `feature: <id> -> <descriptor>`，不写 marker。
- 未传 `--feature` 时，复制/跳过/冲突逻辑与当前完全一致。

`.kit-version` 示例：

```json
{
  "version": "0.4.0",
  "platforms": ["codex"],
  "agentOnly": false,
  "features": ["company-spec"]
}
```

### 3.4 嵌入与测试

- `packages/desktop/src-tauri/build.rs` 的 `walk_kit` 递归收集 `trellis-kit/`（跳过 `__pycache__`/`.git`），新增 `features/company-spec/feature.json` 自动进入 `KIT_ASSETS`；无需改清单。
- `kit_assets.rs` 的 `embedded_kit_has_apply_and_manifest` 增加 feature 文件断言。
- `scripts/test/trellis-kit.test.js` 增加：
  - 不传 `--feature` → `features: []`，feature 文件未被复制；
  - `--feature company-spec` → `features: ["company-spec"]`，文件未复制；
  - 未知 feature → 非零 + 可读错误；
  - `--agent-only --feature` → 非零；
  - 重复运行不传 `--feature` → 保留已有 features。

### 3.5 全局开关

- 主开关是 feature 文件是否存在 + `enabledByDefault`；公司级停用可发布 `enabledByDefault=false` 的 kit，或移除 feature 文件。
- `enabledByDefault` 只影响首次初始化下拉默认值，不影响项目级入口：已启用 feature 的项目仍可手动套用/更新；`TRELLIS_COMPANY_SPEC_ENABLED=0` 才会同时关闭首次下拉与项目级入口。
- 运维/测试覆盖：
  - `TRELLIS_COMPANY_SPEC_ENABLED=0`：强制不可用；
  - `TRELLIS_COMPANY_SPEC_ENABLED=1`：强制默认启用（feature 文件仍需存在）；
  - `TRELLIS_COMPANY_SPEC_REGISTRY`：覆盖 feature.registry，便于本地/测试。
- 不把 registry 地址写成 Rust 常量；feature.json 是唯一来源。

## 4. Registry 契约

### 4.1 地址与认证

- 地址：`ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`（已创建 `prod-mdp/weint-dev-specs`，project id `1262`，默认分支 `main`，README 初始提交；SSH `git ls-remote` 已验证）。Phase 7 提交 `index.json`/`specs/`。
- **必须用 SSH，不能用 `http://`**：CLI 会把自托管 URL 的 git/raw 地址重建为 `https://...`（`template-fetcher.js:96`、`:217`），而公司 GitLab 当前 HTTPS 返回 404；SSH 已验证可用（`ssh -p 1022`，`preferGit=true`）。
- **GitLab 路径必须恰好两段** `group/repo`：CLI `parseRegistrySource` 取前两段为 repo、其余为 subdir；`group/sub/repo` 会被错误解析。`prod-mdp/weint-dev-specs` 满足。
- 不把 PAT 写进应用或仓库；依赖本机 SSH agent/credential manager。
- **临时落点与迁移**：`prod-mdp/weint-dev-specs` 是当前验证落点，后续迁移到中性组。新项目只改 `feature.json` 的 `registry`；已有项目的 `registry.spec.source` 存在 `.trellis/config.yaml`，由下一次 `apply/update` 通过 helper 重写。迁移前 `trellis update` 仍读旧地址，文档需明确迁移步骤。

### 4.2 index.json

```json
{
  "version": 1,
  "templates": [
    {
      "id": "wit-frontend-vue2",
      "type": "spec",
      "name": "公司前端规范（Vue 2 / ant-design-vue）",
      "path": "specs/wit-frontend-vue2",
      "description": "Vue 2 + ant-design-vue 项目的前端规范",
      "tags": ["frontend", "vue2", "ant-design-vue"]
    }
  ]
}
```

字段与上游 `template-fetcher.js:300-350` 一致；`type` 只允许 `spec`（MVP）。

### 4.3 模板目录

```
specs/wit-frontend-vue2/
├── .company-spec.json
├── frontend/
│   ├── index.md
│   ├── quality-guidelines.md
│   └── references/
│       ├── component-conventions.md
│       └── ...
└── guides/
    ├── index.md
    └── ...
```

- `frontend/index.md` / `backend/index.md` 是 agent 的入口；细节放 `references/`，按需读取。
- `.company-spec.json` 是套用标记与内容来源，**必须由 registry 构建生成，桌面端只读不写**；否则会破坏 `.template-hashes.json` 的哈希跟踪，导致 `trellis update` 把标记当作本地修改。

### 4.4 标记文件

```json
{
  "schema": 1,
  "template": "wit-frontend-vue2",
  "version": "2026.11.1",
  "generatedAt": "2026-11-25",
  "bundles": ["common", "frontend-vue2", "frontend-react-adapter"],
  "sources": [
    { "pageId": "28444179", "title": "前端代码编写通用规范", "pageVersion": 8 },
    { "pageId": "43164694", "title": "前端MOM3.0子应用开发规范", "pageVersion": 13 }
  ]
}
```

- 不写 registry commit SHA：标记文件是模板的一部分，无法包含其所在提交的 SHA；版本追溯用 `version` + registry 的 git log。
- `sources` 只记录公开的 pageId/版本/标题，不含 PAT 或内部 URL 凭据。

### 4.5 模板 ID 与组合

| 模板 ID | 组成 | 适用 |
| --- | --- | --- |
| `wit-frontend-vue2` | common + frontend-vue2 | 单仓 Vue 2 |
| `wit-frontend-mom3` | common + frontend-vue2 + frontend-mom3 | MOM3 子应用 |
| `wit-frontend-react` | common + frontend-react-adapter | 单仓 React |
| `wit-backend-java` | common + backend-java | 单仓 Java/Spring |
| `wit-backend-node` | common + backend-node-adapter | 单仓 Node 后端 |
| `wit-fullstack-vue2-java` | common + frontend-vue2 + backend-java | Vue 2 + Java |
| `wit-fullstack-mom3-java` | common + frontend-vue2 + frontend-mom3 + backend-java | MOM3 + Java |
| `wit-fullstack-react-java` | common + frontend-react-adapter + backend-java | React + Java |
| `wit-fullstack-react-node` | common + frontend-react-adapter + backend-node-adapter | React + Node |

- `common` 包含公司通用规范（交付、错误提示、分支管理等）与 `guides/`。
- 组合在 registry 构建脚本中完成，CLI 只负责下载成品模板；桌面端不拼接内容。
- 模板 ID 是 feature.json 与 registry 的契约，变更需同步版本与测试。

### 4.6 后续更新

- 首次套用后，CLI 在 `.trellis/config.yaml` 写 `registry.spec.source/template`，并把 spec 文件写入 `.template-hashes.json`；`trellis update` 会重新下载并走哈希冲突流程。
- 生命周期入口使用 `apply.mjs` 做 spec-only 更新，不调用 `trellis update`（后者会更新整个 Trellis 模板集，且没有 `--only-spec`）；helper 写入的 config/hashes 与 `trellis update` 兼容，用户仍可手工运行 `trellis update`。
- `.kit-version.features` 只是首次初始化的启用审计，不参与后续更新决策；停用 feature 不会自动删除已有 spec，也不会关闭项目级入口（入口由 feature 文件 + `TRELLIS_COMPANY_SPEC_ENABLED` 决定）。

## 5. 项目类型识别

### 5.1 输入

- 根目录：`package.json`、`pom.xml`、`build.gradle`、`build.gradle.kts`、`src-tauri/tauri.conf.json`、`pnpm-workspace.yaml`、`lerna.json`。
- 一层包：根 `package.json` 的 `workspaces`（数组或 `{ packages: [] }`）、`pnpm-workspace.yaml` 的 packages（MVP 支持根 `workspaces` 数组与 `packages/*` 通配）；每个包读取同样的文件。
- 每个文件读取做容错：JSON 解析失败、文件过大（> 1 MiB）、非 UTF-8 时跳过并记录原因，不 panic。

### 5.2 规则

| 技术栈 | 判定 | 证据示例 |
| --- | --- | --- |
| Vue 2 | `dependencies.vue`/`devDependencies.vue` 的 major 为 2；或存在 `vue-template-compiler`；或存在 `ant-design-vue` | `web/package.json: vue ^2.6.11` |
| MOM3 | 存在 `@micro-zoe/micro-app`；或包名/目录名含 `mom3` | `package.json: @micro-zoe/micro-app ^0.8.10` |
| React | 存在 `react` | `web/package.json: react ^19.3.1` |
| Node 后端 | 存在 `express`/`koa`/`fastify`/`@nestjs/core`/`hono`；或相对路径为 `packages/server`、`server`、`backend` 且含 `package.json` | `packages/server/package.json` |
| Java | 存在 `pom.xml` 或 `build.gradle(.kts)`；存在 Spring 依赖时附加证据 | `pom.xml: spring-boot-starter-web` |
| Tauri | 存在 `@tauri-apps/api`；或 `src-tauri/tauri.conf.json` | `packages/desktop/src-tauri/tauri.conf.json` |

- Tauri 只作为前端证据，不推断 Node 后端；React + Tauri 选 `react`，React + Node + Tauri 选 `react-node`。
- 证据最多保留 20 条，路径使用仓库相对 POSIX 路径。
- 识别结果结构：

```rust
pub struct Detection {
    pub vue2: bool,
    pub mom3: bool,
    pub react: bool,
    pub node_backend: bool,
    pub java: bool,
    pub tauri: bool,
    pub monorepo: bool,
    pub evidence: Vec<String>,
}
```

### 5.3 选择与冲突

- `vue2 && react`：冲突，返回 `Ambiguous`，不套用。
- `monorepo`：返回 `MonorepoUnsupported`，不套用（MVP）。
- 无任何前端/后端命中：返回 `Unknown`。
- 组合优先级：
  - 前端：`mom3` > `vue2` > `react`（MOM3 必然带 Vue 2）。
  - 后端：`java` > `node_backend`（同时存在时优先 Java；若实际是 Java + Node 混合，MVP 只取 Java，证据中保留 Node）。
- 归一化 `project_type`：
  - 仅前端：`vue2` / `mom3` / `react`；
  - 仅后端：`java` / `node`；
  - 组合：`vue2-java` / `mom3-java` / `react-java` / `react-node`。
- 在 feature `templates` 中查 `project_type`；查不到 → `Skipped { reason: "没有匹配 <project_type> 的公司规范模板" }`，不回退。
- 生成 `CompanySpecSelection { project_type, template, evidence }`。

### 5.4 monorepo 判定

- 根 `package.json` 有非空 `workspaces`；或存在 `pnpm-workspace.yaml`；或存在 `lerna.json`。
- Maven 多模块不视为 Trellis monorepo（Trellis 的 monorepo 检测面向 JS workspace），仍按单仓处理。
- monorepo 判定只用于“是否自动套用”，不改变 `trellis init` 自身的 monorepo 行为。

### 5.5 下拉选择与手动覆盖

- 选择值只有三类：`auto`、`none`、`<template-id>`。
- 下拉选项由 `CompanySpecAvailability.templates` 生成：
  - 固定项：`auto`（自动识别）、`none`（不套用）；
  - 模板项：按 `group` 分组（前端 / 后端 / 全栈），label 使用模板显示名。
- 默认值：`enabledByDefault ? "auto" : "none"`。
- `auto`：走 5.3 的自动识别与冲突处理。
- `<template-id>`：跳过自动识别，直接使用；Rust 必须校验该 ID 在 `templates.values()` 中，非法值不传参并给 warning。
- 手动选择时仍可运行 `detect` 收集证据，但证据只用于结果展示，不改变用户选择；即使识别为冲突/monorepo，也按手动选择执行（monorepo 仍受 MVP 限制，见下条）。
- monorepo 是唯一例外：即使手动选择模板，MVP 也不套用，返回 monorepo warning。原因是 `trellis init` 的 monorepo 分发行为未验证，强行套用可能把同一模板写到每个包。
- `none`：不检测、不传参、不写 marker、不记录 feature。

## 6. Rust 侧改动

### 6.1 新模块 `agent/company_spec.rs`

职责：

- `load_feature(kit_root: Option<&Path>) -> Option<CompanySpecFeature>`：读取 `<kit_root>/features/company-spec/feature.json`；缺失/非法/id 不匹配/registry 为空/templates 为空 → `None` + warn。
- `availability(kit_root, repo_path) -> Option<CompanySpecAvailability>`：feature 存在且未被 `TRELLIS_COMPANY_SPEC_ENABLED=0` 关闭时返回；包含模板列表与 `detect`/`select_template` 得到的 `detected`；`enabledByDefault` 可被 env `=1` 强制 true。
- `config(feature: &CompanySpecFeature) -> CompanySpecConfig`：registry 可被 `TRELLIS_COMPANY_SPEC_REGISTRY` 覆盖。
- `parse_choice(input: Option<&str>, enabled_by_default: bool) -> (CompanySpecChoice, Option<String>)`：`None` → 默认；`auto`/`none`/合法模板 ID；非法值 → `Skip` + warning。
- `detect(repo: &Path) -> Detection`：只读扫描，容错。
- `select_template(&Detection, &BTreeMap<String, String>) -> SelectionResult`：纯函数，只处理 `auto`。
- `resolve_manual(template: &str, config: &CompanySpecConfig, detection: &Detection) -> SelectionResult`：校验模板 ID 属于 `templates.values()`，收集证据，不改变选择。
- `verify(repo: &Path, selection: &CompanySpecSelection) -> Result<(), String>`：读取并校验标记与入口文件；失败返回可读 warning。
- 对外类型：

```rust
pub struct CompanySpecFeature {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled_by_default: bool,
    pub registry: String,
    pub templates: BTreeMap<String, String>,
}

pub struct CompanySpecTemplateOption {
    pub id: String,
    pub label: String,
    pub group: String, // frontend | backend | fullstack
}

pub struct CompanySpecDetected {
    pub project_type: String,       // unknown | conflict | monorepo | vue2 | ...
    pub template: Option<String>,   // 自动识别出的模板；无匹配时为 None
    pub evidence: Vec<String>,
    pub warning: Option<String>,
}

pub struct CompanySpecAvailability {
    pub available: bool,
    pub enabled_by_default: bool,
    pub name: String,
    pub templates: Vec<CompanySpecTemplateOption>,
    pub detected: CompanySpecDetected,
}

pub struct CompanySpecConfig {
    pub feature_id: String,
    pub registry: String,
    pub templates: BTreeMap<String, String>,
}

pub enum CompanySpecChoice {
    Auto,
    Skip,
    Template(String),
}

pub struct CompanySpecRequest {
    pub config: CompanySpecConfig,
    pub choice: CompanySpecChoice,
    pub warning: Option<String>, // 非法输入等；choice 同时为 Skip
}

pub struct CompanySpecSelection {
    pub project_type: Option<String>, // 手动选择时为 None 或识别结果
    pub template: String,
    pub evidence: Vec<String>,
}

pub enum SelectionResult {
    Selected(CompanySpecSelection),
    Skipped { project_type: String, reason: String, evidence: Vec<String> },
}

pub struct CompanySpecInit<'a> {
    pub registry_url: &'a str,
    pub template: &'a str,
}

pub struct CompanySpecOutcome {
    pub attempted: bool,
    pub applied: bool,
    pub project_type: Option<String>,
    pub template: Option<String>,
    pub warning: Option<String>,
    pub evidence: Vec<String>,
}
```

- 所有对外返回序列化为 camelCase。
- 模块内不 `unwrap`/`expect`/`panic!`（测试除外）；文件读取失败只记录/跳过。
- 测试外移：`#[cfg(test)] mod tests;` + `company_spec/tests.rs`，避免单文件超限。

### 6.2 `trellis_cli.rs`

- `init_args` 增加可选参数：

```rust
fn init_args(
    runtime: &TrellisRuntime,
    developer_id: &str,
    agent_tools: &[String],
    company_spec: Option<&CompanySpecInit>,
) -> Vec<OsString>
```

在现有参数末尾追加：

```
--registry <registry_url> --template <template-id> --append
```

- `initialize_trellis` 增加 `company_spec: Option<&CompanySpecInit>`，透传给 `initialize_with_repair`；`AgentsOnly` 传 `None`。
- `initialize_with_repair` / `run_init_process` 只在 `InitMode::Full` 使用该参数；Agent-only 忽略。
- 参数顺序固定在现有 flags 之后，便于测试断言；不改变 `-y --skip-existing -u` 的语义。
- registry URL 做最小校验：非空、无 NUL/换行；不解析 URL，交给 CLI。

### 6.3 `onboarding.rs`

- `InitializeOptions` 增加 `company_spec: Option<CompanySpecRequest>`（owned，避免引入生命周期）。
- `InitializeProjectResult`：

```rust
pub struct InitializeProjectResult {
    pub project: ProjectInspection,
    pub company_spec: Option<CompanySpecOutcome>,
}
```

- 流程：

```rust
let mode = initialization_mode(...);
let mut outcome = None;
let mut init = None;
if mode == InitializationMode::FullInit {
    if let Some(request) = options.company_spec {
        let detection = company_spec::detect(repo_path);
        let selection = match &request.choice {
            CompanySpecChoice::Skip => {
                // 用户主动选 none：不产生提示；非法输入才产生 warning
                if let Some(warning) = request.warning {
                    outcome = Some(warning_outcome(warning));
                }
                None
            }
            CompanySpecChoice::Auto =>
                Some(company_spec::select_template(&detection, &request.config.templates)),
            CompanySpecChoice::Template(id) =>
                Some(company_spec::resolve_manual(id, &request.config, &detection)),
        };
        if let Some(selection) = selection {
            match selection {
                Selected(selection) => {
                    init = Some(CompanySpecInit {
                        registry_url: &request.config.registry,
                        template: &selection.template,
                    });
                    outcome = Some(CompanySpecOutcome { attempted: true, applied: false, ... });
                }
                Skipped { .. } => outcome = Some(warning outcome),
            }
        }
    }
}
// init
// verify（仅 init 存在）：成功则 outcome.applied = true，失败则 warning
// apply_kit_overlay(features = if outcome.applied { ["company-spec"] } else { [] })
```

- `Selected` 但 `verify` 失败：outcome `applied=false`，不传 feature；不删除已下载的模板（避免破坏用户文件），只给 warning。
- `Skipped`：`attempted=true, applied=false, warning=reason`。
- `Skip` 且无 warning：`company_spec` 不构造，返回值中 `companySpec` 为 `null`。
- `AgentsOnly` / `None`：`company_spec=None`，返回值中 `companySpec` 为 `null`。
- 初始化命令本身失败时，按现有错误返回；不伪造 `companySpec`。
- 现有 `InitializeOptions` 构造点（`agent_service.rs`、测试）需要补字段。
- `apply_kit_overlay` 增加 `features: &[String]` 参数：
  - 有 feature 时追加 `--feature <id>`（每个一次）；
  - 无 feature 时不追加，保持旧行为；
  - `--force` 与超时不变。

### 6.4 `agent_service.rs` / `main.rs`

- `agent_service::inspect_project` 返回：

```json
{
  "ok": true,
  "project": { "...": "..." },
  "companySpec": {
    "available": true,
    "enabledByDefault": false,
    "name": "公司开发规范",
    "templates": [
      { "id": "wit-frontend-vue2", "label": "前端 Vue 2", "group": "frontend" },
      { "id": "wit-backend-java", "label": "后端 Java", "group": "backend" }
    ],
    "detected": {
      "projectType": "vue2",
      "template": "wit-frontend-vue2",
      "warning": null,
      "evidence": ["web/package.json: vue ^2.6.11"]
    }
  }
}
```

feature 不可用时 `companySpec` 为 `null`。

- `agent_service::initialize_project` 增加 `company_spec_selection: Option<String>` 参数：
  - `let feature = company_spec::load_feature(trellis_kit_root(app).as_deref());`
  - `let (choice, warning) = company_spec::parse_choice(company_spec_selection.as_deref(), feature.enabled_by_default);`
  - `Skip` 且无 warning → `None`；否则 `Some(CompanySpecRequest { config, choice, warning })`。
  - 非法模板 ID 由 `parse_choice` 转为 `Skip + warning`，不进入 init。
- 返回：

```json
{
  "ok": true,
  "project": { "...": "..." },
  "companySpec": {
    "attempted": true,
    "applied": true,
    "projectType": "vue2",
    "template": "wit-frontend-vue2",
    "warning": null,
    "evidence": ["web/package.json: vue ^2.6.11"]
  }
}
```

- `main.rs:565-584` 的 `initialize_pending_project` 增加 `company_spec_selection: Option<String>`；Tauri 参数名对应前端 `companySpecSelection`。
- `initialize_associated_project_agents` 不传该参数（`None`），AgentsOnly 不产生 `companySpec`。
- 首次初始化不新增 command/capability/permission；生命周期新增 `inspect_company_spec` / `plan_company_spec` / `apply_company_spec` 及对应权限，见 §14.5。

## 7. Web 侧改动（首次初始化）

- `packages/web/src/lib/project-inspection.js` 增加纯函数：

```js
export function normalizeCompanySpecAvailability(value) {
  if (!value || typeof value !== 'object') return null
  if (value.available !== true) return null
  const templates = Array.isArray(value.templates)
    ? value.templates
        .filter((t) => t && typeof t.id === 'string' && t.id)
        .map((t) => ({
          id: t.id,
          label: text(t.label) || t.id,
          group: text(t.group) || 'other',
        }))
    : []
  if (templates.length === 0) return null
  const detected = value.detected && typeof value.detected === 'object'
    ? {
        projectType: text(value.detected.projectType) || 'unknown',
        template: text(value.detected.template) || null,
        warning: text(value.detected.warning) || null,
        evidence: Array.isArray(value.detected.evidence) ? value.detected.evidence : [],
      }
    : null
  return {
    available: true,
    enabledByDefault: value.enabledByDefault === true,
    name: text(value.name) || '公司开发规范',
    templates,
    detected,
  }
}
```

- `ProjectOnboardingDialog.tsx`：
  - inspect 的 `.then((value) => { ... })`（:147-163）保存 `value.companySpec`，设置 `companySpecSelection` 默认值（`enabledByDefault ? 'auto' : 'none'`）。
  - 新增 state：`companySpec`、`companySpecSelection`。
  - 在初始化表单中渲染“公司开发规范”下拉，仅当 `companySpec?.available && inspection?.requiresInitialization`：
    - 固定项“自动识别（推荐）”（`auto`）与“不套用”（`none`）；
    - 按 `group` 用 `<optgroup>` 分组渲染模板项；
    - 下方提示：`detected.template` 存在时显示“检测到 `<projectType>`，将套用 `<template>`”；否则显示 `detected.warning` 或“未识别到唯一模板，可手动选择”。
  - `initialize()`（:257）的 invoke 增加 `companySpecSelection`。
  - `feedback` 类型从 `{ tone: 'status' | 'error' }` 扩展为 `{ tone: 'status' | 'warning' | 'error' }`（:48）；warning 用 Tailwind amber。
  - `applied=true`：状态文案追加“已套用公司规范模板 `<template>`”。
  - `attempted=true && applied=false`：warning 文案“公司规范模板未套用：`<warning>`”。
  - 用户选择 `none` 或 `companySpec=null`：不追加文案。
- `AgentQuickInitDialog.tsx`：不读取 `companySpec`，不显示下拉。
- `normalizeProjectInspection` 不改；`{ok, project, companySpec}` 仍返回 project（回归）。
- 不新增全局状态、事件或 Tauri 调用。
- 生命周期对话框复用本节的 `warning` 样式、`templates`/`detected` 结构；独立入口与命令见 §14.6，不在初始化弹窗内承载更新操作。

## 8. 配置与开关

| 层级 | 开关 | 行为 |
| --- | --- | --- |
| kit 发布 | feature 文件是否存在 | 不存在 → 不可用，零行为 |
| kit 默认 | `enabledByDefault` | 下拉默认 `auto` / `none` |
| 项目初始化 | 下拉选择 | `auto` / 具体模板 / `none`；`none` → 本次不套用 |
| 运维/测试 | `TRELLIS_COMPANY_SPEC_ENABLED=0/1` | 强制关闭/默认开启 |
| 运维/测试 | `TRELLIS_COMPANY_SPEC_REGISTRY` | 覆盖 registry 地址 |
| 已初始化项目 | 项目侧边栏“公司开发规范” | `not_applied` 补套；`applied` 更新；`template_mismatch` 换模板；`incomplete` 修复 |

- 未配置 feature：`availability=None`，`InitializeOptions.company_spec=None`，初始化路径与旧版完全一致。
- 不把 registry 地址写进源码常量；不把模板打进安装包。
- 失败不影响 `runtime_status` 或环境门。

### 8.1 配置位置、时机与入口

| 配置项 | 位置 | 谁配置 | 何时生效 | 入口 |
| --- | --- | --- | --- | --- |
| feature 是否存在、registry 地址、模板映射、`enabledByDefault` | `trellis-kit/features/company-spec/feature.json`（trellis-board 源码） | trellis-board 维护者 | 随 kit/桌面端发版；`build.rs` 嵌入，应用启动释放 kit 后读取 | 改源码 + 发版，**不是**用户运行时配置 |
| 单个项目是否套用、套用哪个模板 | 初始化弹窗“公司开发规范”下拉 | 开发者（每个项目初始化时） | 本次 `initialize_pending_project` 调用 | 桌面端项目接入弹窗；仅 FullInit 显示 |
| 本次选择的结果 | `.trellis/config.yaml` 的 `registry.spec`（CLI 写入） | Trellis CLI | 初始化完成后；`trellis update` 复用 | 目标项目内文件，不在 Board 设置里 |
| 全局紧急关闭 | 环境变量 `TRELLIS_COMPANY_SPEC_ENABLED=0` | 运维/开发 | 下次 `inspect`/`initialize` | 进程环境变量，无 UI |
| registry 测试覆盖 | 环境变量 `TRELLIS_COMPANY_SPEC_REGISTRY` | 开发/测试 | 下次初始化 | 进程环境变量，无 UI |
| 模板内容 | 独立 registry 仓库的 `specs/*` | 规范维护者 | `trellis init`/`trellis update` 拉取时 | Git 仓库，**不需要**发桌面端 |

| 公司规范是否已套用 | 目标项目 `.trellis/spec/.company-spec.json` | registry 模板 / helper | 打开项目级入口时离线读取 |
| 已有项目补套/更新/换模板 | 项目侧边栏“公司开发规范”对话框 | 开发者 | 点击“套用/检查更新/更换模板”并确认后 |
| 备份 | `.trellis/.runtime/company-spec-backups/<timestamp>/spec` | helper | 覆盖类操作前；失败即中止 |

- **没有**独立的“插件市场/全局设置”开关：feature 随 kit 发版，项目级入口在项目侧边栏。
- 若后续需要全局启用/停用 UI，应新增桌面设置项并持久化到 `client.json`；本期不做。
- `enabledByDefault=false` 只改下拉默认值为 `none`，仍保留下拉，用户可主动选择模板。

## 9. 失败模式

| 条件 | 行为 |
| --- | --- |
| feature 文件缺失/非法 | 弹窗无下拉；`companySpec=null`；初始化行为与现在一致 |
| feature 被 `TRELLIS_COMPANY_SPEC_ENABLED=0` 关闭 | 同上 |
| 用户选择 `none` | 不检测、不传参、不写 marker、不记录 feature；初始化成功 |
| 未识别技术栈（auto） | 不传模板参数，`attempted=true, applied=false`，warning“未识别项目类型” |
| Vue 2 + React 冲突（auto） | 不传模板参数，warning 列出冲突证据 |
| monorepo（auto 或手动） | 不传模板参数，warning 提示暂不支持；不改变 monorepo 初始化 |
| 组合无对应模板（auto） | 不传模板参数，warning“没有匹配 <type> 的模板” |
| 手动选择的模板 ID 不在 feature.templates | 不传模板参数，warning“模板不在公司规范列表中”；初始化成功 |
| 手动选择 + 自动识别冲突 | 按手动选择执行；不因冲突阻断，证据保留在结果中 |
| registry 不可达 / 超时 | CLI 回退空白 spec 并 0 退出；标记缺失，`applied=false`，warning“无法访问规范仓库” |
| Git 认证失败 | 同上；warning 提示检查本机 Git 凭据，不回显 token |
| 模板 ID 不存在 | 同上；warning“规范模板不存在” |
| 模板缺少 `.company-spec.json` | `applied=false`，warning“模板标记缺失” |
| 标记 template 不匹配 | `applied=false`，warning 包含期望/实际模板 |
| 入口 index.md 缺失 | `applied=false`，warning“模板入口文件缺失” |
| 初始化命令失败 | 按现有错误返回；不返回虚假 companySpec |
| `apply.py --feature` 失败 | 现有 `KIT_APPLY_FAILED` 硬错误；初始化失败，不静默降级 |
| 已有项目无 marker | `inspect_company_spec` 返回 `not_applied`；不联网；用户可补套 |
| marker JSON 损坏/入口缺失 | `incomplete`；提供“修复”，同模板可读时 `replace`，否则重新选择模板 |
| marker 存在但 config 缺 `registry.spec` | `update_source_missing`；可查看，修复时补写 config |
| 同模板更新有本地修改 | 默认 `keep-local`：保留本地修改并列入 `conflict`；`overwrite` 需二次确认并备份 |
| 换模板 | `replace`：备份后整体替换，旧模板文件不残留 |
| 备份失败 | 中止 apply，目标文件不变，warning“无法创建备份” |
| 并发 plan/apply | 同一仓库同一时间只允许一个操作；UI 禁用按钮，Rust 对写操作串行化/拒绝 |
| 未批准关联的 repoPath | 命令返回错误；不读写该路径 |

## 10. 测试

### 10.1 kit Node 测试（`scripts/test/trellis-kit.test.js`）

- 不传 `--feature`：`.kit-version.features` 为 `[]`，feature descriptor 未被复制。
- `--feature company-spec`：features 记录，descriptor 未复制。
- 未知 feature：非零退出，错误包含可用 ID。
- `--agent-only --feature`：非零退出。
- 重复 attach 不传 `--feature`：保留已有 features。
- 现有复制/冲突/平台测试全绿。

### 10.2 Rust 单测（`company_spec/tests.rs`）

- `load_feature`：合法、缺失、坏 JSON、id 不匹配、空 registry、空 templates。
- `availability`：默认、`ENABLED=0`、`ENABLED=1`、`REGISTRY` 覆盖；templates 列表顺序/分组；detected 的命中与 warning。
- `parse_choice`：缺省 + `enabled_by_default=true/false`；`auto`；`none`；合法模板 ID；非法模板 ID → `Skip + warning`。
- `resolve_manual`：合法 ID → `Selected` 且跳过自动选择；非法 ID → `Skipped`；monorepo → `Skipped`。
- `detect`：
  - Vue 2（`vue: ^2.6.11`）→ `vue2=true`；
  - Vue 3 + React → 冲突；
  - MOM3（`@micro-zoe/micro-app`）→ `mom3=true`；
  - Java（`pom.xml`）→ `java=true`；
  - Node 后端（`packages/server/package.json`）→ `node_backend=true`；
  - Tauri（`src-tauri/tauri.conf.json`）→ `tauri=true`，但不推断 Node；
  - 空目录 → 全 false；
  - 损坏/超大 package.json → 不 panic。
- `select_template`：每种组合的模板 ID；冲突/monorepo/unknown/无映射的 `Skipped` 原因。
- `init_args`：有/无 `CompanySpecInit` 的参数序列；含空格/中文的 developer_id 仍正确（现有行为）。
- `verify`：标记缺失、JSON 损坏、template 不匹配、入口缺失、成功五种情况。

### 10.3 集成/命令测试

- 用临时目录 + 本地 Git registry 跑一次 `trellis init`，断言 `.trellis/config.yaml` 的 `registry.spec`、`.company-spec.json`、index.md 存在。
- 用不可达 registry 跑一次，断言 init 仍成功、`applied=false`、`.kit-version` 无 feature。
- 本机无 Rust 工具链时由 CI 执行；本地只做 `cargo fmt --check` 不可用，不能声称本地通过。

### 10.4 Web

- 仓库没有 Web 单测框架；以 `tsc -b --noEmit`、`oxlint` 和手工验证为准。
- 手工覆盖：applied / warning / 选择 `none` / 手动选择模板 / feature 不可用 五种分支。
- `normalizeCompanySpecAvailability` 可用 Node 直接跑纯函数断言（如现有测试入口支持）。

### 10.5 registry 仓库

- `build-templates --check`：index 中每个模板存在、`.company-spec.json` 的 template 与目录一致、入口文件存在。
- 每个模板的 Markdown 链接检查（可选）。
- 真实内网端到端：至少一个 Vue 2、一个 Java、一个 React+Node fixture 仓库；验证 `trellis update` 能按 registry 刷新。

### 10.6 生命周期测试

- helper Node 单测（`trellis-kit/features/company-spec/test/apply.test.mjs` 或 `scripts/test/company-spec.test.js`）：
  - `not_applied` + 已有通用 spec → `action=apply`，`requiresBackup=true`，冲突文件被列出；
  - 同模板无差异 → `action=none`，不写文件；
  - 同模板有本地修改 → `keep-local` 保留、`overwrite` 覆盖；
  - 模板新增/删除文件 → add/update/delete/keepDeleted 正确；
  - `template_mismatch` → `action=replace`；
  - 备份失败 → 不写目标文件；
  - 哈希更新符合“写入→模板哈希、保留→旧哈希、删除→删条目”；
  - CLI 导出缺失 → `helper_incompatible`。
- Rust 单测（`company_spec/lifecycle_tests.rs`）：
  - `inspect_company_spec` 五种状态；
  - `plan_company_spec` 参数校验（非法 selection、未关联路径）；
  - `apply_company_spec` 策略校验（`keep-local` 只允许 update；`replace` 只允许 apply/mismatch）；
  - 命令返回 camelCase、错误信息脱敏。
- 集成：临时 registry + 临时项目，跑 `plan` → `apply` → `inspect` 状态迁移；同模板更新、换模板、本地修改保留。
- Web：无单测框架，手工覆盖 `not_applied` / `applied` / `template_mismatch` / `incomplete` / `update_source_missing` 五种状态与 plan 预览、策略切换、取消确认。
- 权限：未在能力文件注册时命令调用失败；注册后已批准关联可调用、未关联被拒。

## 11. 发布与回滚

- 发布顺序：registry 先可用 → kit 带 feature（灰度期可 `enabledByDefault=false`）→ 桌面端发布 → 灰度验证 → 默认开启。
- 回滚：
  - 发布 `enabledByDefault=false` 的 kit：新项目下拉默认“不套用”；
  - 移除 feature 文件：弹窗不显示、初始化完全走旧路径；
  - `TRELLIS_COMPANY_SPEC_ENABLED=0`：立即关闭（需要能改环境变量）；
  - 已初始化项目保留已有 `.trellis/spec` 与 `.trellis/config.yaml`，不自动删除。
- 生命周期回滚：
  - 覆盖类操作前已备份 `.trellis/spec`；回滚时从 `.trellis/.runtime/company-spec-backups/<timestamp>/spec` 复制回 `.trellis/spec`；
  - `registry.spec` 与 `.template-hashes.json` 由 helper/CLI 维护；回滚 spec 后重新运行一次 `plan` 校正哈希，或从 Git 恢复这两个文件；
  - 停用 feature 只关闭入口，不删除已有 spec、不清理备份。
- 不修改 `.trellis/config.yaml` 的既有格式；首次套用由 CLI 写入，生命周期由 helper 用 `writeSpecRegistryConfig` 写入。

## 12. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| Board 插件（`plugins/<id>`） | 否决 | 插件宿主没有 `project.init` 事件，也没有文件系统能力；新增会扩大权限模型与攻击面 |
| 仅环境变量开关 | 否决 | 不是“插件启用”语义；没有 UI，无法按项目选择 |
| 自研 post-init 注入脚本 | 否决 | 重复 CLI 的下载/哈希/config 逻辑，`trellis update` 不认，升级易碎 |
| 服务端 workspace 模板 zip | 否决 | 桌面初始化走本地 `trellis init`，该 zip 是另一条链路；且不区分项目类型 |
| 共享文件夹 | 否决（MVP） | 无版本/冲突语义，CLI 不支持 `file://` registry 的稳定 clone；后续可加本地缓存层 |
| 初始化时实时抓 Wiki | 否决 | 需要 PAT、网络不稳定、内容未评审，且每次初始化都依赖 Wiki |
| 模板打进桌面端 | 否决 | 规范更新要发版，耦合严重 |
| monorepo 按包套用 | 延后 | `-y` 会把同一模板套到每个包；MOM3/Java 混合仓需要逐包映射，MVP 不做 |
| 已有项目重跑 `trellis init --template/--registry` | 否决 | `hasTemplateRequest` 会绕过 re-init 保护；不是 spec-only，可能改写 `.trellis` 其他结构 |
| 用 `trellis update --force` 做更新 | 否决 | 没有 `--only-spec`，会覆盖整个模板集的变更文件；不满足“只更新公司规范” |
| 新增 `.trellis/.company-spec-state.json` 作为套用标记 | 否决 | 与模板内 `.company-spec.json` 形成双重真相；后者可随模板分发、被 Git 跟踪 |
| 启动时自动检查/更新 | 否决 | 网络不稳定、开发者无感知覆盖；改为显式“检查更新” |
| helper 走临时 `trellis init` 沙箱再复制 | 否决 | 沙箱初始化会产生无关 `.trellis` 文件，复制边界复杂；直接复用 template-fetcher 更小 |

## 14. 公司规范生命周期（补套/更新/换模板）

### 14.1 状态模型与判定

项目初始化与公司规范是两个状态机：

- 项目初始化：`FullInit` / `AgentsOnly` / `None`（`onboarding.rs:182-194`）。它只决定首次初始化弹窗是否出现，不代表公司规范是否套过。
- 公司规范：以 `.trellis/spec/.company-spec.json` 为准；不新增 `.trellis` 根目录的“未初始化标记”。

| 状态 | 判定 | 可用动作 |
| --- | --- | --- |
| `not_applied` | marker 不存在 | 选择模板并套用（`replace`） |
| `applied` | marker 可解析、入口 index 存在、`registry.spec` 存在 | 检查更新（`keep-local`/`overwrite`） |
| `template_mismatch` | marker.template 与当前选择/期望不同 | 更换模板（`replace`） |
| `update_source_missing` | marker 存在但 `.trellis/config.yaml` 缺 `registry.spec` | 修复（`keep-local` 或 `replace`） |
| `incomplete` | marker 损坏或入口 index 缺失 | 修复（同模板 `replace`，否则重选模板） |

`inspect_company_spec` 只读以下内容，不访问 registry：
- `<kit_root>/features/company-spec/feature.json`（feature 不可用 → `status=null`）；
- `.trellis/spec/.company-spec.json`；
- `.trellis/config.yaml` 的 `registry.spec`；
- marker 声明的 `frontend/index.md` / `backend/index.md`；
- `.trellis/.runtime/company-spec-state.json`（可选，仅展示最近操作）。

`CompanySpecStatus`：

```rust
pub struct CompanySpecStatus {
    pub available: bool,
    pub name: String,
    pub state: CompanySpecState, // not_applied | applied | template_mismatch | update_source_missing | incomplete
    pub template: Option<String>,
    pub version: Option<String>,
    pub generated_at: Option<String>,
    pub registry_source: Option<String>,
    pub registry_template: Option<String>,
    pub entrypoints: Vec<String>,
    pub warning: Option<String>,
    pub templates: Vec<CompanySpecTemplateOption>,
    pub detected: CompanySpecDetected,
    pub last_operation: Option<CompanySpecOperationRecord>,
}
```

### 14.2 操作矩阵

| 当前状态 | 用户动作 | selection | strategy | 备份 |
| --- | --- | --- | --- | --- |
| `not_applied` | 套用 | `auto` / `<template>` | `replace` | 必须 |
| `applied`（有差异） | 检查更新 | 缺省 = marker.template | `keep-local`（默认） | 仅 `overwrite` 必须 |
| `applied`（有差异） | 覆盖更新 | marker.template | `overwrite` | 必须 |
| `applied`（无差异） | 检查更新 | marker.template | — | 不写文件 |
| `template_mismatch` | 更换模板 | 新 `<template>` | `replace` | 必须 |
| `update_source_missing` | 修复 | marker.template | `keep-local` / `replace` | `replace` 必须 |
| `incomplete` | 修复 | marker.template（可读）或重选 | `replace` | 必须 |

- `not_applied` 不提供 `append`/`keep-local`：已有通用 `frontend/index.md`/`backend/index.md`，append 无法让公司入口生效；`replace` 备份后整体替换，语义最清晰。
- `applied` 同模板更新才允许 `keep-local`；`replace`/`overwrite` 必须二次确认。
- `none` 只在首次初始化下拉中出现；生命周期对话框不提供 `none`（用户直接关闭即可）。
- 识别只用于 `not_applied` 的 `auto` 与状态卡提示；`applied`/`mismatch` 以 marker 为准，不重新猜测项目类型。

### 14.3 spec-only helper

路径：`trellis-kit/features/company-spec/apply.mjs`（随 kit 嵌入桌面端；需要 Node，运行时已有）。

参数：

```
--cli <path>          桌面端记录的 CLI 入口（@mindfoldhq/trellis/dist/cli/index.js 的路径）
--target <repo>       已批准关联的项目根目录
--registry <url>      feature.registry（可被 TRELLIS_COMPANY_SPEC_REGISTRY 覆盖）
--template <id>       已校验的模板 ID
--mode plan|apply
--strategy keep-local|overwrite|replace
--json                输出单行 JSON
```

依赖注入：

- `--cli` 指向 `@mindfoldhq/trellis` 的 `dist/cli/index.js`；helper 从 `dirname(cliPath)/../utils/` 绝对导入：
  `template-fetcher.js`（`parseRegistrySource`、`probeRegistryIndex`、`downloadTemplateById`、`fetchRegistrySpecTemplates`、`collectDirectoryFiles`）、
  `registry-config.js`（`loadSpecRegistryConfig`、`writeSpecRegistryConfig`）、
  `template-hash.js`（`computeHash`、`loadHashes`、`saveHashes`）。
- 读取 CLI 包 `package.json` 的 `version`，要求 `>=0.6.17`；导入失败/导出缺失 → `{ok:false, code:"helper_incompatible"}`，不写文件。
- 不使用 `shell: true`；所有参数通过 `spawn` 数组传递，模板 ID/路径先做校验。

`plan` 算法：

1. 校验 target 是目录，registry/template 非空，template 在 registry index 中存在（由 `downloadTemplateById` 负责）。
2. 下载模板到 `os.tmpdir()/company-spec-<pid>-<ts>/`（`downloadTemplateById` 的 skip 策略对空目录等价于复制）；读取模板根 `.trellis/spec`。
3. 读取目标 marker、`.trellis/config.yaml` registry.spec、`.template-hashes.json`。
4. 计算 `action`：
   - 无 marker → `apply`；
   - marker.template == template → `update`；
   - 否则 → `replace`。
5. 对模板每个文件（POSIX 相对 `.trellis/spec` 的路径）：
   - 目标不存在、hash 无记录 → `add`；
   - 目标不存在、hash 有记录 → `keep_deleted`（用户删过，`keep-local` 不复活；`overwrite`/`replace` 复活）；
   - 内容相同 → `keep`；
   - 内容不同、hash 与当前内容匹配 → `update`；
   - 内容不同、hash 不匹配/无记录 → `conflict`（`keep-local` 保留；`overwrite` 覆盖）。
6. 对旧 hash 中不在新模板的文件：
   - 目标不存在 → 删除 hash；
   - 内容与 hash 匹配 → `delete`（`keep-local`/`overwrite` 删除）；
   - 内容不匹配 → `keep_deleted`（保留本地修改）。
7. 输出 plan；`requiresBackup = action == "replace" || strategy == "overwrite" || files.conflict.length > 0`（实际备份由 apply 决定；`keep-local` 有冲突时不备份，因为不覆盖）。
8. 临时目录在 plan 结束删除；不写目标仓库。

`apply` 算法：

1. 重新执行 plan（避免 plan/apply 之间项目变化）。
2. 若 `action == "replace"` 或 `strategy == "overwrite"`：复制 `.trellis/spec` 到 `.trellis/.runtime/company-spec-backups/<timestamp>/spec`；复制失败 → `backup_failed`，中止。
3. 写入：
   - `apply`/`replace`：清空 `.trellis/spec`（已在备份中），写入模板全部文件；
   - `update` + `keep-local`：写 `add`/`update`，保留 `keep`/`conflict`/`keep_deleted`；
   - `update` + `overwrite`：写模板全部文件，覆盖 `conflict`；`keep_deleted` 是否复活由策略决定（overwrite 复活）。
4. 写 `.trellis/spec/.company-spec.json`（模板自带；不要改写内容）。
5. 更新 `.template-hashes.json`：
   - 写入的文件 → 模板内容哈希；
   - 保留的冲突/用户文件 → 保留旧哈希或保持缺失；
   - 删除的文件 → 删除条目。
6. `writeSpecRegistryConfig(target, {source: registry, template})`；失败 → warning，但 spec 已写入，状态会显示 `update_source_missing`。
7. 写 `.trellis/.runtime/company-spec-state.json`：`{schema:1, action, template, version, appliedAt, backupPath}`。
8. 返回 `{ok:true, applied:true, action, template, version, backupPath, written, kept, deleted}`。

失败码：`registry_unreachable`、`auth_failed`、`template_not_found`、`template_invalid`（缺 marker/入口）、`target_invalid`、`marker_invalid`、`backup_failed`、`write_failed`、`helper_incompatible`。所有错误输出 `{ok:false, code, message}`；message 不含 token/URL userinfo。

### 14.4 与上游哈希/更新兼容

- `.template-hashes.json` schema v2，键为 POSIX 路径，内容先 CRLF→LF 再 SHA-256（`template-hash.js:22-33`）。
- 首次 `trellis init` 在 `useRemoteTemplate` 时已把 spec 文件写入哈希（`init.js:1516-1524`）；helper 更新时沿用同一格式。
- `trellis update` 的 `collectRegistrySpecTemplates`（`update.js:486-532`）会读取 `registry.spec` 并按 `analyzeChanges` 的 hash 规则合并；helper 保留冲突文件的旧哈希，会让 `trellis update` 将其识别为 modified，符合预期。
- 不调用 `trellis update --force`：它会覆盖所有变更文件，不只是 spec。
- helper 不修改 `.trellis/config.yaml` 的其他字段；`writeSpecRegistryConfig` 只维护 `registry.spec`。

### 14.5 Rust 命令、关联校验与权限

新模块：`packages/desktop/src-tauri/src/agent/company_spec/lifecycle.rs`（与 `company_spec.rs` 同目录；`company_spec.rs` 通过 `mod lifecycle;` 暴露），或独立 `agent/company_spec_lifecycle.rs`；按文件行数选择，超过 800 行拆子模块。

命令：

```rust
#[tauri::command]
pub async fn inspect_company_spec(
    app: AppHandle,
    repo_path: String,
) -> Result<CompanySpecStatusEnvelope, String>;

#[tauri::command]
pub async fn plan_company_spec(
    app: AppHandle,
    repo_path: String,
    selection: Option<String>,
) -> Result<CompanySpecPlanEnvelope, String>;

#[tauri::command]
pub async fn apply_company_spec(
    app: AppHandle,
    repo_path: String,
    selection: Option<String>,
    strategy: String,
) -> Result<CompanySpecApplyEnvelope, String>;
```

- `repo_path` 必须是已批准本地关联的根目录：复用 `agent_service` 的本地关联查询（与 `inspect_associated_project_agents` 相同的校验路径）；未关联返回 `该路径未关联当前 Board`。
- `inspect` 不运行 helper、不联网；`plan`/`apply` 运行 helper：
  `Command::new(runtime.node_exe).arg(helper_path).args([...]).current_dir(repo_path)`；120s 超时；stdout 解析单行 JSON；stderr 截断记录，不写凭据。
- `strategy` 校验：`keep-local` 只允许 `update`；`replace` 只允许 `apply`/`replace`/`incomplete` 修复；`overwrite` 只允许 `update`。非法组合返回错误，不运行 helper。
- 返回信封：`{ ok: true, status }` / `{ ok: true, plan }` / `{ ok: true, result }`；helper 失败返回 `Err(json!({...}).to_string())` 或结构化错误，沿用现有命令错误风格。实现前按 `.trellis/spec/backend/desktop-agent-runtime.md` 确认错误信封；不要新增与现有命令不一致的格式。
- 权限：
  - `permissions/desktop.toml` 新增 `allow-inspect-company-spec`、`allow-plan-company-spec`、`allow-apply-company-spec`，每个 `commands.allow` 对应命令；
  - `capabilities/board-local-association.json` 的 `permissions` 数组加入三个 identifier；
  - `capabilities/main.json` 不加（生命周期入口只从远程 Board 页面调用；本地登录页不需要）。
- 命令只接受字符串路径，不接受模板内容/任意文件路径；模板 ID 由 Rust 校验属于 feature.templates。

### 14.6 Web：项目级入口与对话框

入口：

- `ProjectEntry.tsx` 增加一个图标按钮（`BookOpenCheck`，`aria-label="公司开发规范"`），仅 `activeAssociation?.status === 'approved'` 时渲染；点击调用 `onCompanySpec(activeAssociation.projectPath)`。
- `ProjectRail.tsx` 持有 `companySpecRepoPath` state，渲染 `<CompanySpecDialog open={...} repoPath={...} invoke={invoke} onOpenChange={...} />`；同一时间只有一个对话框。
- 不放到 `ProjectManagerDialog`（路径管理）和全局设置页；不新增路由。

`CompanySpecDialog.tsx`（`packages/web/src/features/board/dialogs/`）：

状态：
- `status: CompanySpecStatus | null`、`loading`、`busy`、`error`、`plan`、`strategy`、`selection`、`result`。
- 打开时 `inspect`；`status === null` → 显示“当前客户端未启用公司规范能力”，只有关闭按钮。

状态卡：
- 模板名/ID、版本、生成日期、入口文件列表；
- `not_applied`：“未套用公司开发规范”；
- `applied`：“已套用 <template> <version>”；
- `template_mismatch`：“当前 <template>，与所选/期望 <expected> 不同”；
- `update_source_missing`：“缺少更新来源 registry.spec，可修复”；
- `incomplete`：“公司规范不完整（marker/入口缺失），可修复”。

动作：
- `not_applied`：模板下拉（`auto` + 模板列表，默认 `auto`）→ “检查并预览” → plan；确认按钮“套用并备份”。
- `applied`：按钮“检查更新” → plan（selection=marker.template）；无差异显示“已是最新”；有差异显示预览与策略。
- `template_mismatch`：模板下拉（默认当前期望）→ “预览更换” → plan；确认“更换并备份”。
- `incomplete` / `update_source_missing`：按钮“修复” → plan（selection=marker.template 或选择）→ 确认。

Plan 预览：
- 计数徽标：新增 / 更新 / 保留 / 冲突 / 删除 / 保留删除；
- 折叠文件列表（路径 + 状态）；
- `conflict` 用 amber 提示“默认保留本地修改”；
- 策略单选：
  - `keep-local`（仅 `update`，默认）：“保留本地修改，更新其余文件”；
  - `overwrite`（仅 `update`）：“覆盖所有模板文件（先备份）”；
  - `replace`（`apply`/`replace`）：“整体替换现有 spec（先备份）”，不显示为可选（由状态决定）。
- 确认按钮按状态/策略变化；`replace`/`overwrite` 前弹二次确认（可用现有 dialog/modal 组件，不新增依赖）。

结果：
- 成功：显示“已套用/更新 <template> <version>”，备份路径（可复制）；
- 失败：`warning` tone，显示 code + message；不显示 token/URL userinfo；
- 完成后重新 `inspect`，状态卡刷新。

复用：
- `normalizeCompanySpecAvailability` 可复用模板/检测归一化；新增 `normalizeCompanySpecStatus` / `normalizeCompanySpecPlan` 纯函数，放 `packages/web/src/lib/company-spec.js`，便于 Node 单测。
- 反馈样式复用 `ProjectOnboardingDialog` 的 warning/error tone（Tailwind amber/red）。
- `busy` 时禁用所有动作按钮，避免并发 plan/apply。

### 14.7 生命周期失败与安全

| 条件 | 行为 |
| --- | --- |
| feature 不可用 / `TRELLIS_COMPANY_SPEC_ENABLED=0` | `inspect` 返回 `status=null`；入口按钮不显示（前端根据 `status` 判断） |
| 项目未批准关联 | 命令返回错误；不读取/写入路径 |
| 模板 ID 不在 feature.templates | 命令拒绝；不运行 helper |
| registry 不可达/认证失败 | plan 失败，目标文件不变；warning 提示检查网络/Git 凭据 |
| 模板缺 marker/入口 | plan 失败 `template_invalid`；不写目标 |
| marker 损坏 | `incomplete`；修复需 replace |
| 备份失败 | apply 中止；目标文件不变 |
| 写入失败（磁盘/权限） | 已写文件可能部分存在；返回 `write_failed`，备份路径可用于恢复；下次 inspect 显示 `incomplete` |
| helper 不兼容 | `helper_incompatible`；提示升级 Trellis CLI/桌面端，不写文件 |
| 并发操作 | UI 禁用；Rust 对同一 repo 的写操作加锁/拒绝并发，第二个请求返回“操作进行中” |

安全：
- 错误信息只包含模板 ID、状态码、可读原因；不包含 PAT、URL userinfo、完整 Git 命令。
- helper 不执行 shell；路径参数必须是绝对路径且位于已关联仓库内；模板 ID 用白名单校验。
- 备份目录 `.trellis/.runtime` 已在 `.gitignore`；不把备份复制到 `spec/`。

### 14.8 测试

见 §10.6；补充：
- `inspect` 状态机五态各一个 fixture；
- `plan` 的 add/update/keep/conflict/delete/keepDeleted 组合；
- `apply` 三策略的写入/保留/删除/哈希断言；
- 未关联路径、非法 selection、非法 strategy 的命令级拒绝；
- 权限文件注册后调用成功，未注册时失败；
- 备份失败注入（只读目录/磁盘错误模拟）不写目标。

## 15. 确认记录

- registry 落点：已创建 `prod-mdp/weint-dev-specs`（project id `1262`，2026-11-25 22:42，默认分支 `main`，README 初始提交），使用 `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`；两段路径，独立仓库，SSH `git ls-remote` 已验证。已验证 `devops/weint-spec-board` 是 Trellis Board 产品仓库，根目录无 `index.json`/`specs/`，不能直接作为 registry；HTTP URL 会被 CLI 重建为 HTTPS，而该主机 HTTPS 404，必须用 SSH。原计划 `devops/weint-dev-specs` 因当前账号无创建权限（`devops` 组要求 Maintainer）未创建，改用 `prod-mdp` 组（`project_creation_level=developer`）后创建成功。`prod-mdp` 是验证落点，后续迁移到中性组；迁移策略见 §4.1。Phase 7 提交 `index.json`/`specs/`。详见 `research/registry-verification.md`。
- monorepo：按建议——MVP 只支持单仓，monorepo 跳过并提示，不使用 `--no-monorepo` 根级 spec。
- React/Node 适配内容：按建议——首批交付最小适配版；评审人待团队指定。
- `enabledByDefault` 首批默认值：按建议——`false`，灰度后再评估。
- feature 关闭时保留 Trellis 原生空白 spec：按建议——保留，不改上游。
- 项目级入口：按建议——`ProjectEntry` 图标按钮（`BookOpenCheck`）。
- 备份保留：按建议——本期永久保留，后续加清理。
- 同模板更新默认 `keep-local`：按建议——不默认覆盖。
- 本期不做“停用/删除公司规范”：按建议——删除通过 Git 或手工操作。
- helper 直接 import CLI 内部 ESM 导出：按建议——接受，并以 `helper_incompatible` 兜底。
