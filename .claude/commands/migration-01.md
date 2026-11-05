执行迁移 gate 01（依赖图 + 功能地图）。

1. 确认 judge gate 已签。
2. 读 `migration/prompts/01-dependency-map.md`。
3. 运行 `migration/scripts/depmap_ts.mjs` 扫描 `public/`。
4. 手工补 HTML 入口（`index.html` / `admin.html` / `login.html`）和功能/API 地图。
5. 产物写到 `migration/depmap/` 和 `migration/feature-map.tsv`。
6. 展示计数与路径，停下等人工确认。
