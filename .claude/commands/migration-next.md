执行下一个纵向切片。

1. 读 `CLAUDE.md`、`migration/PLAN.md`、`migration/DESIGN.md`。
2. 从 `migration/manifest.tsv` 找第一个 `status=planned` 且 `depends_on` 已全部 `done` 的切片。
3. 把该行改为 `in_progress`；同一时间只允许一个 `in_progress`。
4. 按 `CLAUDE.md` §4 执行：实现 → 自测 → 双评审 → 修复 → gate。
5. 把证据写到 `migration/reports/slices/<id>.md`，然后停下等人工确认。
6. 未过 gate 前不要开始下一个切片。
