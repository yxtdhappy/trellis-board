# 修复公司开发规范弹窗 Select 回显与检查变更模块路径

## Goal

修复公司开发规范弹窗（及接入弹窗中的同源选择器）在展示、检查变更预览与错误提示时的缺陷，确保：

1. 模板选择器与更新策略选择器正确回显中文展示名称而非原始 ID / value；
2. 点击「检查变更」能够从已安装的 `@mindfoldhq/trellis` 包中正确加载 `dist/utils/*` 模块，并准确展示变更文件数量；
3. 长路径错误文案在弹窗内正常换行，不再出现横向滚动条截断。

## Confirmed Facts

- **Select 回显问题（`@base-ui/react/select`）**：
  - [select.tsx](packages/web/src/components/ui/select.tsx#L18-L26) 封装的是 `@base-ui/react/select`；当 `<SelectValue />` 无子节点且未提供 label 映射时，Base UI 默认渲染原始 `value` 字符串。
  - 项目内已有 [SelectField.tsx](packages/web/src/features/board/SelectField.tsx#L41-L43) 通过显式向 `<SelectValue>` 传入当前选项 `label` 解决该问题。
  - 当前共有三处直接使用了空的 `<SelectValue />`：
    - [CompanySpecDialog.tsx](packages/web/src/features/board/dialogs/CompanySpecDialog.tsx#L216-L247)（选择模板：`auto` / 模板 ID 如 `wit-frontend-mom3`）
    - [CompanySpecDialog.tsx](packages/web/src/features/board/dialogs/CompanySpecDialog.tsx#L291-L303)（更新策略：`keep-local` / `overwrite`）
    - [ProjectOnboardingDialog.tsx](packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx#L635-L667)（首次接入时的公司开发规范选择：`none` / `auto` / 模板 ID）
- **长错误文案横向溢出**：
  - [CompanySpecDialog.tsx](packages/web/src/features/board/dialogs/CompanySpecDialog.tsx#L327) 渲染错误信息的 `<p className="text-xs text-destructive">{error}</p>` 未设置强制断行样式，Windows 长模块路径会将弹窗撑出横向滚动条。
- **检查变更模块路径解析错误**：
  - [apply.mjs](trellis-kit/features/company-spec/apply.mjs#L80-L97) 中 `findPackageRoot(cliPath)` 已定位到 `@mindfoldhq/trellis` 包根目录 `packageRoot`，但第 91 行计算 `utilsDir` 时使用了 `path.join(path.dirname(path.resolve(cliPath)), '..', 'utils')`。
  - 桌面端实际传入的 `cliPath` 为 `<packageRoot>/bin/trellis.js`（参考 [agent_only_init.mjs](packages/desktop/src-tauri/src/agent/agent_only_init.mjs#L14-L20) 与 [agent_template_repair.mjs](packages/desktop/src-tauri/src/agent/agent_template_repair.mjs#L441-L449)），导致拼出不存在的 `<packageRoot>/utils/template-fetcher.js`，实际编译产物位于 `<packageRoot>/dist/utils/`。
  - [company-spec.test.js](scripts/test/company-spec.test.js#L132) 仅覆盖了 `dist/cli/index.js` 入口，未覆盖 `bin/trellis.js` 入口。
- **变更预览文件计数归零（联动缺陷）**：
  - [apply.mjs](trellis-kit/features/company-spec/apply.mjs#L231) 与 [lifecycle.rs](packages/desktop/src-tauri/src/agent/company_spec/lifecycle.rs#L58-L71) 返回的 `plan.files` 各字段为文件路径数组（`string[]`）。
  - [company-spec.js](packages/web/src/lib/company-spec.js#L70-L82) 的 `planFiles` 直接调用 `number(value.add)` 而未取数组长度（对比第 115 行 `normalizeCompanySpecApplyResult` 使用了 `number(raw.written?.length)`），会导致「检查变更」成功后所有分类计数均为 `0`，页面误显「没有文件变化。」。

## Requirements

### R1. 修复公司规范相关 Select 回显
- 在 [company-spec.js](packages/web/src/lib/company-spec.js) 提供纯函数辅助（或共享 label 解析函数），根据选中值与模板列表解析展示文案：
  - `'auto'` → `'自动识别（推荐）'`
  - `'none'` → `'不套用'`
  - 已在 `templates` 中的模板 ID → 对应 `template.label`（如 `'前端 MOM3'`）
  - 未知模板 ID → 回退展示原 ID 字符串
  - 更新策略：`'keep-local'` → `'保留本地修改（推荐）'`，`'overwrite'` → `'覆盖冲突文件'`，未知值回退原字符串
- 在以下三处 `<SelectValue>` 中显式渲染解析后的友好标签：
  1. [CompanySpecDialog.tsx](packages/web/src/features/board/dialogs/CompanySpecDialog.tsx#L226)（选择模板）
  2. [CompanySpecDialog.tsx](packages/web/src/features/board/dialogs/CompanySpecDialog.tsx#L297)（更新策略）
  3. [ProjectOnboardingDialog.tsx](packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx#L645)（接入弹窗的公司开发规范选择）

### R2. 修复公司开发规范弹窗错误文案换行
- [CompanySpecDialog.tsx](packages/web/src/features/board/dialogs/CompanySpecDialog.tsx#L327) 错误提示文本支持长路径/无空格字符串自动换行（如 `break-words [overflow-wrap:anywhere]` 或 `break-all`），避免弹窗内容区出现横向滚动条截断。

### R3. 修复 `apply.mjs` 加载 Trellis CLI `dist/utils` 模块路径
- 修改 [apply.mjs](trellis-kit/features/company-spec/apply.mjs#L80-L97)：基于 `findPackageRoot(cliPath)` 得到的 `packageRoot` 优先解析 `path.join(packageRoot, 'dist', 'utils')`，同时兼容既有 `path.join(path.dirname(path.resolve(cliPath)), '..', 'utils')` 兜底。
- 在 [company-spec.test.js](scripts/test/company-spec.test.js) 新增用例覆盖 `bin/trellis.js` 作为 `--cli` 入口的 `plan` / `apply` 流程。

### R4. 修复 `normalizeCompanySpecPlan` 文件计数解析
- 修改 [company-spec.js](packages/web/src/lib/company-spec.js#L70-L82) 的 `planFiles`，当各字段为数组时取 `.length`，同时兼容直接传入数字；并补充单元测试（`packages/web/test/company-spec.test.js`）覆盖 `planFiles` 与 Select 标签解析辅助函数。

## Out of Scope

- 不改动服务端 API（本任务仅涉及前端 `packages/web` 与桌面端内嵌 `trellis-kit` helper，无后端 API 变更；Phase 2.2.1 API E2E 记为 not applicable）。
- 不改动 `Select` 基础组件（[select.tsx](packages/web/src/components/ui/select.tsx)）对 `@base-ui/react/select` 的全局封装语义。
- 不改动桌面端 Rust 侧 `company_spec` 业务逻辑或 `trellis_cli` 路径探测机制。
- 不修改公司规范模板清单、自动识别规则或远程 registry 协议。

## Acceptance Criteria

- [ ] 打开「公司开发规范」弹窗，默认选中 `auto` 时下拉框回显「自动识别（推荐）」，切换为任意模板（如 `wit-frontend-mom3`）时回显对应中文标签（如「前端 MOM3」）。
- [ ] 当「检查变更」返回 `action === 'update'` 时，「更新策略」下拉框回显「保留本地修改（推荐）」/「覆盖冲突文件」，而非 `keep-local` / `overwrite`。
- [ ] 在「接入本地 Git 项目」弹窗中，「公司开发规范」下拉框正确回显「不套用」「自动识别（推荐）」及各模板中文标签。
- [ ] 「公司开发规范」弹窗中的长路径错误提示自动换行，不触发弹窗内容区横向滚动条。
- [ ] `trellis-kit/features/company-spec/apply.mjs` 接收 `<packageRoot>/bin/trellis.js` 与 `<packageRoot>/dist/cli/index.js` 两种 `--cli` 路径时，均可正确加载 `dist/utils/{template-fetcher,registry-config,template-hash}.js` 并完成 `plan` / `apply`。
- [ ] `normalizeCompanySpecPlan` 面对 `plan.files.*` 为文件路径数组时正确统计各分类数量（不再归零），并兼容数字输入。
- [ ] 相关单元测试（`scripts/test/company-spec.test.js`、`scripts/test/trellis-kit.test.js`、`packages/web/test/company-spec.test.js`）及前端 lint / typecheck / build 全部通过。
