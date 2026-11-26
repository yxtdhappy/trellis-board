# 实施报告：初始化时按项目类型注入公司开发规范

## 结果

已按 PRD/design/implement 完成公司开发规范能力，并发布 `v0.5.12`：

- `trellis-kit` 新增可选 `company-spec` feature，记录在 `.trellis/.kit-version.features`；
- 首次 `trellis init` 可按项目类型选择模板，并向 CLI 追加 `--registry/--template/--append`；
- 已有项目可通过项目栏“公司开发规范”入口补套、检查更新、保留本地修改、换模板或整体替换；
- 新增 spec-only helper，复用 Trellis CLI 0.6.17 的 registry/哈希能力，不重跑 `trellis init`，也不使用 `trellis update --force`；
- 独立 registry 仓库 `prod-mdp/weint-dev-specs` 已提供 9 个模板、`index.json`、组合脚本与来源说明；
- GitHub Actions `windows` 工作流 `45652078094` 全部通过并发布 Release。

## 主要改动

### trellis-kit

- `trellis-kit/features/company-spec/feature.json`（新增）：feature 契约、registry 地址、9 个模板映射。
- `trellis-kit/features/company-spec/apply.mjs`（新增）：spec-only plan/apply，支持 `keep-local`、`overwrite`、`replace`，维护 marker、`.template-hashes.json`、`.trellis/config.yaml` 与备份。
- `trellis-kit/apply.py`：新增 `--feature`，校验 descriptor，跳过 feature 文件复制，写 `.kit-version.features`；无 `--feature` 时保留已有值。
- `trellis-kit/manifest.json`：版本升至 `0.4.0`，新增 `company-spec` feature 组件。
- `trellis-kit/README.md`：补充 feature 用法。

### 桌面端（Rust/Tauri）

- `packages/desktop/src-tauri/src/agent/company_spec.rs`（新增）：feature 读取、项目类型识别、模板选择、初始化结果校验、可用性返回。
- `packages/desktop/src-tauri/src/agent/company_spec/lifecycle.rs`（新增）：状态、plan、apply、helper 调用、同仓库写锁、错误映射。
- `packages/desktop/src-tauri/src/agent/company_spec/tests.rs`（新增）：识别、选择、marker、feature 读取等单测。
- `trellis_cli.rs`：`init_args` 支持追加 registry/template/append，并透传 FullInit。
- `onboarding.rs`：增加 `CompanySpecRequest/Outcome`，首次初始化按选择调用 CLI、校验 marker、只在校验通过后记录 feature。
- `agent_service.rs`：`inspect_project` 返回 `companySpec`；初始化接收 `companySpecSelection`；新增生命周期三命令并校验已批准关联。
- `main.rs`、`permissions/desktop.toml`、`capabilities/board-local-association.json`：注册并授权 `inspect/plan/apply_company_spec`。
- `branch_inspect.rs`：解除 headless `trellis-agent` 对 `agent_service` 的依赖，修复发布构建。

### Web

- `ProjectOnboardingDialog.tsx`：首次初始化增加“公司开发规范”下拉（自动识别/具体模板/不套用）、检测提示与结果 warning。
- `CompanySpecDialog.tsx`：项目级生命周期对话框，支持状态卡、plan 预览、策略选择、备份路径和错误展示。
- `ProjectEntry.tsx` / `ProjectRail.tsx`：已批准关联项目显示“公司开发规范”入口。
- `project-inspection.js/.d.ts`、`company-spec.js/.d.ts`：响应归一化与类型。

### registry 与文档

- 独立仓库 `D:\git_workspace\weint-dev-specs`：`index.json`、`bundles/`、`specs/`、`scripts/build-templates.mjs`、`scripts/sync-wiki.mjs`。
- 推送提交：`3a2239f`、`cedbb42`。
- 文档：`docs/company-spec-bootstrap.md`。

## 与计划的偏差

1. 首次初始化仍复用 `trellis init --registry/--template/--append`；已有项目改用 spec-only helper，避免 `trellis init` 的 re-init 绕过风险。
2. 为修复 CI 发布阻断，额外修正 `upload_cleanup` 测试的环境依赖，以及 `branch_inspect` 被 headless bin 编译时的依赖问题。
3. 生命周期默认策略为 `keep-local`；`replace`/`overwrite` 必须显式选择并先备份。

## 本地与 CI 验证

| 检查 | 结果 |
| --- | --- |
| `yarn test --scope=core` | 784 tests / 782 pass / 0 fail / 2 skipped |
| `yarn test --scope=core --file=company-spec` | 8/8 pass |
| `yarn test --scope=core --file=trellis-kit` | 7/7 pass |
| `cd packages/web && npx tsc -b --noEmit` | 通过 |
| 本任务 Web 文件 `oxfmt --check` | 通过 |
| 真实 registry helper plan/apply | 通过；二次 plan 全部 keep，本地修改可保留 |
| GitHub Actions `windows` run `45652078094` | 成功；Node tests、Rust unit tests、bundle、portable smoke、Release 全通过 |

## 未本地验证

- 本机无 Rust 工具链，未运行 `cargo fmt/clippy/test`；Rust 编译与单测由 CI 成功验证。
- 未运行桌面端手工 E2E；CI 的 launch smoke test 通过。
- 全量 `yarn test --scope=lint` 仍被工作区中与本任务无关的未格式化文件阻断；本任务文件已单独通过。
