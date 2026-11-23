# E2E 记录：trellis-init-regression（v0.4.61 客户端）

测试日期：2026-11-23　执行方式：CDP（WebView2 `--remote-debugging-port=9333`）调用真实 Tauri 命令，
目标仓库 `C:\Users\yuhaojie\Desktop\trellis-init-regression`（远端 github.com/yxtdhappy/trellis-init-regression）。

## 通过项

- 全新仓库初始化（claude-code + codex）：commit `b6a19c2 初始化trellis`，远端树无 `.trellis/.template-hashes.json`，
  `.trellis/` 55 个文件正常入库，`.agents/` 46、`AGENTS.md`、`.gitignore`、`.gitattributes` 均按预期提交。
- manifest 本机化：本地 17884 字节，`git check-ignore` 命中 `/.trellis/.template-hashes.json`；
  `.claude/`、`.codex/`、`.trellis/.developer` 均为 ignored。
- 推送状态检查：`check_pending_project_push` 由 `waiting_commit` → `ready`；关联成功（taskSpace `f676ac24-…`）。
- 幂等：同参数重复初始化，`.gitignore` 与 manifest 字节级不变。
- 新增 agent（agents-only，加 opencode）：manifest 139 → 195 键，不产生提交，符合设计。

## 遗留问题（用户决定先记录、本次不修）

### F1（严重）代理环境下列表外的环境变量被丢弃，git 远端操作全部失败

- 位置：`packages/desktop/src-tauri/src/agent/process.rs:14-30` `ENV_ALLOWLIST`，只放行 PATH/HOME 等 15 个变量，
  没有 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`ALL_PROXY`。
- 现象：客户端 `commit_and_push_pending_project` 报 `无法访问 Git 远端，请检查网络和凭据`；
  `check_pending_project_push` 返回 `unable_to_verify`（`暂时无法连接远端，不能确认是否已推送`）。
- 对照：同一台机器 git CLI 推送成功（用户级环境变量 `HTTPS_PROXY=http://127.0.0.1:7897`）。
  给测试仓库加 `git config http.proxy http://127.0.0.1:7897` 后客户端立即成功 → 根因确认。
- 影响：所有通过用户级/系统级环境变量配代理的网络下，客户端的初始化提交、推送、远端同步都会失败。
- 修复方向：把上述变量加入 allowlist；是否放行 `ALL_PROXY` 需同时确认 git for Windows 的 libcurl 行为。

### F2（体验）新增 agent 的忽略规则被追加到“本机状态”小节之后

- 位置：`packages/desktop/src-tauri/src/agent/onboarding.rs` 的 `append_gitignore_rules`（一律追加到文件末尾）。
- 现象：第二次初始化（加 opencode）后 `/.opencode/` 落在文件末尾，agent 配置小节被“本机状态”小节劈开：

  ```
  # Trellis local agent configs (local only)
  /.claude/
  /.codex/
  # Trellis local state (local only)
  /.trellis/.template-hashes.json
  /.opencode/
  ```

- 影响：仅可读性，gitignore 语义不变；规则越多越乱。
- 修复方向：追加 agent 规则时，若文件里已存在 `LOCAL_STATE_TITLE` 小节，把新规则插到该小节标题之前。

## 备注

- 测试仓库临时保留了 `http.proxy`/`https.proxy` 本地配置，用于绕过 F1；修好后可删除。
- 测试期间客户端以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 启动。
- `.trellis/tasks/00-bootstrap-guidelines/task.json` 被关联流程修改属预期。