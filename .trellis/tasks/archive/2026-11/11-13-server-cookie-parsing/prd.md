# PRD: team 会话 cookie 解析换 cookie 包

## 目标

`apps/server/team/auth.js` 手写了 Cookie 头解析（`:576`）与 `Set-Cookie` 拼装（`:595`/`:607`），共约 29 行。改用 `cookie@2` 的标准实现，保留对外签名与调用点不变。

## 需求

- R1 `parseCookieHeader(value)` 保持导出，返回 `Map`（调用点 `apps/server/team/http.js:538`、`:1429` 用 `.get(SESSION_COOKIE)`，不改）。
- R2 `sessionCookie(token, config)` 保持签名与属性集合：`HttpOnly`、`SameSite=Strict`、`Path=/`、`Secure`（`config.cookieSecure` 为真时）；值用 `encodeURIComponent` 等价编码（token 是 base64url，编码为恒等）。
- R3 `clearSessionCookie(config)` 保持签名，额外带 `Max-Age=0`。
- R4 行为差异（实测 `cookie@2`）：非法百分号序列不再丢弃整个 cookie，而是保留原值（`bad=%ZZ` → `'%ZZ'`）；同名 Cookie 取**首个**（旧实现后者覆盖）；空名条目（`=nokey`）会被保留。三者都只影响 `.get(SESSION_COOKIE)` 取到的 token，损坏 token 查不到 session，与丢弃等价。
- R5 新增 `apps/server/test/team-cookie.test.js`：解析多值、重名后者覆盖、非法编码保留、空值、空 header；`sessionCookie`/`clearSessionCookie` 的属性与 `Secure` 分支。
- R6 依赖 `cookie@^2.0.2` 声明在 `apps/server/package.json`（仅 server 使用，按项目约定不提升到根）。

## 非目标

- 不改 `SESSION_COOKIE` 名称、CSRF 校验、session 存储与过期逻辑。
- 不改 `apps/server/team/http.js` 的任何调用点。

## 约束

- `cookie@2` 是 ESM-only（`"type": "module"`，`engines.node >= 22`），服务端本来全是 ESM，无兼容问题。
- 不得改变登录/登出响应里 `set-cookie` 的可解析性（浏览器与 curl 都不依赖属性顺序）。

## 验收

- A1 `apps/server/team/auth.js` 中 `parseCookieHeader`、`sessionCookie`、`clearSessionCookie` 三个函数体合计 ≤ 12 行（当前约 29 行）。
- A2 `grep -n "split(';')" apps/server/team/auth.js` 无结果。
- A3 `node --test apps/server/test/team-cookie.test.js` 全绿。
- A4 team 模式冒烟：登录响应 `set-cookie` 含 `HttpOnly`、`SameSite=Strict`、`Path=/`；带该 cookie 请求 `/api/runtime` 返回 `authenticated: true` 与用户名；登出响应 `set-cookie` 含 `Max-Age=0` 且值为空。
- A5 `npm test` 全绿。
