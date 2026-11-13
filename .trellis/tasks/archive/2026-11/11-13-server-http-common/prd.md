# PRD: server HTTP 小工具三合一

## 目标

`apps/server/index.js`（standalone）与 `apps/server/team/http.js`（team）各自实现了一套 `sendJson` / `readJsonBody` / `serveStatic`。合并为 `apps/server/http-common.js`，让 standalone 获得 team 已有的静态资源安全校验与响应能力，消除两套语义。

## 需求

- R1 新增 `apps/server/http-common.js`，导出 `sendJson`、`readJsonBody`、`serveStatic` 三个函数与 `STATIC_TYPES` 常量表。
- R2 `sendJson(response, status, payload, { headers = {}, gzip = false, security = false } = {})`：`headersSent` 时 `destroy`；默认 `content-type: application/json; charset=utf-8`；`content-length` 必带；`gzip` 为真且 `accept-encoding` 含 gzip 且 body ≥ 1024 字节时压缩并带 `content-encoding`/`vary`；`security` 为真时合并 team 的 `securityHeaders()`。
- R3 `readJsonBody(request, { maxBytes, errors })`：`content-length` 预检 → 流式累计上限 → `JSON.parse` → 必须是普通对象；四类失败通过注入的 `errors`（`tooLarge`/`invalidJson`/`notObject`）构造错误。
- R4 `serveStatic({ request, response, pathname, publicDir, errors, headers })`：仅 GET/HEAD（否则 405 + `allow: GET, HEAD`）；`realpathSync` 校验目标仍在 `publicDir` 实路径内（含符号链接逃逸）；13 项 `STATIC_TYPES`；`content-length`；HEAD 不写 body；读流出错 `destroy`。
- R5 standalone 行为变化（有意的能力补齐）：静态资源获得 realpath 校验、HEAD/405、`content-length`、字体/webmanifest/map 的 MIME；`.html` 保持 `no-store`，其余保持 `public, max-age=60`。
- R6 删除 `apps/server/index.js` 与 `apps/server/team/http.js` 内的三份本地实现；`securityHeaders()` 留在 `team/http.js` 作为参数传入，standalone 不启用 CSP。
- R7 错误形状不合并：standalone 继续返回 `{ error }` + 400/403/404 状态码；team 继续返回 `{ error, code }` + `teamError` 码值。

## 非目标

- 不引入 HTTP 框架、不引入路由/中间件层。
- 不改任何 API 路由、鉴权、CSRF 逻辑。
- 不统一 standalone 与 team 的错误码体系。

## 约束

- `team/http.js` 的 `MAX_JSON_BYTES`（64 KiB）与 standalone 的 1 MiB 各自保留，作为调用参数传入。
- 不允许 `http-common.js` import `team/errors.js` 或任何 team 模块（standalone 模式不加载 team 代码）。

## 验收

- A1 `apps/server/http-common.js` 存在且不 import `./team/` 下任何模块。
- A2 `grep -n "function sendJson\|function readJsonBody\|function serveStatic" apps/server/index.js apps/server/team/http.js` 无结果。
- A3 `npm test` 全绿。
- A4 standalone 冒烟：`node apps/server/index.js` 后 `/` 返回 200 且 `content-type: text/html`、`content-length` 存在；`HEAD /` 返回 200 且无 body；`POST /index.html` 返回 405。
- A5 team 冒烟：登录页 `/login.html` 返回 200 且带 `content-security-policy`、`x-frame-options`；`GET /api/runtime` 未登录返回 401 且 body 是 `{ error, code }`。
