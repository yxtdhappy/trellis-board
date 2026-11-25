# 执行计划

> 顺序：先做可独立验证的 kit feature 与 spec-only helper，再做 Rust/Web 接线，最后做 registry 内容与端到端。
> 每个阶段先给验证方式，再进入下一阶段。未通过 PRD 评审前不执行任何代码改动。

## 0. 前置确认（阻塞项）

- [x] 验证 GitLab 地址（2026-11-25）：`devops/weint-spec-board` 存在、私有、默认分支 `main`、两段路径；SSH `ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git` 已用当前 key 验证 `git ls-remote` 成功。但它是 Trellis Board 产品仓库，根目录无 `index.json`/`specs/`；HTTP URL 会被 CLI 重建成 HTTPS，而 HTTPS 返回 404。详见 `research/registry-verification.md`。
- [x] registry 落点：已创建 `prod-mdp/weint-dev-specs`（project id `1262`，2026-11-25 22:42，默认分支 `main`，README 初始提交），使用 SSH URL `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`；两段路径，独立仓库。
- [x] 仓库可访问性：`git ls-remote` 返回 `refs/heads/main`（`fe7db2d7065cae426e73dcb8c5ffd49c6774231d`），SSH 端口 `1022` 验证通过；Trellis CLI `probeRegistryIndex` 返回 `{"templates":[],"isNotFound":true,"backend":"git"}`，确认 CLI 可 clone、仅缺 `index.json`。原计划 `devops/weint-dev-specs` 因当前账号无创建权限未创建；`prod-mdp` 组 `project_creation_level=developer`，创建成功。`index.json` 内容在 Phase 7 提交。
- [x] monorepo：按建议——MVP 只支持单仓，monorepo 跳过并提示，不使用 `--no-monorepo` 根级 spec。
- [ ] React/Node 首批范围已按建议定为最小适配版（`frontend-react`、`backend-node`）；评审人待团队指定。
- [x] `enabledByDefault` 首批值：按建议 `false`（灰度期默认“不套用”，仍可手动选择）。
- [x] “feature 关闭时保留 Trellis 原生空白 spec 骨架”：按建议保留，不改上游。
- [x] 项目级入口形态：按建议 `ProjectEntry` 图标按钮（`BookOpenCheck`）。
- [x] 同模板更新默认策略：按建议 `keep-local`，覆盖需二次确认。
- [x] 备份保留策略：按建议本期永久保留，后续加清理。
- [x] helper 直接 import CLI 0.6.17 内部 ESM 导出：按建议接受，以 `helper_incompatible` 兜底。

验证：以上每一项有明确结论并记录到本文件或 PRD §9；未确认项不得进入对应阶段。

## 1. Trellis-kit feature

### 1.1 文件

- [ ] 新建 `trellis-kit/features/company-spec/feature.json`（字段见 design §3.1）；registry 先填确认后的地址，未确认时用占位并在 PRD §9 标注。
- [ ] `trellis-kit/manifest.json`：
  - 版本 `0.3.4` → `0.4.0`；
  - 增加 `kind: "feature"` 组件，`id: "company-spec"`，`descriptor: "features/company-spec/feature.json"`。
- [ ] `trellis-kit/README.md` 增加 feature 说明（启用方式、`--feature`、默认值、回滚）。

### 1.2 apply.py

- [ ] 增加 `--feature <id>`（repeatable）；校验 feature 存在、descriptor 可解析、`id` 一致。
- [ ] `--agent-only --feature` 非零退出。
- [ ] 组件复制循环跳过 `kind == "feature"`。
- [ ] `.trellis/.kit-version` 增加 `features`：
  - 无 `--feature` 保留已有值；
  - 有 `--feature` 取并集；
  - `--dry-run` 只打印。
- [ ] 不传 `--feature` 时复制/冲突行为与现在逐字节等价。

### 1.3 嵌入与测试

