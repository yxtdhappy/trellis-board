# Board 预览 WitOps 原文时图片无法显示

## Goal

从 WitOps 同步创建 Trellis 任务后，Board 的「工件查看 · WitOps 原文」弹窗可以直接显示 task.md 里的平台截图；历史任务无需重新同步，现有安全策略不被整体放宽。

## Background

- 同步插件把平台描述 HTML 中的 `<img>` 原样转成 Markdown 图片：`plugins/witops-core/html-to-markdown.js:281-287`；`plugins/witops-core/mapper.js:266-290` 把转换结果写入 `task.md`，图片保留平台绝对地址。
- 实测任务文件 `D:\wit\mdp-backend-service\.trellis\tasks\11-26-B72369\task.md:37` 的内容为 `![图片](http://witops.weintdata.cn/appgw/weint-witops-service/file/download/img?path=...jpg)`；同一文件 `:68` 还有一张同类截图。
- 该图片地址匿名请求返回 `200`、`Content-Type: image/png`、`Content-Length: 146120`（PNG 1440x900），不需要 Cookie/Token，因此不是 WitOps 鉴权问题。
- Board 端 `renderMarkdown()` 会把该 Markdown 渲染成 `<img src="http://witops.weintdata.cn/...">`（`packages/web/src/lib/markdown.js:122-124`）；工件弹窗直接注入这段 HTML（`packages/web/src/features/board/dialogs/TaskDetailArtifactViewer.tsx:30-36`）。
- 页面 CSP 由 `packages/server/http-common.js:20-32` 的 `securityHeaders()` 统一生成：`default-src 'self'`，且没有 `img-src`；按 CSP 回退规则，图片被限制在 `'self'`，跨源图片被浏览器/WebView 拦截。2026-11-26 实测线上 `http://spec-board.weintdata.cn/weint-spec-board/` 响应头与代码一致。
- 桌面客户端登录后打开的是远端 Board 页面（客户端 `serverUrl` 为 `http://spec-board.weintdata.cn`），因此修复服务端 CSP 即可覆盖当前使用场景，不需要重新构建桌面 EXE。

## Requirements

### R1 放行 WitOps 图片源

- 在 `securityHeaders()` 中增加 `img-src 'self' http://witops.weintdata.cn`。
- 只放行当前 WitOps 平台默认源；不得改成 `img-src *`，也不得放开任意 `http:` / `https:` 源。
- 其余 CSP 指令保持原样，至少包括 `default-src 'self'`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'`、`connect-src`、`frame-src`、`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`、`form-action 'self'`。

### R2 历史任务与同步逻辑不变

- `task.md` 继续保留平台绝对图片地址；不改 `plugins/witops-core` 的同步、HTML→Markdown 转换和任务文件格式。
- 已同步的历史任务不需要重新拉取，修复部署后立即生效；新同步任务行为与历史任务一致。

### R3 生效范围

- CSP 由 `securityHeaders()` 统一发给 Team 模式、本地/独立模式、登录页、共享页以及 API 响应；改动一处即可全部覆盖。
- 不修改 `packages/desktop/src-tauri/tauri.conf.json`：桌面客户端加载的是远端 Board 页面，本地登录页不展示任务 Markdown，不属于本需求。

### R4 回归测试

- 在服务端 CSP 相关测试中断言 `img-src 'self' http://witops.weintdata.cn` 存在，并断言 `script-src`、`connect-src`、`frame-src` 等关键指令未被改动。

## Non-goals

- 不修改同步插件、任务文件格式或历史任务数据。
- 不做服务端图片代理、图片下载落盘或图片缓存。
- 不根据插件 `baseUrl` 动态生成 CSP；如果以后要支持其他 WitOps 域名，另立需求。
- 不处理 WitOps 不可达、图片地址失效等网络/数据问题；这种情况下弹窗保持现有行为，文字内容继续正常显示。
- 不启用 Markdown raw HTML，不改变 `renderMarkdown()` 的转义边界。

## Acceptance Criteria

- [ ] 部署后打开任务 `11-26-B72369` 的「工件查看 · WitOps 原文」，截图正常显示，不再是 broken image。
- [ ] Board 页面响应头包含 `img-src 'self' http://witops.weintdata.cn`。
- [ ] `script-src 'self'`、`connect-src`、`frame-src`、`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'` 与改动前一致。
- [ ] 历史 task.md（含平台绝对图片地址）无需重新同步即可预览。
- [ ] `packages/server` 相关测试通过；新增断言在 `img-src` 被移除时会失败。
- [ ] 图片源不可达时，弹窗仍能显示文字内容，其他行为不变。
