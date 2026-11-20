# 设计：接入初始化增强

## 1. 边界与总体思路

- 所有写入仍由桌面端 Rust 进程执行；Web 只通过既有 `invoke` 合约调用，不接触本地路径。
- 一键提交推送复用现有 `onboarding` 预检和 `git` 调用层，不引入第二套 Git 执行方式。
- `.gitignore` 更新放在 `onboarding::initialize_project`，因此“接入本地项目”和“项目列表初始化编码 Agent”自动共用同一逻辑。
- developer 身份由 `ProjectInspection` 携带，两个弹窗共用同一默认值来源。

## 2. R1：一键提交并推送

### 2.1 命令契约

新增 Tauri command：

```text
commit_and_push_pending_project() -> { ok: true, state, message, localHead?, remoteHead?,
                                        dirtySummary?, localAhead?, remoteAhead? }
```

- 无参数；只读取 `DesktopAuthState.pending_project_path`。
- 必须调用 `ensure_board_caller`，与 `check_pending_project_push` 同权限级别。
- 在 `packages/desktop/src-tauri/permissions/desktop.toml` 声明
  `allow-commit-and-push-pending-project`，并加入
  `capabilities/board-local-association.json`。
- 在 `agent_service` 增加薄封装：读取 `trellis_runtime` 之外只需 `ephemeral_hooks` 和
  `allow_file_remote`，调用 `onboarding::commit_and_push_initial`。

### 2.2 后端流程（`onboarding::commit_and_push_initial`）

1. `inspect_git_project(..., expected_branch=None)`：校验 Git 根、分支、origin、sparse checkout。
2. 组装固定路径：`[".trellis"]`；`.gitignore` 存在时追加 `".gitignore"`。不存在不传，避免
   `pathspec did not match`。
3. `git::add_paths(root, hooks, paths)` → `git add -A -- <paths>`。
4. `git::has_staged_changes(root, hooks, paths)` → `git diff --cached --quiet -- <paths>`：
   - exit 0：无可提交内容。若 `.trellis/` 也从未进入 HEAD，返回明确错误
     “没有可提交的 .trellis 初始化文件，请检查 .trellis 是否被 .gitignore 忽略”。
   - exit 1：存在暂存差异，继续 commit。
   - 其他：视为 Git 失败。
5. `git::commit_paths(root, hooks, "初始化trellis", paths)` →
   `git commit -m 初始化trellis -- <paths>`。pathspec 形式只提交指定路径，不卷入其他已暂存文件；
   未出生分支（无 HEAD）在 add 之后可以正常创建 root commit（已用 Git 实测）。
6. `git::push_branch(root, hooks, current_branch)` →
   `git push origin refs/heads/<branch>:refs/heads/<branch>`。使用全限定 refspec，避免分支名被当作参数。
7. 调用 `check_initial_push_with` 返回最终状态；若状态不是 `ready`，照实返回，由 UI 展示原因。

### 2.3 Git 层扩展（`packages/desktop/src-tauri/src/agent/git.rs`）

- `GitOperation` 新增：`AddPaths`、`DiffCachedQuiet`、`CommitPaths`、`PushBranch`，并同步 `ALL`
  与 `as_str`。
- `GitParams` 新增 `message: Option<&'a str>`。
- 开启 `core.fsmonitor=false` 的操作集合加入 `DiffCachedQuiet`。
- 新增 async 函数：`add_paths`、`has_staged_changes`、`commit_paths`、`push_branch`。
- 错误分类：
  - commit：识别 `Please tell me who you are` / `unable to auto-detect email address` /
    `empty ident name`，提示先配置 `user.name` 与 `user.email`。
  - push：识别 `non-fast-forward` / `fetch first` / `[rejected]`，提示远端有新提交；
    网络与认证错误复用不可达文案；其余保留 stderr 尾部。