- [ ] `kit_assets.rs` 的 `embedded_kit_has_apply_and_manifest` 增加 `features/company-spec/feature.json` 断言。
- [ ] `scripts/test/trellis-kit.test.js` 增加 design §3.4 的 5 个用例。
- [ ] 验证：`yarn test --scope=core --file=trellis-kit` 全绿。

## 2. spec-only helper（生命周期核心）

### 2.1 文件与依赖

- [ ] 新建 `trellis-kit/features/company-spec/apply.mjs`（design §14.3）。
- [ ] 新建 `scripts/test/company-spec.test.js`；由 `scripts/test.mjs` 的 `core` scope 自动发现（实现前确认文件发现规则）。
- [ ] helper 从 `--cli` 推导 `../utils/{template-fetcher,registry-config,template-hash}.js`，绝对路径 import；读取 CLI `package.json` 版本，要求 `>=0.6.17`。
- [ ] 所有子进程参数用数组传递，`shell: false`；模板 ID/路径先校验。

### 2.2 plan

- [ ] 下载模板到临时目录，读取目标 marker、`registry.spec`、`.template-hashes.json`。
- [ ] 计算 `action`：无 marker → `apply`；同模板 → `update`；不同 → `replace`。
- [ ] 生成 `files { add, update, keep, conflict, delete, keepDeleted }` 与 `requiresBackup`；不写目标仓库。
- [ ] 临时目录在结束时清理（成功/失败都清理）。

### 2.3 apply

- [ ] `replace`/`overwrite` 前备份 `.trellis/spec` 到 `.trellis/.runtime/company-spec-backups/<timestamp>/spec`；失败中止。
- [ ] `apply`/`replace`：清空并写入模板全部文件；`update+keep-local`：只写 add/update，保留 conflict/keepDeleted；`update+overwrite`：覆盖模板文件。
- [ ] 写 `.template-hashes.json`：写入→模板哈希；保留→旧哈希/缺失；删除→删条目；键为 POSIX 路径。
- [ ] `writeSpecRegistryConfig` 写 `registry.spec`；失败返回 warning，不掩盖 spec 已写入。
- [ ] 写 `.trellis/.runtime/company-spec-state.json`（最近动作/模板/版本/备份路径）。
- [ ] 返回 `{ ok, applied, action, template, version, backupPath, written, kept, deleted, warning }`。
- [ ] 失败码覆盖 design §14.3；message 脱敏。

### 2.4 验证

- [ ] `yarn test --scope=core --file=company-spec` 全绿。
- [ ] 单测覆盖：apply 冲突、update 无差异、keep-local 保留、overwrite 覆盖、delete/keepDeleted、换模板、备份失败、helper 不兼容、哈希断言。
- [ ] 手工用本地临时 Git registry 跑 `plan`/`apply`，检查备份与 config/hashes。

## 3. Rust：首次初始化（feature、识别、传参、校验）

> 实现前按需读 `.trellis/spec/backend/desktop-agent-runtime.md` §1–2（初始化契约、返回结构、超时）与 `.trellis/spec/desktop/tauri-commands/index.md` 的初始化场景。这两个文件约 38KB，超过 32KB 注入上限，未放进 `implement.jsonl`；关键结论已提炼进 design.md。

### 3.1 模块

- [ ] 新建 `packages/desktop/src-tauri/src/agent/company_spec.rs`，实现 design §6.1 的 `load_feature`、`availability`、`config`、`detect`、`select_template`、`verify` 与类型。
- [ ] 新建 `company_spec/tests.rs`，覆盖 design §10.2。
- [ ] `agent/mod.rs` 注册模块。

### 3.2 CLI 接线

- [ ] `trellis_cli.rs`：`init_args` 增加 `Option<&CompanySpecInit>`；`initialize_trellis` / `initialize_with_repair` / `run_init_process` 透传；仅 `InitMode::Full` 使用。
- [ ] 参数断言：无 selection 时参数与现在完全一致；有 selection 时末尾为 `--registry <url> --template <id> --append`。

