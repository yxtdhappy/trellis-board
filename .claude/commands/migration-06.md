执行迁移 gate 06（Post-Parity 收尾）。

1. 确认所有 slice 已完成且全量 parity 全绿。
2. 读 `migration/prompts/06-post-parity.md`。
3. 机械收集 `TODO(vue)` / `PARITY-GAP` / `NEW-BEHAVIOR` / `BUG(legacy)` / `PERF(vue)` 标记。
4. 分类 fix-now / document-and-close；每个 fix 独立提交并重跑 parity。
5. 报告写到 `migration/reports/06-parity.md`，停下等人工确认后再删除旧前端。
