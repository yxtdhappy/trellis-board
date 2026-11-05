# 上游来源与许可

本目录的流程、提示词结构和部分脚本改编自：

```text
/opt/app/work/github/qdata/code-migration-kit-with-claude-code
commit cf91c9d5068d9aaf95a36164169f08c3e636c909
Initial commit — Claude Code Migration Kit
```

上游许可证：Apache-2.0，见 `migration/upstream/LICENSE`。

## 复制/改编清单

| 上游文件 | 本仓库 | 处理 |
|---|---|---|
| `prompts/00-feasibility.md` | `migration/prompts/00-feasibility.md` | 改写目标为 Vue 3 + Vite + TypeScript；保留 verdict/gate |
| `prompts/00b-judge-setup.md` | `migration/prompts/00b-judge-setup.md` | judge 改为 Playwright + API 契约 |
| `prompts/01-dependency-map.md` | `migration/prompts/01-dependency-map.md` | 增加功能/路由/API 地图；保留 depmap |
| `prompts/02-gap-inventory.md` | `migration/prompts/02-gap-inventory.md` | 缺口维度改为 DOM/状态/API/团队/SSE |
| `prompts/06-post-parity.md` | `migration/prompts/06-post-parity.md` | 标记改为 `TODO(vue)` 等；增加旧前端删除检查 |
| `scripts/depmap_ts.mjs` | `migration/scripts/depmap_ts.mjs` | 原样复制 |
| `templates/settings.json` | `.claude/settings.json` | 按 Vue/Vite/TS 调整 deny/allow |
| `skill/SKILL.md` | `.claude/skills/code-migration/SKILL.md` | 改写为项目内迁移路由 |
| `LICENSE` | `migration/upstream/LICENSE` | 原样复制 |

## 明确没有采用

- `prompts/03-stress-test.md`：redesign 的 bakeoff 无效。
- `prompts/04-translation-kickoff.md`：文件级队列不适用于 Vue 组件拆分。
- `prompts/05-survey-build.md`：TypeScript 的 typecheck 并入切片循环。
- `templates/RULEBOOK.md`：由 `migration/DESIGN.md` 替代。
- `scripts/queue_runner.mjs`、`scripts/make_manifest.py`、`scripts/build_daemon.sh`：当前切片队列是人工维护的 `manifest.tsv`，不使用文件级 source→target 队列。

## 说明

- 上游 README 明确说明该 kit 是 reference code、不活跃维护；本目录只借用其流程和结构，不依赖其运行时。
- 本仓库的迁移是 redesign，不是上游默认的 structure-preserving migration；所有与上游不一致之处以 `migration/DESIGN.md` 和 `migration/PLAN.md` 为准。
