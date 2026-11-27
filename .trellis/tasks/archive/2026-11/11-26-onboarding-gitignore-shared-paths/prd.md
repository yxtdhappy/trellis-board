# 初始化时修正 Git 忽略规则以支持一键推送

## Goal

让已有 `.gitignore` 规则较严格的项目也能完成 Trellis Board 初始化和一键提交推送：必须共享的 Trellis 初始化文件不再被忽略，同时本机状态文件继续保持忽略。

## Background / Confirmed facts

- `mdp-algorithm-service` 的 `.gitignore` 是仓库初始提交 `0240b74c` 就存在的文件，其中显式忽略了 `.trellis`、`.agents`、`.gitattributes`，并通过 `AGENTS.md` 与 `*.md` 忽略 `AGENTS.md`。
- 当前一键推送调用普通 `git add -A -- <paths>`；被忽略路径会让 Git 直接拒绝暂存，提交和推送不会发生。
- 当前初始化只追加所选 Agent 的本机目录规则和 `/.trellis/.template-hashes.json`，不会解除已有规则对共享初始化文件的忽略。
- 不能直接改用 `git add -f`：它会绕过 `.trellis/.template-hashes.json` 的本机状态忽略规则，可能把不应共享的文件提交到仓库。
- 初始化路径还会处理已完成 Trellis 初始化的项目；这类项目可能不再显示初始化按钮，因此一键提交推送自身也必须能修复旧项目。

## Requirements

### R1 追加共享文件反忽略规则

- 初始化时，在项目根 `.gitignore` 末尾追加独立、可识别的反忽略规则，覆盖一键初始化提交所需的共享路径：`.trellis`、`.gitignore`、`AGENTS.md`、`.gitattributes`、`.agents`。
- 反忽略规则必须位于项目已有忽略规则之后，能够解除根目录规则对上述路径及其子文件的忽略。
- 不得删除、改写或重排用户已有规则；保留原文件内容和换行风格。
- 重复执行必须幂等，不重复追加标题或等价规则。

### R2 保留本机状态忽略

- `.trellis/.template-hashes.json` 必须继续保持忽略，不得因为反忽略父目录而进入初始化提交。
- 反忽略共享路径与重新忽略本机状态文件的顺序必须稳定：先放行共享路径，再放行必要的本机忽略规则。

### R3 初始化与一键推送双重保障

- 完整初始化、Agent-only 初始化和无需初始化的重试路径都应确保反忽略规则存在。
- 打开首次推送确认后直接点击“一键提交并推送”的已初始化项目，也应在暂存前补齐反忽略规则，不能要求用户先重新初始化。
- `.gitignore` 写入失败仍应作为初始化或提交步骤的明确失败返回，不得静默降级。

### R4 Git 暂存和提交边界

- 修复后继续使用普通 Git 暂存，不引入 `git add -f` 或其它绕过项目忽略规则的机制。
- 只提交既定的初始化路径；其他已暂存或未暂存文件和本机状态文件不得进入 `初始化trellis` 提交。

## Acceptance Criteria

- [ ] AC-R1.1 项目 `.gitignore` 包含 `.trellis`、`.agents`、`.gitattributes`、`AGENTS.md` 等忽略规则时，初始化成功并在末尾追加共享路径反忽略小节。
- [ ] AC-R1.2 反忽略规则不删除用户原规则，LF/CRLF 和末尾无换行场景均正确处理；重复初始化不产生重复标题或规则。
- [ ] AC-R2.1 修复后 `git check-ignore` 不再命中 `.trellis`、`.agents`、`AGENTS.md`、`.gitattributes`、`.gitignore`；`.trellis/.template-hashes.json` 仍被忽略。
- [ ] AC-R3.1 对已初始化但尚未放行的项目，直接执行一键提交推送也能补齐规则并成功进入 commit/push。
- [ ] AC-R4.1 普通 `git add` 成功，不依赖 `-f`；提交只包含初始化路径，不包含本机状态文件和其他用户改动。
- [ ] AC-R4.2 已跟踪的 `.trellis/.template-hashes.json` 仍按现有逻辑从索引移除，工作区文件保留。
- [ ] AC-R4.3 针对严格 `.gitignore` 的最小端到端测试使用 bare 远端完成 commit 和 push，并验证远端 HEAD 与本地一致。

## Out of scope

- 不修改全局 Git 忽略配置或 `.git/info/exclude`。
- 不强行提交任意被项目忽略的业务文件。
- 不移除项目原有的忽略策略，只追加完成 Trellis 初始化所需的精确反忽略规则。
- 不处理 Git 代理、认证或网络连通性；该问题与本次忽略规则修复分离。

## Key Decisions

- 采用受控反忽略规则，不使用 `git add -f`。
- 复用一键初始化已有的固定共享路径集合，避免维护第二份文件清单。
- 在初始化和一键提交前都执行规则修复，以覆盖新项目和已初始化旧项目。
- 本机状态忽略规则保持在共享路径反忽略规则之后。

## Open Questions

无。
