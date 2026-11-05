---
name: trellis-frontend-migration
description: >
  Run the trellis-board frontend migration from vanilla HTML/JS to Vue 3 +
  Vite + TypeScript using vertical slices and Playwright parity. Use when
  asked to continue the migration, run a migration gate, or execute a slice
  from migration/manifest.tsv.
---

# Trellis Board 前端迁移

本 skill 是项目内版本，不是上游 `code-migration` 的通用版本。先读仓库根目录 `CLAUDE.md` 和 `migration/DESIGN.md`。

## 路由

1. **没有 `migration/reports/00-feasibility.md`**：执行 `migration/prompts/00-feasibility.md`，只出报告，不改代码，停下。
2. **可行性已签，但没有 judge**：执行 `migration/prompts/00b-judge-setup.md`；旧应用全绿 + 故意破坏被抓到之前，不准开始切片。
3. **judge 已签，但没有依赖图/功能地图**：执行 `migration/prompts/01-dependency-map.md`。
4. **没有缺口清单**：执行 `migration/prompts/02-gap-inventory.md`；先做 20 行样例，人工确认后再全量。
5. **准备实现**：从 `migration/manifest.tsv` 取第一个 `planned` 且依赖已满足的切片；按 `CLAUDE.md` §4 执行。
6. **所有切片完成**：执行 `migration/prompts/06-post-parity.md`，再删除旧前端。

## 固定行为

- 一次一个切片；不允许两个 `in_progress`。
- 旧应用是行为 spec，不是 DOM 规范。
- 上游 03/04/05 不使用；不要按文件队列翻译。
- 每个 gate 停下，展示证据，等人工确认。
- 不修改 `migration/DESIGN.md` / `PLAN.md` / `JUDGE.md`；写 `migration/reports/amendments.md`。
- 新功能标 `NEW-BEHAVIOR:`，不混入旧版 parity。
- 命令优先用 `CLAUDE.md` §7 列出的安全命令。