### 3.3 onboarding 接线

- [ ] `InitializeOptions` 增加 `company_spec: Option<CompanySpecRequest>`。
- [ ] `initialize_project` 返回 `InitializeProjectResult { project, company_spec }`。
- [ ] FullInit：detect → select → init → verify；`Skipped`/verify 失败构造 warning outcome。
- [ ] `apply_kit_overlay` 增加 `features: &[String]`；仅 verify 通过时传 `["company-spec"]`。
- [ ] `Skipped` 的 reason 转换为用户可读中文 warning，不包含本机绝对路径。
- [ ] 现有测试与 `agent_service.rs` 的构造点同步更新。

### 3.4 服务层与返回

- [ ] `agent_service::inspect_project` 返回追加 `companySpec`（`Option<CompanySpecAvailability>`）。
- [ ] `agent_service::initialize_project` 增加 `company_spec_selection: Option<String>`；从 `trellis_kit_root` 读 feature，调用 `parse_choice` 解析 `auto` / `none` / 模板 ID，构造 `CompanySpecRequest`。
- [ ] `inspect_project` 的 `companySpec` 包含 `templates` 与 `detected`（`availability(kit_root, repo_path)`）。
- [ ] 返回 `{ ok, project, companySpec }`；`companySpec` 为 `Option`，序列化 camelCase。
- [ ] `main.rs` 的 `initialize_pending_project` 增加 `company_spec_selection: Option<String>`；`initialize_associated_project_agents` 不传。
- [ ] 首次初始化不新增 command/capability/permission；生命周期命令在 Phase 4 添加。

### 3.5 验证

- [ ] `cargo fmt --check`（CI 或本机有工具链时）。
- [ ] `cargo clippy --all-targets -- -D warnings`（CI）。
- [ ] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（CI；本机无 Rust 工具链，不能声称本地通过）。
- [ ] 静态检查：`rg -n "unwrap\\(\\)|expect\\(" packages/desktop/src-tauri/src/agent/company_spec.rs` 无输出（测试除外）。
- [ ] 文件行数：`company_spec.rs` ≤ 1200 行（含测试）；超过则拆 `company_spec/` 子模块。

## 4. Rust：生命周期状态、命令与权限

### 4.1 模块与状态

- [ ] 新建 `packages/desktop/src-tauri/src/agent/company_spec/lifecycle.rs`（或 `company_spec_lifecycle.rs`，按行数选择），实现 design §14.1/§14.5。
- [ ] `status(repo_path)`：离线读 feature/marker/config/入口/本地操作记录；五态判定；不联网。
- [ ] `run_helper(mode, selection, strategy)`：校验参数 → `Command::new(runtime.node_exe)` 运行 `apply.mjs` → 120s 超时 → 解析单行 JSON；stderr 截断。
- [ ] `strategy` 与 `action` 组合校验（design §14.2）；非法组合不运行 helper。

### 4.2 命令

- [ ] `inspect_company_spec(repo_path)` → `{ ok, status }`；feature 不可用返回 `status=null`。
- [ ] `plan_company_spec(repo_path, selection)` → `{ ok, plan }`。
- [ ] `apply_company_spec(repo_path, selection, strategy)` → `{ ok, result }`。
- [ ] 三个命令都校验 `repo_path` 属于已批准本地关联（复用现有 association 查询）；未关联拒绝。
- [ ] 同一仓库写操作串行化/拒绝并发（design §14.7）。

### 4.3 权限

- [ ] `packages/desktop/src-tauri/permissions/desktop.toml` 增加：
  - `allow-inspect-company-spec`
  - `allow-plan-company-spec`
  - `allow-apply-company-spec`
- [ ] `packages/desktop/src-tauri/capabilities/board-local-association.json` 加入三个 identifier。
- [ ] `capabilities/main.json` 不加；本地登录页不调用。

### 4.4 测试

