# 研究：.template-hashes.json 与平台目录 gitignore 的冲突

结论：`.template-hashes.json` 是**机器状态缓存**，上游把它当 lockfile 提交的前提是平台文件也入库。看板把平台目录全部 gitignore 后，这个前提失效；正确做法是让 manifest 同样不入库，并在初始化时写入忽略规则、在初始化提交中脱管。

## 1. 上游 Trellis 0.6.17 的行为（`node_modules/@mindfoldhq/trellis/dist`）

| 事实 | 位置 |
|---|---|
| manifest 由 init 写入，记录模板路径 → 内容 hash | `commands/init.js:730`、`commands/init.js:1515` |
| 平台是否“已配置”只读 manifest，不看磁盘 | `configurators/index.js:103-133`（`getConfiguredPlatforms`） |
| 重跑 init 时按上述结果跳过整个平台 | `commands/init.js:710-712`（`already configured, skipping`） |
| `--skip-existing` 直接绕过重跑判定 | `commands/init.js:916-920` |
| `update` 只收集“已配置平台”的模板 | `commands/update.js:575-585` |
| 有 storedHash 但文件不存在 → `userDeletedFiles`，注释 “respect deletion” | `commands/update.js:643-648` |
| 上述文件只打印 `Deleted by you (preserved)`，无恢复入口 | `commands/update.js:770-775` |
| 无 storedHash 且内容不同 → `changedFiles`（人工确认） | `commands/update.js:663-680` |
| 无 manifest 时 `uninstall` 直接失败退出 | `commands/uninstall.js:126-135` |
| `.trellis/.gitignore` 会被 update 整份重写 | `commands/update.js:562` |

## 2. 看板的行为（`packages/desktop/src-tauri/src/agent/`）

- 根 `.gitignore` 由 `ensure_agent_gitignore`（`onboarding.rs:321-371`）写入，规则来自 `trellis_cli.rs` 的 22 个工具表；本仓库 `.gitignore` 第 33 行 `/.claude/`、第 75 行 `/.codex` 即由它写入。
- FullInit 固定 `init -y --skip-existing -u <dev> <flags>`（`trellis_cli.rs:251-262`）；AgentsOnly 直接调 `configurePlatform`（`agent_only_init.mjs:49-64`）。两条路径都不经过上游的“已配置跳过”判定，因此**当前不存在“B 初始化被跳过”**。
- 初始化提交只暂存固定路径（`onboarding.rs:28` 的 `INITIAL_COMMIT_PATHS`，含 `.trellis`），因此未忽略的 manifest 会被提交。

## 3. 实测复现（临时目录，forge 伪造 manifest）

- 构造 v2 格式 manifest、伪造成 54 个 codex 键、仓库只留 `.trellis/tasks/00-bootstrap-guidelines`。
- 带 `--skip-existing`：`Configuring Codex`，`.codex/{agents,config.toml,hooks,hooks.json,skills}` 全部生成。
- 不带：`Codex ... already configured, skipping`，`.codex` 不生成。
- 结论：跳过判定确实存在，但看板两条路径都不会触发；真正的隐患是 manifest 与磁盘的偏差被 `update` 解释成“用户删除”。

## 4. 方案取舍

| 方案 | 做法 | 否决/采纳理由 |
|---|---|---|
| A 只记录 | 文档说明风险 | 不解决偏差，任何 `trellis update` 都会踩 |
| B 初始化后清理缺失键 | 删除“有 hash 但磁盘不存在”的条目并提交 | 把 B 机器的缺失状态写进共享文件；A 机器上已存在的文件失去基线、升级时被判“用户修改”，键无法自动补回（`file-writer.js:104-108` 内容相同不记录） |
| C 不忽略平台目录 | 让 `.claude/` 等入库 | 改变现有产品行为，冲突面最大 |
| **D 本机化（采纳）** | manifest 加入根 `.gitignore`，初始化提交中 `git rm --cached` | 每台机器的 manifest 只描述自己的磁盘，跨机漂移/冲突/误判一起消失；代价是裸克隆上 `uninstall` 不可用、`update` 前必须先 init |

## 5. 缺 manifest 时的退化（已知并接受）

| 行为 | 影响 |
|---|---|
| `trellis uninstall` | 直接失败（`uninstall.js:126-135`）；先 init 或手删 `.trellis/` |
| `trellis update` 平台文件 | 平台集合为空 → 平台文件不升级；升级功能必须先 init |
| `trellis update` 工作流文件 | 无基线 → 内容不同即提示“你改过”，只增加确认成本 |
| `safe-file-delete` | 缺 hash 安全网 → 不执行，废弃文件残留 |
| legacy Codex 迁移 | `needsCodexUpgrade` 读 manifest → 不触发 |

## 6. 本仓库现状数据

- manifest 188 键：平台键 155（`.agents` 46、`.claude` 52、`.codex` 8、`.omp` 49）+ `.trellis/` 32 + `AGENTS.md`；文件 192 行、一键一行。
- 盘上与 manifest 一致：`.trellis/workflow.md`、`.trellis/scripts/task.py`、`.claude/settings.json`、`AGENTS.md`；不一致：`.codex/config.toml`（Codex CLI 自行改写）。

## 7. 关键代码位置（实现参考）

- gitignore 写入：`onboarding.rs:321-371`；提交链路：`onboarding.rs:556-590`。
- Git 白名单：`git.rs:40-61`（枚举）、`git.rs:63-89`（`ALL`）、`git.rs:144`（`git_args`）、`git/write.rs:13-95`（写操作）。
- 测试：`onboarding/tests.rs:377-440`（gitignore 断言）、`onboarding/tests.rs:520-540`（git 断言辅助）。