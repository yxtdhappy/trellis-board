# 设计：初始化时忽略并脱管 .template-hashes.json

## 1. 现状链路

```
initialize_project (onboarding.rs:381)
  ├─ trellis_cli::initialize_trellis / initialize_agents   ← 写 .trellis 与平台目录
  ├─ ensure_agent_gitignore(root, selected_tools)          ← 写根 .gitignore（onboarding.rs:414）
  └─ inspect_project(...)                                  ← 返回状态

commit_and_push_initial (onboarding.rs:556)
  ├─ initial_commit_paths(root)                            ← [.trellis, .gitignore, AGENTS.md, .gitattributes, .agents]
  ├─ git::add_paths → has_staged_changes → commit_paths
  └─ git::push_branch → check_initial_push_with
```

`ensure_agent_gitignore`（`onboarding.rs:321-371`）当前只在 `rules` 非空时工作：读文件 → 按 `normalize_gitignore_rule` 去重 → 保持 CRLF/LF → 无新增不写盘。

## 2. 变更一：gitignore 规则

新增常量（`onboarding.rs` 顶部，靠近 `GITIGNORE_TITLE`）：

```rust
const TEMPLATE_HASHES_PATH: &str = ".trellis/.template-hashes.json";
const TEMPLATE_HASHES_RULE: &str = "/.trellis/.template-hashes.json";
const LOCAL_STATE_TITLE: &str = "# Trellis local state (local only)";
```

把现有函数体拆成可复用的 `append_gitignore_rules(repo_path, section_title, rules: &[&str])`，保留原有语义（去重、换行风格、无新增不写盘、UTF-8 校验、错误码 `GIT_FAILED`）。

- `ensure_agent_gitignore(repo_path, tools)`：先按现有 `GITIGNORE_TITLE` 追加 agent 规则（为空则跳过该小节），再按 `LOCAL_STATE_TITLE` 追加 `TEMPLATE_HASHES_RULE`。
- `ensure_template_hashes_ignored(repo_path)`：只追加 `LOCAL_STATE_TITLE` 小节，供提交路径复用。

选择独立小节而不是并入 agent 小节：agent 小节标题明确写的是 “agent configs”，把 manifest 塞进去会让标题失真；独立小节也避免旧仓库出现标题迁移。

## 3. 变更二：Git 白名单操作

`GitOperation`（`git.rs:40-61`）新增两项，并同步 `ALL`（`git.rs:63-89`，当前 20 项）与 `git_args`（`git.rs:144`）：

| 操作 | 命令 | 说明 |
|---|---|---|
| `LsFiles` | `git ls-files --error-unmatch -- <path>` | exit 0 = 已跟踪，1 = 未跟踪，其余报错 |
| `RmCached` | `git rm --cached --quiet -- <path>` | 只改索引，保留工作区文件 |

`git.rs` 新增读侧封装 `pub async fn is_tracked(repo, hooks, path) -> AgentResult<bool>`；`git/write.rs` 新增写侧 `pub async fn untrack_path(repo, hooks, path) -> AgentResult<()>`（走 `run_write` + `git_failure`，与 `add_paths` 同构）。

`RmCached` 失败分类：stderr 含 `has staged content different` / `is not tracked` 时给出“请先处理该文件的暂存内容，或手动执行 `git rm --cached <path>`”的可操作提示；其它情况走通用 `git_failure`。`--quiet` + `--cached` 保证不删工作区文件、不输出无关噪音。

## 4. 变更三：初始化提交顺序

`commit_and_push_initial` 在 `git::add_paths` 之前插入两步：

```rust
ensure_template_hashes_ignored(&root).await?;          // 先保证忽略规则存在
if git::is_tracked(&root, hooks_dir, TEMPLATE_HASHES_PATH).await? {
    git::untrack_path(&root, hooks_dir, TEMPLATE_HASHES_PATH).await?;   // 再脱管
}
```

顺序理由：

1. 忽略规则先落地 → 即使脱管失败，后续 `add_paths` 也不会把“未跟踪的 manifest”新增进提交。
2. 脱管失败时直接返回错误、中止提交 → 不会产出“远端仍跟踪 manifest”的初始化提交（R5）。
3. 文件已跟踪且用户没有暂存冲突时，删除操作随 `commit_paths` 一并提交，远端 manifest 被移除，本机文件保留。

`commit_and_push_initial` 可能被重试（初始化后用户再次点“提交并推送”），两步都幂等：规则已存在不写盘，未跟踪直接跳过。

## 5. 边界

- FullInit / AgentsOnly / None 三种模式都会经过 `ensure_agent_gitignore`，规则必然写入。
- 已关联、不走初始化提交的仓库不受影响：不自动改索引，避免把“删除 manifest”留成悬挂的暂存改动（`git status` 长期显示 dirty，进而影响预检）。
- 无 IPC/TS 改动：`ProjectInspection` 字段不变。

## 6. 测试策略

`packages/desktop/src-tauri/src/agent/onboarding/tests.rs`：

1. `creates_gitignore_with_selected_agent_rules` → 断言追加两个小节。
2. `appends_gitignore_rules_and_preserves_content_and_newlines` → 同步期望字符串；CRLF 用例覆盖新规则。
3. 新增 `writes_template_hashes_rule_without_agent_tools`：`ensure_agent_gitignore(root, &[])` 仍只写 `LOCAL_STATE_TITLE` 小节。
4. 新增 `dedupes_template_hashes_rule`：预先写入 `.trellis/.template-hashes.json`（无前导 `/`）→ 不再追加。
5. 新增 `untracks_tracked_template_hashes_on_initial_commit`：`TempRepo` 里 `git init` + 写入并 `git add`/`commit` manifest → 调用 `git::untrack_path` → `git ls-files` 不含该路径、磁盘文件仍在。
6. 新增 `untrack_is_noop_when_not_tracked`：未跟踪时不报错，`git status --porcelain` 不变。

现有测试辅助（`git(&repo.root, &[...])`、`TempRepo`）已在同文件使用，直接复用。