# Git 忽略规则兼容研究与实现约束

## 复现事实

- `D:\wit\mdp-algorithm-service` 的 `.gitignore` 来自初始提交 `0240b74c`。
- 该文件显式忽略 `.trellis`、`.agents`、`.gitattributes`，并通过 `AGENTS.md` 与 `*.md` 忽略 `AGENTS.md`。
- 当前一键推送使用普通 `git add -A -- <fixed paths>`；Git 对 ignored path 直接失败，commit/push 不会发生。
- 直接使用 `git add -f` 会绕过 `.trellis/.template-hashes.json` 的本机状态忽略，不符合现有规格。

## 现有实现锚点

- `INITIAL_COMMIT_PATHS` 固定为 `.trellis`、`.gitignore`、`AGENTS.md`、`.gitattributes`、`.agents`。
- `initialize_project` 在完整初始化、Agent-only 和无需初始化的重试路径最后调用 `ensure_agent_gitignore`。
- `ensure_agent_gitignore` 当前追加所选 Agent 本机配置规则和 `/.trellis/.template-hashes.json`，但没有解除项目已有规则对共享路径的忽略。
- `commit_and_push_initial` 当前只补模板哈希忽略规则，然后执行普通 `git add`。

## 规则策略

- 在项目根 `.gitignore` 末尾增加独立小节，只放行初始化需要的共享路径。
- 对目录同时放行目录本身和子树，例如 `!/.trellis/` 与 `!/.trellis/**`。
- 对文件放行 `!/AGENTS.md`、`!/.gitattributes`、`!/.gitignore`。
- 共享路径放行规则之后，再追加 `/.trellis/.template-hashes.json`，确保本机状态仍被忽略。
- 不删除、不改写、不重排已有规则；复用现有 `append_gitignore_rules` 的 LF/CRLF、去重和幂等行为。
- 初始化路径要修复，`commit_and_push_initial` 暂存前也要修复，以覆盖已经初始化但尚未推送的旧项目。
- 不使用 `git add -f`；不使用 `git reset`、`git checkout --` 或改写历史。

## 测试约束

- 最小单元测试应验证严格忽略规则下五个共享路径不再被 `git check-ignore` 命中。
- 同一测试应验证 `.trellis/.template-hashes.json` 仍被忽略。
- 已有 `.gitignore`、CRLF、无尾换行和重复执行必须保留现有测试或补充覆盖。
- 端到端测试使用 bare 远端，证明普通暂存、commit、push 成功，且只提交初始化路径。