- [ ] `company_spec/lifecycle_tests.rs` 覆盖 design §10.6：五态、非法 selection/strategy、未关联路径、并发、错误脱敏。
- [ ] 命令级集成：临时目录 + 本地 registry；`inspect` → `plan` → `apply` → `inspect` 状态迁移。
- [ ] 权限回归：未注册时调用失败；注册后已批准关联可调用。

### 4.5 验证

- [ ] CI：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`。
- [ ] 静态检查无 `unwrap/expect/panic!`（测试除外）；文件行数 ≤ 1200。

## 5. Web：首次初始化选项与反馈

- [ ] `packages/web/src/lib/project-inspection.js` 增加 `normalizeCompanySpecAvailability`（design §7）。
- [ ] `ProjectOnboardingDialog.tsx`：
  - inspect 回调保存 `value.companySpec`；
  - state：`companySpec`、`companySpecSelection`（默认 `enabledByDefault ? 'auto' : 'none'`）；
  - “公司开发规范”下拉，仅 `available && requiresInitialization`；
  - 固定项 `auto` / `none`，模板项按 group 用 `<optgroup>` 分组；
  - 提示：`detected.template` 存在时“检测到 X，将套用 Y”，否则显示 `detected.warning` 或“未识别到唯一模板，可手动选择”；
  - `initialize()` 增加 `companySpecSelection`；
  - `feedback` tone 增加 `warning`，样式复用 Tailwind amber；
  - 成功/警告文案（design §7）。
- [ ] `AgentQuickInitDialog.tsx` 不读取 `companySpec`。
- [ ] 回归：`normalizeProjectInspection` 对 `{ok, project, companySpec}` 仍返回 project。
- [ ] 手工覆盖：applied / warning / 选择 `none` / 手动选择模板 / feature 不可用。

### 验证

- [ ] `yarn test --scope=lint` 通过（oxfmt/oxlint/tsc）。
- [ ] 手工：mock `inspect_local_project` 与 `initialize_pending_project` 返回值，确认下拉默认值、分组选项和五种反馈。

## 6. Web：生命周期入口与对话框

### 6.1 归一化

- [ ] 新建 `packages/web/src/lib/company-spec.js`：`normalizeCompanySpecStatus`、`normalizeCompanySpecPlan`、`normalizeCompanySpecApplyResult`；纯函数，容错未知字段。
- [ ] Node 断言：用 `node --input-type=module` 或现有测试入口覆盖 null/非法/正常输入。

### 6.2 对话框

- [ ] 新建 `packages/web/src/features/board/dialogs/CompanySpecDialog.tsx`（design §14.6）。
- [ ] 状态：`status`/`loading`/`busy`/`error`/`plan`/`strategy`/`selection`/`result`。
- [ ] 状态卡五态；动作按钮；plan 预览（计数 + 文件列表）；策略选择；二次确认；结果与备份路径。
- [ ] `busy` 时禁用按钮；关闭后不保留旧 plan。
- [ ] 复用现有 dialog、button、badge 组件；不新增依赖。

### 6.3 入口

- [ ] `ProjectEntry.tsx` 增加“公司开发规范”图标按钮（`BookOpenCheck`），仅 `activeAssociation?.status === 'approved'` 显示。
- [ ] `ProjectRail.tsx` 持有 `companySpecRepoPath` 并渲染 `CompanySpecDialog`。
- [ ] 不放进 `ProjectManagerDialog` / 全局设置页。

### 6.4 验证

- [ ] `yarn test --scope=lint` 通过。
- [ ] 手工覆盖五态、plan 预览、三种策略、取消确认、失败 warning、备份路径展示。
- [ ] 未批准关联不显示入口；未关联路径命令调用被拒。

## 7. Registry 与模板（独立仓库）

> 工作目录：`D:\git_workspace\weint-dev-specs`（与 trellis-board 平级）。远端为 `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`；`prod-mdp` 是当前验证落点，后续迁移到中性组（迁移策略见 design §4.1）。该目录是独立的 Git 仓库，不提交到 trellis-board；trellis-board 只保留桌面端接线与文档。

### 7.1 仓库骨架

- [x] 已创建 GitLab `prod-mdp` 组下的 `weint-dev-specs`（project id `1262`，默认分支 `main`，README 初始提交，SSH 已验证）。
- [ ] `index.json`（schema 见 design §4.2）。
- [ ] `specs/` 下至少一个模板：`wit-frontend-vue2`。
- [ ] `bundles/`：`common/`、`frontend-vue2/`、`frontend-mom3/`、`backend-java/`、`frontend-react/`、`backend-node/`。
- [ ] `scripts/sync-wiki.mjs`：按固定 pageId 清单导出；PAT 从环境变量读取，不落盘。
- [ ] `scripts/build-templates.mjs`：组合 bundles → `specs/*`，生成 `index.md`、`quality-guidelines.md`、`.company-spec.json`；支持 `--check`。
- [ ] `README.md`：维护流程、模板 ID 表、发布步骤、权限要求。

### 7.2 内容映射

- [ ] `common`：交付规范（6062284）、错误提示消息设计规范（87729359）、分支管理（7766045）中可复用部分。
- [ ] `frontend-vue2`：前端代码编写通用规范（28444179）、前端技术栈选型（131355439）、按钮权限/Icon/国际化等按需拆分到 `references/`。
- [ ] `frontend-mom3`：MOM3 子应用开发规范（43164694），保留版本锁定、目录结构、路由/CRUD 约定。
- [ ] `backend-java`：后端服务开发规范（7766573）按主题拆分到 `references/`，`index.md` 做入口与阅读顺序。
- [ ] `frontend-react` / `backend-node`：基于公司通用条款编写 React/Node 适配版；不直接复制 Vue/Java 条款。
- [ ] 每个模板的 `.company-spec.json` 写入 pageId/版本/导出日期。

### 7.3 验证

- [ ] `node scripts/build-templates.mjs --check` 通过。
- [ ] 本地起一个临时 Git 仓库作为 registry，执行：
  `trellis init -y --skip-existing -u tester -t wit-frontend-vue2 -r <本地 registry 路径> --append`
  断言 `.trellis/spec/.company-spec.json`、`frontend/index.md` 存在，`.trellis/config.yaml` 含 `registry.spec`。
- [ ] 用一个不存在的模板 ID 验证 CLI 回退空白 spec、退出码 0（确认必须靠 marker 校验）。

## 8. 端到端与失败场景

### 8.1 首次初始化

- [ ] fixture 1：Vue 2 + ant-design-vue 单仓 → `wit-frontend-vue2`，`frontend/index.md` 存在。
- [ ] fixture 2：Java/Spring 单仓 → `wit-backend-java`，`backend/index.md` 存在。
- [ ] fixture 3：React + Node 单仓（不要用本仓库，本仓库是 workspace monorepo）→ `wit-fullstack-react-node`，前后端入口均存在。
- [ ] feature 关闭 fixture：下拉选 `none` → 不传模板，`.kit-version` 无 feature，空白 spec 保留。
- [ ] 手动选择 fixture：自动识别为 unknown/冲突，下拉手动选 `wit-frontend-vue2` → 套用成功，结果保留识别证据。
- [ ] 非法选择 fixture：请求不在 `feature.templates` 中的模板 ID → 不传模板，warning，初始化成功。
- [ ] feature 不可用 fixture：临时移走 `feature.json` → 无下拉，初始化与旧版一致。
- [ ] 失败场景：registry 不可达、模板 ID 不存在、私有仓库无凭据、模板缺 marker、marker template 不匹配、入口缺失。
- [ ] monorepo fixture：不传模板，原 monorepo 行为不变。
- [ ] AgentsOnly fixture：不尝试模板，无下拉/提示。

### 8.2 生命周期

- [ ] 已初始化但无 marker 的项目：`inspect` 为 `not_applied`；打开对话框无网络请求。
- [ ] 补套：选择模板 → plan 冲突列出通用 spec → apply(replace) → marker/config/hash/备份齐全。
- [ ] 同模板无差异：plan `action=none`；不写文件。
- [ ] 同模板有本地修改：`keep-local` 保留修改，未修改文件更新，新文件补齐，删除未修改文件；`overwrite` 覆盖并备份。
- [ ] 换模板：`replace` 后旧文件不残留，marker.template 更新，备份可恢复。
- [ ] 状态修复：`incomplete`、`update_source_missing` 分别走修复路径。
- [ ] 失败：registry 不可达、认证失败、模板缺 marker、备份失败、写入失败；目标文件不变/备份可恢复。
- [ ] 并发：同一项目连续点击 plan/apply，第二个请求被拒绝或串行，不产生交叉写入。
- [ ] 权限：未关联路径被拒；未注册权限时调用失败。
- [ ] `trellis update`：在已套用模板的项目执行，确认能按 `.trellis/config.yaml` 的 `registry.spec` 刷新，且 marker 不被误判为本地修改；helper 保留的冲突文件被识别为 modified。

### 验证

- [ ] 每个 fixture 记录：命令、退出码、`companySpec`/`status`/`plan`、`.trellis/config.yaml` 片段、marker 内容、`.kit-version.features`、备份路径。
- [ ] 失败场景记录 warning 文案，确认不含凭据/绝对路径。

## 9. 文档与发布

- [ ] registry `README.md`：模板 ID、内容来源、构建/发布、权限、评审流程。
- [ ] trellis-board 文档：kit feature 开关（`enabledByDefault`、`--feature`、env 覆盖）、项目级入口、更新/备份/回滚；说明 monorepo/MVP 限制。
- [ ] 发布顺序：registry 先发布 → kit 带 feature（可先 `enabledByDefault=false`）→ 开发构建验证 → 正式构建 → 灰度 → 默认开启。
- [ ] 回滚演练：
  - `enabledByDefault=false` 或移除 feature 文件后重新初始化，行为与旧版一致；
  - 已初始化项目 spec 不被删除；
  - 从 `.trellis/.runtime/company-spec-backups/<timestamp>/spec` 恢复一次，确认可回滚。

## 10. 提交与验收

- [ ] 工作提交包含代码、测试、文档与 `.trellis/tasks/11-25-company-spec-bootstrap/`（PRD/design/implement/research/jsonl）。
- [ ] 验收标准逐条对照 PRD §8.1/§8.2，记录证据（命令输出摘要、marker 片段、plan 预览、UI 截图/文案、备份路径）。
- [ ] 未通过项明确标注，不以“能工作”代替验收。

## 验证命令速查

```bash
# kit / helper Node 测试（仓库根）
yarn test --scope=core
yarn test --scope=core --file=trellis-kit
yarn test --scope=core --file=company-spec

# Web 检查
yarn test --scope=lint

# Rust（CI 或本机有工具链时）
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml

# registry 仓库
node scripts/build-templates.mjs --check
```

## 回滚点

- Phase 1 后：不传 `--feature` 时 kit 行为与旧版等价；移除 feature 文件即可关闭。
- Phase 2 后：helper 独立可测；桌面端未接线时无行为变化。
- Phase 3 后：`company_spec` 为 `None` 时初始化路径与旧版等价。
- Phase 4 后：生命周期命令只在 feature 可用时返回 status；未注册权限时调用失败，不影响旧功能。
- Phase 5/6 后：Web 只在收到 `companySpec`/`status` 时展示，旧桌面端不返回这些字段时无行为变化。
- Phase 7 后：registry 可独立回滚，不影响桌面端。
- 发布后：`enabledByDefault=false` 让新项目默认不套用（仍可手动选择），或 `TRELLIS_COMPANY_SPEC_ENABLED=0` 立即关闭首次下拉与项目入口；已初始化项目不受影响；覆盖操作可用备份恢复。