- 沿用 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`、空 `core.hooksPath`、固定超时；
  push 使用网络超时 180s。

### 2.4 UI（`ProjectOnboardingDialog.tsx`）

- `commitAndPush()`：调用新命令，成功后用 `normalizePushState` 写入 `push`，并更新 `message`；
  失败走 `onboardingErrorMessage(error, '提交并推送失败')`。
- 按钮行：`一键提交并推送`（主按钮）与 `检查推送状态`（outline）。
- 文案改为：“客户端不会自动提交；点击按钮由客户端提交 `.trellis` 与 `.gitignore` 并推送，
  也可以手动执行：”，保留原命令代码块。
- `busy` 同时保护两个按钮；5 秒静默轮询继续存在，成功后自动停止。

## 3. R2：自动更新 `.gitignore`

### 3.1 工具到忽略规则的映射

规则放在 `trellis_cli.rs` 的 `AgentTool` 表中，新增 `gitignore_paths` 字段，避免维护第二张 22 项表。
所有普通平台使用根锚定目录：

| 工具 | 规则 |
| --- | --- |
| cursor | `/.cursor/` |
| claude-code | `/.claude/` |
| opencode | `/.opencode/` |
| codex | `/.codex/` |
| kilo | `/.kilocode/` |
| kiro | `/.kiro/` |
| gemini | `/.gemini/` |
| antigravity | `/.agent/` |
| devin | `/.devin/` |
| qoder | `/.qoder/` |
| codebuddy | `/.codebuddy/` |
| droid | `/.factory/` |
| dsh | `/.dsh/` |
| pi | `/.pi/` |
| reasonix | `/.reasonix/` |
| zcode | `/.zcode/` |
| omp | `/.omp/` |
| trae | `/.trae/` |
| grok | `/.grok/` |
| kimi | `/.kimi-code/` |
| snow | `/.snow/` |

Copilot 写入共享 `.github` 目录，只忽略 Trellis 精确产物：

```text
/.github/copilot/
/.github/copilot-instructions.md
/.github/hooks/trellis.json
/.github/prompts/start.prompt.md
/.github/prompts/continue.prompt.md
/.github/prompts/finish-work.prompt.md
/.github/skills/trellis-*/
/.github/agents/trellis-*.agent.md
```

`trellis_cli::agent_gitignore_paths(tools)` 按 `AGENT_TOOLS` 顺序展开并去重，保证输出稳定。

### 3.2 写入策略（`onboarding::ensure_agent_gitignore`）

- 读取项目根 `.gitignore`：不存在按空文件处理；其他读取错误返回失败。
- 规则去重：对现有行和候选规则都做 `trim` → 去首 `/` → 去尾 `/` 后精确比较，
  因此 `.codex`、`.codex/`、`/.codex/` 视为同一规则。
- 保留原内容；如果文件非空且末尾无换行，先补换行；检测 CRLF 并保持同一换行风格。
- 缺少规则时追加一次标题 `# Trellis local agent configs (local only)`（已存在则不重复）和缺失规则。
- 无新增时不做写操作，因此重复执行幂等。
- 调用位置：`initialize_project` 在 init/Agent-only 完成后、重新 inspect 之前，对 `selected_tools`
  无条件执行（含 mode=None 的重试场景）；失败返回 AgentError，消息包含 “更新项目 .gitignore”。

## 4. R3：developer 默认值

- `ProjectInspection` 新增 `developer_name: Option<String>`，序列化为 `developerName`。
- `inspect_project_with` 调用 `read_developer_name(root)`：
  - 读取 `<root>/.trellis/.developer`；
  - 逐行取第一个 `name=`，`trim` 后非空且不超过 120 字符；
  - 文件缺失、不可读或没有 name 时返回 `None`。
- `ProjectOnboardingDialog`：
  `preferredDeveloperId = inspection.developerName.trim() || pickProjectTrellisDevId(...)`。
- `AgentQuickInitDialog`：
  `inspection.developerName.trim() || defaultDeveloperId.trim()`；现有 `developerIdEdited` ref
  继续阻止后到结果覆盖用户输入。
- `ProjectRail` 无需改动：它仍传入项目 trellisDevId/账号兜底，优先级由弹窗内决定。

## 5. 兼容性

- `developerName` 是新增可选字段；旧响应缺失时 Web 归一化为空字符串，行为退回原有逻辑。
- 新命令需要重新构建桌面安装包；Web 单独部署时，旧客户端会返回 `Command not found`，
  理论上不会同版本混用（桌面 UI 随客户端打包）。
- 不修改服务端 API、数据库或任务同步协议。

## 6. 测试设计

- Rust `trellis_cli/tests.rs`：工具到规则映射、Copilot 精确路径、去重与顺序稳定。
- Rust `onboarding/tests.rs`：
  - `.developer` 解析：正常、缺失、空 name、CRLF；
  - `.gitignore`：新建、追加、等价规则去重、无尾换行、CRLF 保留、幂等；
  - 一键提交推送：bare 远端端到端、固定 commit message、只含固定路径、无关已暂存文件不被提交、
    第二次点击不产生空提交、未出生分支可创建 root commit。
- Rust `task_command/tests.rs`：补 `developer_name` 字段。
- Web `packages/web/test/project-inspection.test.js`：`developerName` 归一化与默认值。
- Web `packages/web/test/onboarding-probe.test.js`：`normalizePushState` 容错。
- 不新增读取源码文本的断言；前端类型与交互用 `tsc`、构建和实际页面验收证明。

## 7. 回滚

- 一键推送是独立新命令，回滚时删除命令注册、权限、UI 按钮即可恢复旧流程。
- `.gitignore` 与 developerName 均为增量行为；回滚代码后已写入的忽略规则不影响项目运行，
  可按需手动删除。
- 实现顺序保证每一步可独立编译：Git 层 → onboarding → 命令/权限 → Web → 文档。