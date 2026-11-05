# 迁移脚本

## `depmap_ts.mjs`

上游 Claude Code Migration Kit 的 JS/TS 依赖图脚本，原样复制。用法：

```bash
node migration/scripts/depmap_ts.mjs --root public --out migration/depmap
```

输出：

```text
migration/depmap/edges.tsv
migration/depmap/order.txt
migration/depmap/cycles.txt
```

注意：

- 只解析相对 import/require；裸包名、Node 内置模块不算边。
- 不解析 HTML 的 `<script src>`；入口需要手工补到 `migration/feature-map.tsv`。
- 当前 `public/` 的基线：11 个 JS 文件、14 条边、0 个循环。
- 文件图只用于理解依赖，不用来决定纵向切片顺序；切片顺序看 `manifest.tsv`。

## 不使用的上游脚本

- `make_manifest.py`：生成 source→target 文件清单，不适用于 Vue 组件拆分。
- `queue_runner.mjs`：按文件队列执行，不适用。
- `build_daemon.sh`：面向重型编译；本项目用 `vue-tsc` + `vite build` 在切片内跑。
