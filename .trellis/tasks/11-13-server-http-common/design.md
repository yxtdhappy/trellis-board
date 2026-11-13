# 设计: server HTTP 小工具三合一

## 现状（实测）

| 函数 | `apps/server/index.js` | `apps/server/team/http.js` |
| --- | --- | --- |
| `sendJson` | `:65`，8 行：`content-type` + `cache-control: no-store`，无 length/gzip/安全头 | `:100`，40 行：`headersSent` 保护、gzip、`securityHeaders()`、`content-length` |
| `readJsonBody` | `:74`，14 行：1 MiB 硬编码，仅字符串拼接，不要求对象 | `:232`，35 行：`content-length` 预检、413 码、Buffer 拼接、要求普通对象 |
| `serveStatic` | `:839`，30 行：`startsWith(publicDir)` 字符串前缀、5 种 MIME、无 HEAD/405/length | `:430`，约 85 行：`safeStaticPath`（`path.sep` 边界）+ `realpathSync` 校验、405、HEAD、13 种 MIME、`content-length` |

`apps/server/public` 是指向 web 构建产物的符号链接，standalone 目前只做字符串前缀比较，符号链接指向工作树外的文件会被直接读出。

## 接口

```js
// apps/server/http-common.js
export const STATIC_TYPES // Map<扩展名, mime>，取 team 版 13 项

export function sendJson(response, status, payload, { headers = {}, gzip = false, security = false } = {})
export async function readJsonBody(request, { maxBytes, errors })
export function serveStatic({ request, response, pathname, publicDir, errors, headers = {} })
```

`errors` 是工厂集合，避免 common 依赖 team 的错误模块：

```js
// team/http.js
const httpErrors = {
  tooLarge: (maxBytes) => teamError(413, ERROR_CODES.BODY_TOO_LARGE, `请求体超过 ${Math.floor(maxBytes / 1024)} KiB 限制`),
  invalidJson: () => teamError(400, ERROR_CODES.INVALID_INPUT, '请求体不是合法 JSON'),
  notObject: () => teamError(400, ERROR_CODES.INVALID_INPUT, '请求体必须是 JSON 对象'),
  forbidden: () => teamError(403, ERROR_CODES.FORBIDDEN, '静态资源路径越界'),
  notFound: () => teamError(404, ERROR_CODES.NOT_FOUND, '静态资源不存在'),
  methodNotAllowed: () => teamError(400, ERROR_CODES.INVALID_INPUT, '静态资源只支持 GET 或 HEAD'),
}

// apps/server/index.js：普通 Error + 状态码，保持现有 `{ error }` 响应
```

## 关键决策

- **`sendJson` 的 gzip 判断**沿用 team 的 `response.req?.headers['accept-encoding']`（Node 的 `ServerResponse` 自带 `.req` 引用），不额外传参。
- **`serveStatic` 用 `realpathSync` 双校验**（目标与根），保留 team 现有的 `path.sep` 边界写法（`filePath !== root && !filePath.startsWith(root + path.sep)`），不再用 `startsWith(publicDir)`。
- **MIME 表只保留一份**（13 项）；standalone 的 `.html` `no-store` 规则通过 `headers` 参数或函数内的缓存策略分支保留——最终实现采用 `cacheControl` 选项（`'no-store' | 'public, max-age=60'`），避免把策略塞进 MIME 表。
- **405 的错误形状**：team 现有实现把 405 映射成 `INVALID_INPUT` 400 码但状态码 405，属于既有不一致；本次不改（超出范围），在 implement.md 中记录为已知遗留。
- **不做**：不抽 `createHttpServer`、不做路由表、不做中间件链。

## 风险

- standalone 静态响应新增 `content-length` 与 405，若前端有 `fetch` 依赖 404 文本的行为需要冒烟确认（当前只有 SPA 入口）。
- `readJsonBody` 改为 Buffer 拼接后，超过上限时错误在读取中途抛出，Node 会销毁连接；与 team 现状一致。
