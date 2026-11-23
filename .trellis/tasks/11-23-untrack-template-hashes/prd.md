# 初始化时忽略并脱管 .trellis/.template-hashes.json

## Goal

看板初始化时把 `.trellis/.template-hashes.json` 写进项目根 `.gitignore`，并让“已被 Git 跟踪的 manifest”在看板自己的初始化提交里脱管（`git rm --cached`）。目标是：manifest 只描述本机磁盘状态，不再随仓库跨机器共享，从根上消除“A 机器提交的平台键在 B 机器上指向不存在的文件”这一类问题。

## 背景（证据见 `research/manifest-vs-gitignore.md`）

- 根 `.gitignore` 由看板写入，忽略 `.claude/`、`.codex/`、`.opencode/` 等 22 个平台目录（`packages/desktop/src-tauri/src/agent/onboarding.rs:321-371`，路径表 `trellis_cli.rs` 的 `AGENT_TOOLS`）。
- `.trellis/.template-hashes.json` 却被上游设计为入库文件：它记录“哪些文件是本版本模板写入的”（`template-hash.js`），`getConfiguredPlatforms`（`configurators/index.js:103-133`）只读它、不看磁盘。
- 后果：clone 出的仓库里 manifest 记录了本机不存在的平台文件。`trellis update` 会把这些条目归入 `userDeletedFiles`（`commands/update.js:643-648`），**永不补回**，只打印 `Deleted by you (preserved)`（`update.js:770-775`）。
- 看板现有两条初始化路径不触发上游 `handleReinit` 的跳过逻辑（FullInit 固定 `--skip-existing`、AgentsOnly 直连 `configurePlatform`），所以当前不会“初始化被跳过”；问题只在 manifest 与磁盘的偏差本身。
- 若改为“初始化后清理 manifest 中缺失的键并提交”，会把 B 机器的缺失状态写进共享文件，导致 A 机器上已存在的平台文件失去 hash 基线、升级时被判为“用户修改”，且键无法自动补回。故采用本方案。

## Requirements

- R1 初始化流程在写根 `.gitignore` 时，固定追加 `/.trellis/.template-hashes.json`；规则写入独立的小节标题 `# Trellis local state (local only)`，与 agent 目录小节并列。
- R2 规则写入对所有初始化模式生效（FullInit / AgentsOnly / None），并与现有 agent 规则共用同一套去重、换行风格保持、无变化不写盘的逻辑。
- R3 初始化提交（`commit_and_push_initial`）在暂存前，若 manifest 已被 Git 跟踪，则执行 `git rm --cached` 使其脱管；工作区文件必须保留。
- R4 脱管只做一次且幂等：未跟踪时直接跳过，不报错、不触碰索引。
- R5 脱管失败（例如索引里已有冲突的暂存内容）不得提交出“仍跟踪 manifest”的初始化提交，需返回可操作的错误信息（与现有 `.gitignore` 写入失败的报错风格一致）。
- R6 不改上游模板、不改 `.trellis/.gitignore`（该文件由 `trellis update` 整份重写，见 `update.js:562`），不引入新依赖。

## Acceptance Criteria

- [ ] 单测：空项目执行 `ensure_agent_gitignore`，根 `.gitignore` 同时包含 agent 小节与 `# Trellis local state (local only)` + `/.trellis/.template-hashes.json`。
- [ ] 单测：已存在等价规则（`.trellis/.template-hashes.json` 无前导 `/`）时不重复追加。
- [ ] 单测：无 agent 规则（空工具列表）时仍写入 manifest 忽略规则。
- [ ] 单测：已跟踪的 manifest 经初始化提交后 `git ls-files` 不再列出该文件，磁盘文件仍存在。
- [ ] 单测：未跟踪的 manifest 不产生索引改动（`git status --porcelain` 不含该路径）。
- [ ] 单测：`.gitignore` 为 CRLF 时新增规则沿用 CRLF。
- [ ] `cargo test -p trellis-board`（desktop）与既有 `packages/desktop/test/*.test.js` 全绿。
- [ ] 手工验证：新初始化项目提交后，远端 `.trellis/` 中不含 `.template-hashes.json`；本机文件仍在。

## Non-goals

- 不在初始化后改写 manifest 内容（不清理缺失键、不改 hash 值）。
- 不自动处理“已关联但本次未走初始化提交”的仓库——这类仓库需要用户或后续任务执行一次 `git rm --cached`，本任务只在 `research/` 与 spec 中记录操作方式。
- 不实现 `trellis update` 的临时 manifest 方案（未来做升级功能时另立任务，本任务只需在 spec 记录“先 init 再 update”的顺序约束）。
- 不改前端 UI，不新增 Tauri 命令，不改 `ProjectInspection` 结构。

## Notes

- 实现落点：`packages/desktop/src-tauri/src/agent/onboarding.rs`（gitignore 小节、`commit_and_push_initial`）、`packages/desktop/src-tauri/src/agent/git.rs` 与 `git/write.rs`（新增 `ls-files` / `rm --cached` 白名单操作）。
- 测试落点：`packages/desktop/src-tauri/src/agent/onboarding/tests.rs`（现有 4 个 gitignore 测试需同步更新断言）。
- spec 落点：`.trellis/spec/backend/desktop-agent-runtime.md` 补“manifest 属本机状态、不入库”的契约。
- 已确认的脱管范围：只对看板自己的初始化提交（`commit_and_push_initial`）生效；已关联的老项目不自动改索引，由用户手动执行一次 `git rm --cached`。
- 本仓库（trellis-board 自身）的 manifest 已被跟踪，实施后需手动执行一次 `git rm --cached .trellis/.template-hashes.json`，由用户决定是否随本次任务提交。