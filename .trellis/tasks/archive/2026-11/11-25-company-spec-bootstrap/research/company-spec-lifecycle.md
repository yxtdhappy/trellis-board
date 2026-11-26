# 公司规范生命周期调研：首次套用、补套、更新与标记

## 1. 要解决的问题

用户（m00864）提出：公司规范初始化是否只发生在项目第一次初始化？如何判断“第一次”？能否在 `.trellis` 里放一个标识文件，只要记录为“未初始化过规范文件”，就随时可以选择套用；即使已经套过，也能覆盖更新？

结论：**不能把“项目第一次初始化”当作“公司规范第一次套用”的判定**。项目初始化和公司规范套用是两个状态机，必须拆开。公司规范用 `.trellis/spec/.company-spec.json` 作为“已套用”标记；缺失即未套用。已有项目的补套/更新需要独立入口，不能重跑 `trellis init`。

## 2. 项目初始化状态（现有代码）

`packages/desktop/src-tauri/src/agent/onboarding.rs:182-194`：

```rust
if !has_trellis || !has_tasks {
    InitializationMode::FullInit
} else if tools_missing {
    InitializationMode::AgentsOnly
} else {
    InitializationMode::None
}
```

- FullInit 的条件是“没有 `.trellis` 或没有 tasks”，不是严格的“第一次初始化”。
- 修复、重新初始化、只建了 `.trellis` 但没有 tasks 的项目都会命中 FullInit。
- 项目初始化完成后，`inspect` 返回 `requiresInitialization=false`，初始化弹窗不再出现，当前设计没有机会再套规范。

## 3. `trellis init` 重跑的行为

`node_modules/@mindfoldhq/trellis/dist/commands/init.js`：

- `:628` 注释：`.trellis/` 已存在时进入 re-init 处理；返回 true 表示已处理，返回 false 表示用户选择 full re-initialize。
- `:661` 交互选项包含 `{ name: "Full re-initialize", value: "full" }`。
- `:748` 记录 init 前 `.developer` 是否存在。
- `:816` 注释 “Don't overwrite if packages: already exists (re-init case)”。
- `:870` `if (options.force)`；`:880` 注释 “preserve user files — explicit --force is required to overwrite.”
- `:915` `const hasTemplateRequest = !!options.template || !!options.registry;`
- `:917-924` 只有 `!options.force && ... && !hasTemplateRequest` 时才调用 `handleReinit(cwd, options, developerName, pythonCmd)`；`reinitDone === false` 表示用户选择 full re-initialize 后继续。

**推断（不是事实）**：带 `--template/--registry` 会绕过 re-init 保护，直接在已有 `.trellis` 上继续初始化流程；`--skip-existing` 保护已有文件，但它不等于“只写 spec”，仍有改动 `.trellis` 其他结构/配置的风险。因此已有项目补套不能复用 `trellis init`。

## 4. `trellis update` 对 registry spec 的处理

`node_modules/@mindfoldhq/trellis/dist/commands/update.js`：

- `:596` `collectTemplateFiles` 把 `collectRegistrySpecTemplates(cwd)` 返回的文件合并进更新文件集合。
- `:478-480` 注释：`trellis update` 刷新 hash 跟踪的 spec 模板，并通过正常 update 冲突流程保留本地修改。
- `:486-532` `collectRegistrySpecTemplates`：
  - 读 `.trellis/config.yaml` 的 `registry.spec`；
  - `parseRegistrySource` → probe `index.json`；
  - 有 templates 时要求 `registry.spec.template`，按 ID 找到模板，`downloadTemplateById(..., "overwrite", ...)` 到临时目录，收集 `.trellis/spec/**`；
  - index 404 时 `fetchRegistrySpecTemplates` 直接下载；
  - 失败只 warning，返回空 Map。
- `update --help`：`--dry-run`、`-f/--force`（Overwrite all changed files without asking）、`-s/--skip-all`、`-n/--create-new`、`--allow-downgrade`、`--migrate`；没有 `--only-spec`。
- `analyzeChanges`（`:625-685`）：
  - target 不存在且无 hash → new；
  - target 不存在但有 hash → user deleted（保留删除）；
  - 内容相同 → unchanged；
  - 内容不同且有 hash 且 hash 匹配 → auto-update；
  - 内容不同且 hash 不匹配/无 hash → changed（需确认）。
- `--force` 会覆盖所有变更文件，不只是 spec；桌面端不能直接用它做“只更新公司规范”。

**结论**：`trellis update` 适合“同模板更新并保留本地修改”的语义，但它会更新整个 Trellis 模板集，且没有 spec-only 开关。需要一条独立的 spec-only 路径，或者只借用它的下载/哈希规则。

## 5. 模板哈希契约

- `.trellis/.template-hashes.json` schema v2：`{ "__version": 2, "hashes": { "<posix-path>": "<sha256>" } }`（`dist/utils/template-hash.js:22-33`）。
- 哈希对内容做 CRLF → LF 归一化后再 SHA-256；键必须是 POSIX 路径。
- `trellis init` 在 `useRemoteTemplate` 时会把 `.trellis/spec/**` 全部写入哈希（`init.js:1516-1524`）；因此通过 registry 套用的公司 spec 会被 `trellis update` 当作模板文件跟踪。
- 本仓库当前 `.template-hashes.json` 没有 `.trellis/spec/**` 条目，说明它的 spec 不是通过 remote template 写入的；不能假设所有项目的 spec 都有哈希。
- 自定义 helper 写 spec 时必须同步维护哈希：
  - 写入模板文件 → 记录模板内容哈希；
  - 保留本地修改 → 保留旧哈希（或保持缺失），让后续 update 识别为冲突；
  - 删除模板文件 → 删除哈希条目。

