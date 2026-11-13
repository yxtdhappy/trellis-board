# 修复 Team 模式静态资源目录

## Goal

对齐 Team 模式静态资源目录与 Web 构建输出，确保客户端根页面、登录页和管理页由当前服务端正确提供。

## Requirements

- Team 模式默认静态资源目录必须与 [`apps/web/vite.config.ts`](../../../apps/web/vite.config.ts) 的构建输出一致，即 `apps/server/public`。
- 保留 `createTeamRuntime({ publicDir })` 的显式覆盖能力，避免影响测试和定制部署。
- 不修改客户端、同步协议或任务看板数据。
- 单批任务文件超过 1024 个导致的任务同步问题不在本任务范围。

## Acceptance Criteria

- [x] 未显式传入 `publicDir` 时，Team 模式从 `apps/server/public` 提供静态资源。
- [x] 执行一次前端生产构建后，`GET /`、`GET /index.html`、`GET /login.html` 和 `GET /admin.html` 返回 `200`。
- [x] 静态资源不存在时仍返回现有 `404 NOT_FOUND` 结构。
- [x] 相关 Node 测试通过，服务端重启后实际浏览器从客户端地址成功渲染登录页。

## Notes

- 当前根目录 `public/` 是旧目录结构遗留产物；新构建输出目录为 `apps/server/public/`，且已被 `.gitignore` 忽略。
