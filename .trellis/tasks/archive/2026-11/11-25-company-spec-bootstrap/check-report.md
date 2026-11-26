---
mode: inline-self-check
agent: main-session
session: claude_63b7b27a-a4dc-4f8f-91c9-c530915a8199
base: 737f1f8bb8d6dfb77aa90851c7266bddabbb8661
scope: docs/company-spec-bootstrap.md,packages/desktop/src-tauri/capabilities/board-local-association.json,packages/desktop/src-tauri/permissions/desktop.toml,packages/desktop/src-tauri/src/agent/branch_inspect.rs,packages/desktop/src-tauri/src/agent/company_spec.rs,packages/desktop/src-tauri/src/agent/company_spec/lifecycle.rs,packages/desktop/src-tauri/src/agent/company_spec/tests.rs,packages/desktop/src-tauri/src/agent/mod.rs,packages/desktop/src-tauri/src/agent/onboarding.rs,packages/desktop/src-tauri/src/agent/task_sync/tests/upload_cleanup.rs,packages/desktop/src-tauri/src/agent/trellis_cli.rs,packages/desktop/src-tauri/src/agent/trellis_cli/tests.rs,packages/desktop/src-tauri/src/agent_service.rs,packages/desktop/src-tauri/src/kit_assets.rs,packages/desktop/src-tauri/src/main.rs,packages/web/src/components/layout/ProjectRail.tsx,packages/web/src/components/layout/project-rail/ProjectEntry.tsx,packages/web/src/features/board/dialogs/CompanySpecDialog.tsx,packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx,packages/web/src/lib/company-spec.d.ts,packages/web/src/lib/company-spec.js,packages/web/src/lib/project-inspection.d.ts,packages/web/src/lib/project-inspection.js,scripts/test/company-spec.test.js,scripts/test/trellis-kit.test.js,trellis-kit/README.md,trellis-kit/apply.py,trellis-kit/features/company-spec/apply.mjs,trellis-kit/features/company-spec/feature.json,trellis-kit/manifest.json
diff: sha256:4bb2658074696834b4a07c3bac2f6d1b003d1dfe268b7205c148ce072392d57d
---
# Check 报告：初始化时按项目类型注入公司开发规范

- 代码提交：`44dd7ca`（最终功能修复）；功能提交 `51c55a0`、CI 修复 `f7d0d73`
- 发布提交：`5e41bd1`（`v0.5.12`）

## 已执行并通过的检查

- `yarn test --scope=core`：784 tests / 782 pass / 0 fail / 2 skipped。
- `yarn test --scope=core --file=company-spec`：8/8 pass；`--file=trellis-kit`：7/7 pass。
- `cd packages/web && npx tsc -b --noEmit`：通过。
- 本任务相关 Web/JS 文件 `oxfmt --check`：通过；`oxlint` 无 error，仅既有/新增 warning。
- 使用真实 registry `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git` 对临时 target 执行 helper：
  - `plan`：`action=apply`、8 个 add；
  - `apply --strategy replace`：写入 8 文件，marker/hashes/state 正确；
  - 二次 `plan`：`action=update`，全部 keep；
  - 修改本地 `frontend/index.md` 后 `plan` 报 conflict，`apply --strategy keep-local` 保留本地内容和旧哈希。
- 回归项目 `C:\Users\yuhaojie\Desktop\trellis-init-regression`：marker `wit-backend-java`、registry 配置、feature 记录、8 个 spec 哈希一致；helper plan 全部 keep。
- GitHub Actions `windows` run `45652078094`：node tests、Rust unit tests、bundle、portable smoke、launch smoke、Release assets 全部成功。

## 未本地执行 / 待验证

- `cargo fmt` / `cargo clippy` / `cargo test`：本机无 Rust 工具链，未执行；Rust 编译与单测由 CI 成功验证。
- 桌面端手工 E2E：未执行（无可运行 Tauri 构建）；CI launch smoke 通过。
- 全量 `yarn test --scope=lint`：被工作区中与本任务无关的未格式化文件阻断；本任务文件已单独检查通过。

## 检查覆盖范围

- 覆盖本任务的功能代码、Web 入口/对话框、kit feature/helper、registry 契约、文档与任务制品。
- 未覆盖其他并行任务的改动：工作区仍有 `task_store.py`、`task-check-binding.test.js`、`11-26-check-binding-normalize-eol` 等无关改动，未纳入本任务检查或提交。
- `branch_inspect.rs`/`main.rs` 的最终修复与 `11-25-project-rail-branch-rebind` 共享文件有关；本次只改 headless 编译依赖，未回退该任务的分支重绑逻辑。

## 风险

- registry 仓库当前落在临时组 `prod-mdp`，后续迁移到中性组时需要同步更新 `feature.json` 与已初始化项目的 `registry.spec.source`。
- `trellis update` 与 helper 共享 spec 哈希/config；后续若手工修改 spec，需按既有冲突流程处理，不能直接 `--force`。
- 现有 Trellis 原生空白 spec 在首次套用公司模板时会被替换；这是 `replace` 语义的设计行为，升级前需保留备份。