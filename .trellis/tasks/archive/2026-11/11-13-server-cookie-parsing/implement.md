# 实施计划: team 会话 cookie 解析换 cookie 包

## 步骤

1. `npm install cookie@^2.0.2 --workspace @trellis-board/server`。
2. 改 `apps/server/team/auth.js`：顶部 `import { parseCookie, stringifySetCookie } from 'cookie'`；按 design.md 重写三个函数（`SESSION_COOKIE` 常量不变）。
3. 新增 `apps/server/test/team-cookie.test.js`：
   - `parseCookieHeader('a=1; b=%E4%B8%AD')` → Map 取值正确
   - `parseCookieHeader('a=1; a=2')` → `'2'`
   - `parseCookieHeader('bad=%ZZ')` → `'%ZZ'`（记录行为差异）
   - `parseCookieHeader('')` / `undefined` → 空 Map
   - `sessionCookie('t', { cookieSecure: false })` → 含 `HttpOnly`、`SameSite=Strict`、`Path=/`，不含 `Secure`
   - `sessionCookie('t', { cookieSecure: true })` → 含 `Secure`
   - `clearSessionCookie({ cookieSecure: false })` → 含 `Max-Age=0` 且值为空
4. 确认无其他自写 cookie 解析：`grep -rn "split(';')\|decodeURIComponent" apps/server --include=*.js`。

## 验证

```bash
node --test apps/server/test/team-cookie.test.js
npm test
TRELLIS_BOARD_MODE=team node apps/server/index.js &
curl -si -X POST http://127.0.0.1:4317/api/runtime/login -H 'content-type: application/json' -d '{"username":"admin","password":"…"}' | grep -i set-cookie
# 带 cookie 请求 /api/runtime → 200；登出响应含 Max-Age=0
```

## 回滚点

单 commit；三个函数是纯函数，回滚不影响数据结构。

## 完成标准

- A1–A5 满足；team 登录/登出冒烟通过。
