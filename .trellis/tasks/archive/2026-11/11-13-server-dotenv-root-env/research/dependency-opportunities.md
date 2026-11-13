# 约束清单与依赖放宽后的可优化点（2026-11-13）

## 一、现有"零安装 / 无第三方运行时依赖"约束的全部落点

| # | 位置 | 原文/机制 | 处理 |
| --- | --- | --- | --- |
| 1 | `scripts/check-boundaries.mjs:14,32` | 禁用 `@trellis-board/` 导入，理由"零安装部署" | **整个脚本删除**（已移除），不替换 |
| 2 | `.trellis/spec/backend/index.md:3` | "不依赖 Web 框架或数据库驱动包" | **删除**（已移除） |
| 3 | `.trellis/spec/backend/index.md` 基本约束 | "跨包引用只用仓库相对路径…不写 workspace 包名" | **改为：跨包用 workspace 包名；共享第三方依赖提升到根 `package.json`** |
| 4 | `.trellis/spec/guides/code-reuse-thinking-guide.md:3` | "没有第三方运行时依赖" | **删除**（已移除） |
| 5 | `README.md:29-31` | "不依赖 workspace 包名解析，因此 `node apps/server/index.js` 在未安装依赖的目录中也能启动" | 删除该结论，改为"运行时依赖由根 `npm install` 安装" |
| 6 | `README.md:38` | "没有第三方运行时依赖" | 删除 |

非约束、无需改动：`README.md:42` 启动步骤本来就含 `npm install`；`.github/workflows/windows.yml:59,142`
本来就执行 `npm ci`；`apps/desktop/package-portable.ps1:8` 明确客户端不携带 Node 运行时，桌面侧不受影响。
`.trellis/tasks/archive/**` 与 `.trellis/workflow.md:385`（说的是允许记录第三方库用法）是历史记录，不改。

## 二、放宽后的可优化点（按收益/风险排序）

| 候选 | 现状 | 依赖方案 | 收益 | 风险 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `.env` 加载 | 无加载器 | `dotenv` | 官方语义 | 低 | **本任务纳入** |
| ZIP 编解码 `packages/shared/zip.js`（278 行） | 手写 EOCD/中央目录解析 + `zlib.inflateRawSync`；只被 `apps/server/team/workspace-templates.js:5` 的 `readZipEntries` 使用 | `fflate`（零依赖，`unzipSync`） | 删 ~150 行手工二进制解析 | 中：zip-slip/大小上限/Windows 保留名等安全层仍要自己写，且必须保留 | 可选，单独任务，先补 `packages/shared/test/zip.test.js`（目前只有 `apps/server/test/team-workspace-template.test.js` 间接覆盖） |
| HTTP 路由 | `apps/server/index.js` 25 个 `pathname ===` 分支 + `team/http.js` 53 个 + 38 个 `if` | Hono/Fastify | 路由/中间件结构化 | 高：两套 1863+1014 行请求管线、鉴权/SSE/静态/原子写全部耦合，回归面覆盖团队模式 | **不建议**；收益抵不上重写风险 |
| 重复的 HTTP 小工具 | `sendJson`、`readJsonBody`、`serveStatic` 在 `index.js:65/74/839` 与 `team/http.js:100/232/430` 各一份 | 自行去重或 `mime` | 去重 ~80 行 | 低 | 可选，非依赖问题，随时可做 |
| 日志 `apps/server/logger.js`（187 行） | 自写轮转 + 敏感信息脱敏正则 | `pino` + `pino-roll` | 结构化日志 | 中：脱敏规则仍需自定义，轮转语义要重验 | 不划算 |
| 文件监听 `packages/shared/trellis-watcher.js`（149 行） | `fs.watch` + 路径归一 + 去抖 | `chokidar` | 跨平台边角更稳 | 中：现有 `TRELLIS_WATCH_DEBOUNCE_MS` 契约与测试要重写 | 暂缓，除非出现实测漏事件 |
| git 操作 `team/git-manager.js`（1775 行） | `spawn('git', ...)` 封装 | `simple-git` | 少量样板 | 高：凭据、超时、并发、工作副本语义全在自定义代码里 | 不建议 |
| SQLite | `node:sqlite` + 预编译语句 | better-sqlite3 / query builder | 无明显收益 | 中：内置模块已满足且零成本 | 不建议 |
| 鉴权 `team/auth.js` | `crypto.scrypt` + DB session + 自写 cookie 解析 | argon2 / cookie 库 | 略微 | 中：现有参数与测试已固化 | 不建议 |

结论：只把 `dotenv` 作为依赖纳入本任务；ZIP 与 HTTP 工具去重列为可选后续任务，
框架/日志/git/SQLite 明确不做。
