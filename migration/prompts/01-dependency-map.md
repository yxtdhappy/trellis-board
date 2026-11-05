# 01 — 依赖图 + 功能地图

> 改编自 Claude Code Migration Kit `prompts/01-dependency-map.md`（commit `cf91c9d`）。  
> 上游只建“文件依赖图”；本项目还需要“功能/路由/API 地图”，因为 Vue 组件树不能从 JS import 图直接推导。

**When:** 00b 裁判签完之后。  
**Prerequisites:** `migration/reports/00b-judge.md` 已签。  
**Mode:** 只读源码，写 `migration/depmap/`、`migration/feature-map.tsv`。

---

## 1. 文件依赖图

运行：

```bash
node migration/scripts/depmap_ts.mjs --root public --out migration/depmap
```

参考基线（2026-11-05 实测）：

```text
files=11 edges=14 batches=11 cycles=0
```

边示例：

```text
admin.js -> dom.js
app.js -> team-client.js
app.js -> team-request.js
login.js -> team-request.js
```

要求：

- 保留 `edges.tsv`、`order.txt`、`cycles.txt`。
- 手工补 HTML 入口，因为脚本只解析 JS import：
  - `public/index.html` → `app.js`
  - `public/admin.html` → `admin.js`
  - `public/login.html` → `login.js`
- 说明：`app.js` 是单体入口，文件图很平；它不能决定 Vue 切片顺序。

## 2. 功能地图

新建：

```text
migration/feature-map.tsv
```

列：

```text
area	old_entry	new_entry	api_endpoints	state_owner	notes
```

至少覆盖：

- auth/login/logout/password
- board pipeline
- task detail/artifacts
- task writes（create/assign/stage/dependency/execution/view/wip）
- team view/assignments/operations
- archive
- plugins
- admin users
- admin projects
- admin agents
- admin audit
- runtime/team switch
- SSE（新）

API 端点从 `public/app.js`、`public/admin.js` 提取。基线约 22 个前端端点，包括：

```text
/api/runtime
/api/board
/api/board/status
/api/board/refresh/start
/api/board/settings
/api/repositories
/api/repositories/pick-folders
/api/task
/api/tasks
/api/tasks/accept
/api/tasks/assign
/api/tasks/dependencies
/api/tasks/execution
/api/tasks/stage
/api/tasks/undo
/api/saved-views
/api/team/projects
/api/team/status
/api/assignments?state=pending
/api/auth/me
/api/auth/logout
/api/auth/password
```

Admin 端点单独列，不混入上面计数。

## 3. 入口与渲染边界

给每个旧入口写：

- 加载哪个 HTML
- 入口 JS
- 主要渲染函数
- 全局 state 依赖
- 事件监听数量
- 对应 manifest 切片

至少：

```text
public/index.html -> public/app.js -> S4/S5/S6/S7
public/admin.html -> public/admin.js -> S2/S3
public/login.html -> public/login.js -> S1
```

## 4. 评审

两个独立 reviewer：

- Reviewer A：核对 `edges.tsv` 与源码 import，抽查 20 个文件。
- Reviewer B：核对 `feature-map.tsv` 与 HTML/JS 实际入口、API 字符串，抽查所有入口。

每个 discrepancy 必须引用 `file:line`。确认是脚本/地图错误就修，不要只修样例。

## 5. 输出

```text
migration/depmap/edges.tsv
migration/depmap/order.txt
migration/depmap/cycles.txt
migration/feature-map.tsv
migration/reports/01-map.md
```

报告包含：

- 文件数/边数/循环数
- HTML 入口补全
- 功能地图行数
- API 端点数
- reviewer findings
- 哪些切片可以并行，哪些必须串行

然后**停下**，展示计数和路径。不要开始 02。
