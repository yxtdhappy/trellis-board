# API E2E 报告

- 结论：不适用。
- 原因：本次只调整 `securityHeaders()` 发出的 CSP `img-src`，没有新增或修改 API 路由、请求参数或响应结构；页面级验证由 `packages/server/test/team-static.test.js` 的 CSP 断言覆盖。
- 已执行：
  - `yarn test --scope=server`：541 项，540 通过，1 跳过，0 失败。
  - `node --test packages/server/test/team-static.test.js`：3 项全部通过。
  - `oxfmt --check packages/server/http-common.js packages/server/test/team-static.test.js`：通过。
