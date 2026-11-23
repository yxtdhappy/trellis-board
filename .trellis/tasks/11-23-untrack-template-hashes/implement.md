# 实现步骤

> 约束：按步骤一次性改完，中途不编译；全部完成后只跑一次 `cargo test` 与 `node --test`。

## 1. `onboarding.rs`：gitignore 小节

- 新增 `TEMPLATE_HASHES_PATH`、`TEMPLATE_HASHES_RULE`、`LOCAL_STATE_TITLE` 三个常量。
- 抽出 `append_gitignore_rules(repo_path, section_title, rules: &[&str])`，保留去重/换行/无变化不写盘语义。
- `ensure_agent_gitignore` 改为两次调用：agent 小节 + local state 小节；去掉顶部 `rules.is_empty()` 早退。
- 新增 `ensure_template_hashes_ignored(repo_path)` 供提交路径使用。

验证：`onboarding/tests.rs` 的 4 个既有 gitignore 断言更新为新内容；新增“无 agent 工具”“等价规则去重”两条用例。

## 2. `git.rs` / `git/write.rs`：新增白名单操作

- `GitOperation` 增加 `LsFiles`、`RmCached`；同步 `ALL` 数组长度与 `git_args` 分支。
- `git.rs`：`is_tracked(repo, hooks, path) -> AgentResult<bool>`（exit 0/1/其它）。
- `git/write.rs`：`untrack_path(repo, hooks, path)`，失败分类给出可操作提示。
- `git.rs` 顶部 `pub use write::{...}` 补 `untrack_path`。

验证：新增端到端用例 `untracks_manifest_before_initial_commit`（已跟踪 → 索引移除、工作区保留、`git status` 无残留）；`git/tests.rs` 的缺路径用例补 `LsFiles`/`RmCached`。

## 3. `onboarding.rs`：初始化提交

- `commit_and_push_initial` 在 `add_paths` 前调用 `ensure_template_hashes_ignored(&root)` 与条件脱管。

验证：重跑既有 `commit_and_push_initial` 相关测试确认无回归（若测试夹具中的 manifest 未跟踪，脱管分支应静默跳过）。

## 4. spec

- `.trellis/spec/backend/desktop-agent-runtime.md` 增加契约：`.template-hashes.json` 属本机状态，初始化必须写忽略规则并在初始化提交中脱管；未来做 Trellis 升级功能时顺序必须是 init → update。

验证：文档改动与代码行为逐条对照。

## 5. 收尾（一次）

- `cargo test -p trellis-board`（`packages/desktop/src-tauri`）。
- `node --test "packages/desktop/test/*.test.js"`。
- 手工验证：在临时仓库走一次初始化提交，确认远端 `.trellis/` 不含 `.template-hashes.json`、本机文件存在。
- 提示用户：本仓库自身需执行一次 `git rm --cached .trellis/.template-hashes.json`。

## 验证结果

- `node --test "packages/desktop/test/*.test.js"`：37 项，36 通过、1 项按平台跳过、0 失败。
- `cargo test -p trellis-board`：**未执行**。本机没有 Rust 工具链（`cargo` 不在 PATH，`~/.cargo`、`~/.rustup`、WSL 均不存在），
  需要在装有 Rust 的环境补跑这一条；Rust 用例尚待首次运行确认。