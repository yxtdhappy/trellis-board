# 设计: team 会话 cookie 解析换 cookie 包

## 现状（实测）

```js
// apps/server/team/auth.js:576
export function parseCookieHeader(value) { /* split(';') + indexOf('=') + decodeURIComponent + Map */ }
// :595 sessionCookie：`${name}=${encodeURIComponent(token)}` + HttpOnly + SameSite=Strict + Path=/ + (Secure)
// :607 clearSessionCookie：同上 + Max-Age=0
```

调用点：`apps/server/team/http.js:538`（`readActor`）、`:1429`（SSE 授权）、`:862`（登录写 cookie）。仓库内**没有**直接测试这三个函数的用例。

## cookie@2.0.2 实测

- 导出：`parseCookie`、`parseSetCookie`、`stringifyCookie`、`stringifySetCookie`（不是 `parse`/`serialize`）。
- `parseCookie('a=1; b=%E4%B8%AD; bad=%ZZ; a=2')` → null 原型对象 `{a:'1', b:'中', bad:'%ZZ'}`：非法编码保留原值，**重名取首个**（实测，与旧实现“后者覆盖”相反）；`=nokey` 会得到空名键。
- `stringifySetCookie({name:'t', value:'a b', httpOnly:true, sameSite:'strict', path:'/', maxAge:0})` → `t=a%20b; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`。
- ESM-only，`engines.node >= 22`。

## 实现

```js
import { parseCookie, stringifySetCookie } from 'cookie'

export function parseCookieHeader(value) {
  return new Map(Object.entries(parseCookie(String(value || ''))))
}

export function sessionCookie(token, config) {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: Boolean(config.cookieSecure),
  })
}

export function clearSessionCookie(config) {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: Boolean(config.cookieSecure),
  })
}
```

## 决策与差异

- **保留 Map 返回**：三个调用点依赖 `.get()`，改返回对象会扩散改动；`new Map(Object.entries(...))` 一行完成适配。
- **属性顺序变化**（`Max-Age` 前移到 `Path` 之前）：无消费者依赖顺序，浏览器与 curl 均按属性名解析。
- **非法编码保留原值**：旧实现 `try/catch` 丢弃该项。新行为下 `%ZZ` 会成为 token 字面量，`readSession` 查不到 → 401，与丢弃等价；同时少一次异常捕获。
- **`secure: Boolean(...)`**：`cookie` 对 `false` 不输出 `Secure`，与现状 `config.cookieSecure ? 'Secure' : null` 等价。
- **不做**：不引入 session 中间件、不改 CSRF token 的 cookie 存储方式。

## 风险

- `parseCookie` 对含 `;` 或 `=` 的异常输入宽容度高于旧实现（旧实现按首个 `=` 切分，新实现按规范解析），极端畸形头可能解析出不同的键集合；影响仅限于取不到会话 token。
- 依赖面：`cookie` 无传递依赖，包体 < 5 KB。
