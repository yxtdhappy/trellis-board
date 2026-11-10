# Agent 目录探测研究

## Trellis 0.6.17 平台注册表

本地依赖 `node_modules/@mindfoldhq/trellis/dist/types/ai-tools.js` 定义每个平台的 `configDir` 和 `extraManagedPaths`，初始化配置器向这些位置写入模板。

用于远端存在性探测的稳定目录：

| Agent ID | CLI flag | 探测目录 |
| --- | --- | --- |
| `cursor` | `--cursor` | `.cursor` |
| `claude-code` | `--claude` | `.claude` |
| `opencode` | `--opencode` | `.opencode` |
| `codex` | `--codex` | `.codex` |
| `kilo` | `--kilo` | `.kilocode` |
| `kiro` | `--kiro` | `.kiro/skills`、`.kiro/agents`、`.kiro/hooks` |
| `gemini` | `--gemini` | `.gemini` |
| `antigravity` | `--antigravity` | `.agent/workflows`、`.agent/skills` |
| `devin` | `--devin` | `.devin/workflows`、`.devin/skills` |
| `qoder` | `--qoder` | `.qoder` |
| `codebuddy` | `--codebuddy` | `.codebuddy` |
| `copilot` | `--copilot` | `.github/copilot`、`.github/copilot-instructions.md` |
| `droid` | `--droid` | `.factory` |
| `dsh` | `--dsh` | `.dsh` |
| `pi` | `--pi` | `.pi` |
| `reasonix` | `--reasonix` | `.reasonix` |
| `zcode` | `--zcode` | `.zcode` |
| `omp` | `--omp` | `.omp` |
| `trae` | `--trae` | `.trae` |
| `grok` | `--grok` | `.grok` |
| `kimi` | `--kimi` | `.kimi-code` |
| `snow` | `--snow` | `.snow/skills`、`.snow/commands`、`.snow/agents`、`.snow/hooks` |

`.agents/skills` 被 Codex、Gemini、Pi、Kimi 等多个平台共享，不能单独作为某个 Agent 已初始化的判断依据。

## 现有探测边界

`server/team/git-manager.js` 当前的 `probeRemote()` 只执行 `git ls-remote`，只能得到分支和提交 SHA，不能判断分支 tree 中的目录。需要把所选分支浅取到临时 partial clone，再通过 `git ls-tree` 读取受控路径。

## 现有初始化边界

`cloneForTeam()` 只在 `remoteHasTrellis()` 为 false 时调用 `trellisRunner`。因此在已有 `.trellis/` 的项目上选择新 Agent 不会执行任何初始化。

初始化前必须把远端已有的 Agent 目录临时检出；否则 `--skip-existing` 看不到这些文件，会生成与远端已有路径相同的未跟踪文件，随后被越界/覆盖校验拒绝。

## 真实 dev 分支发现：ignored Agent 目录

`mdp-backend-web` 的 `dev` 分支在 `.gitignore` 中忽略 `.codex/*`，Git tree 里不存在 `.codex` 目录；但已提交的 `.trellis/.template-hashes.json` 明确记录 `.codex/config.toml` 等模板哈希，说明 Codex 已经初始化。

只看 `git ls-tree` 会把 Codex 误判为缺失，并触发错误的增量初始化。工作副本校验中的 `git ls-files --others --exclude-standard` 同样会排除这些 ignored 文件，导致初始化完成后继续误报“未生成 Agent 目录”。

修复契约：

- 远端探测用 `git show HEAD:.trellis/.template-hashes.json` 读取清单，把 `hashes` 路径并入 `detectTrellisAgentTools()`。
- 工作副本直接读取 `.trellis/.template-hashes.json`，与可见的 cached/untracked Agent 路径合并后再做初始化校验。
- 清单缺失、JSON 损坏或读取失败时返回空路径集合，不阻断原有 tree 探测。
- 初始化校验通过后，在临时克隆中仅清理已知 Agent 路径，避免 ignored 生成目录阻止最终 `.trellis` 稀疏收敛。

## 前端崩溃证据

浏览器控制台：

```text
Uncaught Error: Base UI error #31
```

本地 Base UI 源码映射：

```text
MenuGroupContext is missing. Menu group parts must be used within <Menu.Group> or <Menu.RadioGroup>.
```

对应前端代码把 `DropdownMenuLabel` 放在 `DropdownMenuGroup` 外。
