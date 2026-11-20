# 实施计划：接入初始化增强

> 全局规则：开发过程中不执行构建；所有代码改完后只做一次最终编译/测试验证。

## 1. 后端：Git 写操作（`packages/desktop/src-tauri/src/agent/git.rs`）

- [x] `GitOperation` 增加 `AddPaths`、`DiffCachedQuiet`、`CommitPaths`、`PushBranch`，同步 `ALL` 与 `as_str`。
- [x] `GitParams` 增加 `message: Option<&'a str>`；`DiffCachedQuiet` 加入关闭 fsmonitor 的操作集合。
- [x] 参数构造：
  - `add -A -- <paths>`
  - `diff --cached --quiet -- <paths>`
  - `commit -m <message> -- <paths>`
  - `push origin refs/heads/<branch>:refs/heads/<branch>`（先 `validate_branch_name_syntax`）
- [x] 新增 `add_paths`、`has_staged_changes`、`commit_paths`、`push_branch`。
- [x] commit 身份缺失与 push 非快进/网络错误分类，消息可操作。
- [x] 在 `git/tests.rs` 补参数构造断言（不执行真实网络）。

验证点：`has_staged_changes` 的 0/1/其他退出码分别映射为 false/true/错误。

## 2. 后端：Agent 忽略规则（`packages/desktop/src-tauri/src/agent/trellis_cli.rs`）

- [x] `AgentTool` 增加 `gitignore_paths: &'static [&'static str]`，按设计文档填写 22 个平台。
- [x] Copilot 使用精确 `.github` 子路径。
- [x] 新增 `pub fn agent_gitignore_paths(tools: &[String]) -> Vec<&'static str>`：按表顺序展开、去重。
- [x] 在 `trellis_cli/tests.rs` 覆盖普通工具、Copilot、去重与顺序。

## 3. 后端：onboarding（`packages/desktop/src-tauri/src/agent/onboarding.rs`）

- [x] `ProjectInspection` 增加 `developer_name: Option<String>`，`inspect_project_with` 填充。
- [x] 新增 `read_developer_name(repo_path) -> Option<String>`：读取 `.trellis/.developer`，取首个非空 `name=`。
- [x] 新增 `ensure_agent_gitignore(repo_path, agent_tools) -> AgentResult<()>`：
  - 读取/创建 `.gitignore`；保留内容与换行风格；
  - 归一化去重（`trim` + 去首尾 `/`）；
  - 追加标题与缺失规则；无新增不写文件；
  - 写失败返回明确错误。
- [x] `initialize_project` 在 init/Agent-only 完成后调用 `ensure_agent_gitignore`，再重新 inspect；
      即使 mode=None 也执行，保证失败后可重试修复。
- [x] 新增 `pub async fn commit_and_push_initial(repo_path, hooks_dir, allow_file_remote) -> AgentResult<InitialPushState>`：
  add 固定路径 → 判断是否需 commit → 固定 message commit → push 当前分支 → 复用
  `check_initial_push_with` 返回最终状态；无 `.trellis` 可提交时给出明确错误。
- [x] 更新 `task_command/tests.rs` 的 `ProjectInspection` 字面量。
- [x] `onboarding/tests.rs` 增加：
  - developer 解析（正常/缺失/空值/CRLF）；
  - `.gitignore` 新建、追加、去重、无尾换行、CRLF、幂等；
  - bare 远端端到端提交推送；无关已暂存文件不被提交；第二次点击不产生空提交；
  - 未出生分支可创建 root commit。

## 4. 后端：命令与权限

- [x] `agent_service.rs` 增加 `commit_and_push_initial_project(app, repo_path)` 薄封装。
- [x] `main.rs` 增加 `commit_and_push_pending_project`：
      `ensure_board_caller` → 读取 `pending_project_path` → 调用封装 → 返回 `{ok:true,...state}`。
- [x] 注册到 `generate_handler!`。
- [x] `permissions/desktop.toml` 增加 `allow-commit-and-push-pending-project`。
- [x] `capabilities/board-local-association.json` 加入该权限。

## 5. 前端

- [x] `packages/web/src/lib/project-inspection.js` / `.d.ts` 增加 `developerName`（缺失为 `''`）。
- [x] `packages/web/src/lib/onboarding-probe.js` 增加 `normalizePushState(value)`。
- [x] `ProjectOnboardingDialog.tsx`：
  - developer 默认值改为 `inspection.developerName || pickProjectTrellisDevId(...)`；
  - 增加 `commitAndPush()`，失败/成功都更新 `push` 与 `message`；
  - “首次推送确认”按钮行加入“一键提交并推送”，保留“检查推送状态”和手动命令；
  - 更新“客户端不会自动 commit/push”的文案。
- [x] `AgentQuickInitDialog.tsx`：developer 默认值改为
      `inspection.developerName || defaultDeveloperId`。
- [x] `ProjectRail.tsx` 不修改默认值来源（弹窗内决定优先级）。

## 6. 测试与文档

- [x] `packages/web/test/project-inspection.test.js`：补 `developerName`。
- [x] `packages/web/test/onboarding-probe.test.js`：补 `normalizePushState`。
- [x] `docs/product-prd.md` §6.5.3：说明显式点击可由客户端提交/推送，固定 message 与路径。
- [x] `README.md` 客户端接入步骤：补充一键提交推送与 `.gitignore` 行为。
- [x] `packages/desktop/README.md`：更新接入流程与 Tauri 权限命令列表。

## 7. 验证结果（2026-11-20）

- 本次改动文件 `oxfmt --check`：通过。
- 仓库级 `yarn format:check`：失败 25 个文件，全部是仓库既有未格式化文件（已按用户决定恢复到
  HEAD，不纳入本次交付），与本任务无关。
- `yarn test`：683 通过，0 失败，2 跳过。
- `yarn build`（`tsc -b && vite build`）：通过，exit 0。
- `cargo test`：未执行；本机未安装 Rust/cargo，桌面端编译与 Rust 测试由 CI
  `.github/workflows/windows.yml` 的 `cargo test` 覆盖。
- 真机桌面 UI：未执行（本机无 Rust/Tauri 运行环境）。

## 8. 风险文件与回滚点

| 文件 | 风险 | 回滚 |
| --- | --- | --- |
| `agent/git.rs` | 新增写操作，参数构造错误会误提交 | 删除 4 个 operation 与函数，恢复白名单 |
| `agent/onboarding.rs` | 初始化流程与推送状态耦合 | 移除 gitignore 调用与 commit_and_push_initial |
| `main.rs` / 权限文件 | 远程可调用新命令 | 删除命令注册、权限与 capability 条目 |
| `ProjectOnboardingDialog.tsx` | 按钮与轮询竞争 | 删除按钮与 `commitAndPush`，恢复旧文案 |
| `trellis_cli.rs` 工具表 | 22 项规则填错会误忽略 | 按表逐项核对，仅影响新写入的 `.gitignore` |

提交前检查：`git diff` 只包含本任务文件；`.gitignore` 规则不会覆盖 `.trellis` 或项目源码目录。