## 6. 可复用的 CLI 内部能力

`dist/utils/template-fetcher.js` 导出：

- `parseRegistrySource`
- `probeRegistryIndex`
- `downloadTemplateById`
- `fetchRegistrySpecTemplates`
- `collectDirectoryFiles`

`dist/utils/registry-config.js` 导出：

- `loadSpecRegistryConfig`
- `writeSpecRegistryConfig`

`dist/utils/template-hash.js` 导出：

- `computeHash`
- `loadHashes`
- `saveHashes`

这些是 npm 包内的 ESM 导出，桌面端 helper 可以通过绝对路径 `import(pathToFileURL(...))` 使用；CLI 版本固定 0.6.17，桌面端环境门已要求 ≥0.6.17。若未来升级 CLI 导致导出变化，helper 必须返回 `helper_incompatible`，而不是静默写坏文件。

## 7. 方案决策

### 7.1 状态判定

| 状态 | 判定 |
| --- | --- |
| `not_applied` | `.trellis/spec/.company-spec.json` 不存在 |
| `applied` | marker 存在，`template` 与请求/feature 期望一致，入口 index 存在，`.trellis/config.yaml` 有 `registry.spec` |
| `template_mismatch` | marker 存在，但 `template` 与当前选择/期望不同 |
| `update_source_missing` | marker 存在，但 config 缺 `registry.spec`（无法自动更新） |
| `incomplete` | marker 存在但 JSON 不可解析，或入口 index 缺失 |

不新增 `.trellis/.company-spec-state.json` 作为“是否套用”的唯一真相；marker 是共享、随模板更新的内容标记。可选地在 `.trellis/.runtime/` 写本地操作记录（时间、备份路径），但不作为套用判定依据。

### 7.2 入口与时机

- 新项目：FullInit 时下拉选择，沿用现有 R4。
- 已有项目：项目级“公司规范”入口（ProjectEntry 图标 → `CompanySpecDialog`），随时可打开；不自动弹窗、不在每次启动联网。
- 已套用：显示状态；用户点“检查更新”才下载模板并计算 plan。
- 更新不自动执行；必须展示 diff/冲突并确认。

### 7.3 三种写操作

| 操作 | 触发 | 默认策略 |
| --- | --- | --- |
| `apply` | 无 marker | `replace`：备份 `.trellis/spec` 后整体替换（通用 spec 的 `index.md` 会冲突，append 不可用） |
| `update` | marker 同模板 | `keep-local`：未修改文件覆盖，本地修改保留，新增文件补齐，模板删除且未修改的文件删除 |
| `replace` | marker 不同模板 | 备份后整体替换；旧模板文件不残留 |

- 覆盖类操作必须先备份到 `.trellis/.runtime/company-spec-backups/<timestamp>/spec`（`.runtime` 已被 gitignore）。
- 不提供“只 append”：已有项目通常已有通用 `frontend/index.md`/`backend/index.md`，append 会让公司模板入口永远不生效。

### 7.4 spec-only helper

新增 `trellis-kit/features/company-spec/apply.mjs`，由桌面端用 Node 调用：

```
node apply.mjs --cli <cli_path> --target <repo> --registry <url> --template <id> \
  --mode plan|apply --strategy keep-local|overwrite|replace --json
```

- `plan`：下载模板到临时目录，读 marker/hashes，输出 `{action, current, target, files:{add,update,keep,conflict,delete,keepDeleted}, requiresBackup, warnings}`，不写目标仓库。
- `apply`：重新计算 plan 并写入；写 `registry.spec`（`writeSpecRegistryConfig`）、更新 `.template-hashes.json`、写本地操作记录；返回 `{applied, action, template, version, backupPath, written, kept, deleted, warning}`。
- 不调用 `trellis init`，不调用 `trellis update -f`；只复用 `template-fetcher`/`registry-config`/`template-hash` 的导出。
- 失败分类：registry 不可达、认证失败、模板不存在、marker 缺失/非法、helper 不兼容、备份失败、写入失败。
- 日志不输出 PAT、URL userinfo 或完整凭据。

### 7.5 与 `trellis update` 的兼容

- helper 写入后，`.trellis/config.yaml` 有 `registry.spec`，`.template-hashes.json` 有 spec 哈希；后续 `trellis update` 可以按既有冲突流程刷新。
- 保留本地修改的文件不更新哈希，`trellis update` 会将其视为 modified，符合预期。
- 备份目录在 `.trellis/.runtime` 下，不进入哈希，也不会被 update 清理。

## 8. 确认结果

- 项目级入口：`ProjectEntry` 图标按钮（`BookOpenCheck`），不放在 `ProjectManagerDialog` 行内。
- 停用/移除公司规范：本期不做，只做套用/更新/更换；删除通过 Git 或手工操作。
- 备份保留：本期永久保留，后续再加清理。
- 模板版本策略：模板内容变化必须升 `version`；“已是最新”以 plan 无差异（或 marker.version 与模板一致且无 add/update/delete）为准；具体在 Phase 2 固定并写测试。
