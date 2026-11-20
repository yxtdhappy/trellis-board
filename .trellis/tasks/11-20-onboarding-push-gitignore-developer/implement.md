# 实施计划：接入初始化增强

> 全局规则：开发过程中不执行构建；所有代码改完后只做一次最终编译/测试验证。

## 1. 后端：Git 写操作（`packages/desktop/src-tauri/src/agent/git.rs`）

- [ ] `GitOperation` 增加 `AddPaths`、`DiffCachedQuiet`、`CommitPaths`、`PushBranch`，同步 `ALL` 与 `as_str`。
- [ ] `GitParams` 增加 `message: Option<&'a str>`；`DiffCachedQuiet` 加入关闭 fsmonitor 的操作集合。
- [ ] 参数构造：
  - `add -A -- <paths>`
  - `diff --cached --quiet -- <paths>`
  - `commit -m <message> -- <paths>`
  - `push origin refs/heads/<branch>:refs/heads/<branch>`（先 `validate_branch_name_syntax`）
- [ ] 新增 `add_paths`、`has_staged_changes`、`commit_paths`、`push_branch`。
- [ ] commit 身份缺失与 push 非快进/网络错误分类，消息可操作。
- [ ] 在 `git/tests.rs` 补参数构造断言（不执行真实网络）。

验证点：`has_staged_changes` 的 0/1/其他退出码分别映射为 false/true/错误。

## 2. 后端：Agent 忽略规则（`packages/desktop/src-tauri/src/agent/trellis_cli.rs`）

- [ ] `AgentTool` 增加 `gitignore_paths: &'static [&'static str]`，按设计文档填写 22 个平台。
- [ ] Copilot 使用精确 `.github` 子路径。
- [ ] 新增 `pub fn agent_gitignore_paths(tools: &[String]) -> Vec<&'static str>`：按表顺序展开、去重。
- [ ] 在 `trellis_cli/tests.rs` 覆盖普通工具、Copilot、去重与顺序。

## 3. 后端：onboarding（`packages/desktop/src-tauri/src/agent/onboarding.rs`）

- [ ] `ProjectInspection` 增加 `developer_name: Option<String>`，`inspect_project_with` 填充。
- [ ] 新增 `read_developer_name(repo_path) -> Option<String>`：读取 `.trellis/.developer`，取首个非空 `name=`。
- [ ] 新增 `ensure_agent_gitignore(repo_path, agent_tools) -> AgentResult<()>`：
  - 读取/创建 `.gitignore`；保留内容与换行风格；
  - 归一化去重（`trim` + 去首尾 `/`）；
  - 追加标题与缺失规则；无新增不写文件；
  - 写失败返回明确错误。
- [ ] `initialize_project` 在 init/Agent-only 完成后调用 `ensure_agent_gitignore`，再重新 inspect；
      即使 mode=None 也执行，保证失败后可重试修复。
- [ ] 新增 `pub async fn commit_and_push_initial(repo_path, hooks_dir, allow_file_remote) -> AgentResult<InitialPushState>`：
  add 固定路径 → 判断是否需 commit → 固定 message commit → push 当前分支 → 复用
  `check_initial_push_with` 返回最终状态；无 `.trellis` 可提交时给出明确错误。
- [ ] 更新 `task_command/tests.rs` 的 `ProjectInspection` 字面量。
- [ ] `onboarding/tests.rs` 增加：
  - developer 解析（正常/缺失/空值/CRLF）；
  - `.gitignore` 新建、追加、去重、无尾换行、CRLF、幂等；
  - bare 远端端到端提交推送；无关已暂存文件不被提交；第二次点击不产生空提交；
  - 未出生分支可创建 root commit。

## 4. 后端：命令与权限

- [ ] `agent_service.rs` 增加 `commit_and_push_initial_project(app, repo_path)` 薄封装。
- [ ] `main.rs` 增加 `commit_and_push_pending_project`：
      `ensure_board_caller` → 读取 `pending_project_path` → 调用封装 → 返回 `{ok:true,...state}`。
- [ ] 注册到 `generate_handler!`。
- [ ] `permissions/desktop.toml` 增加 `allow-commit-and-push-pending-project`。
- [ ] `capabilities/board-local-association.json` 加入该权限。

## 5. 前端

- [ ] `packages/web/src/lib/project-inspection.js` / `.d.ts` 增加 `developerName`（缺失为 `''`）。
- [ ] `packages/web/src/lib/onboarding-probe.js` 增加 `normalizePushState(value)`。
- [ ] `ProjectOnboardingDialog.tsx`：
  - developer 默认值改为 `inspection.developerName || pickProjectTrellisDevId(...)`；
  - 增加 `commitAndPush()`，失败/成功都更新 `push` 与 `message`；
  - “首次推送确认”按钮行加入“一键提交并推送”，保留“检查推送状态”和手动命令；
  - 更新“客户端不会自动 commit/push”的文案。
- [ ] `AgentQuickInitDialog.tsx`：developer 默认值改为
      `inspection.developerName || defaultDeveloperId`。
- [ ] `ProjectRail.tsx` 不修改默认值来源（弹窗内决定优先级）。

## 6. 测试与文档

- [ ] `packages/web/test/project-inspection.test.js`：补 `developerName`。
- [ ] `packages/web/test/onboarding-probe.test.js`：补 `normalizePushState`。
- [ ] `docs/product-prd.md` §6.5.3：说明显式点击可由客户端提交/推送，固定 message 与路径。
- [ ] `README.md` 客户端接入步骤：补充一键提交推送与 `.gitignore` 行为。
- [ ] `packages/desktop/README.md`：更新接入流程与 Tauri 权限命令列表。

## 7. 最终验证（全部开发完成后只执行一次构建链）

```bash
yarn format
yarn format:check
yarn test
cd packages/desktop/src-tauri && cargo test
cd ../../.. && yarn build
```

- `cargo test` 同时承担 Rust 编译验证；失败后只做必要修复再重跑。
- 前端 `tsc -b` 由 `yarn build` 覆盖；不新增源码文本断言。
- 如条件允许，启动桌面客户端实际走一次“接入本地项目 → 初始化 → 一键提交推送”，
  确认按钮状态、developer 默认值与 `.gitignore` 结果；若环境不允许，在交付说明中标注未做真机验收。

## 8. 风险文件与回滚点

| 文件 | 风险 | 回滚 |
| --- | --- | --- |
| `agent/git.rs` | 新增写操作，参数构造错误会误提交 | 删除 4 个 operation 与函数，恢复白名单 |
| `agent/onboarding.rs` | 初始化流程与推送状态耦合 | 移除 gitignore 调用与 commit_and_push_initial |
| `main.rs` / 权限文件 | 远程可调用新命令 | 删除命令注册、权限与 capability 条目 |
| `ProjectOnboardingDialog.tsx` | 按钮与轮询竞争 | 删除按钮与 `commitAndPush`，恢复旧文案 |
| `trellis_cli.rs` 工具表 | 22 项规则填错会误忽略 | 按表逐项核对，仅影响新写入的 `.gitignore` |

提交前检查：`git diff` 只包含本任务文件；`.gitignore` 规则不会覆盖 `.trellis` 或项目源码目录。