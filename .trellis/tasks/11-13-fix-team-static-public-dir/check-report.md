# Team 静态资源目录检查报告

## 结论

Team 模式默认静态资源目录已与 Web 构建输出统一为 `apps/server/public`。根页面、登录页、
管理页及首页引用的全部静态资源均可由已重启的 Team 服务正常返回；实际 Chrome 渲染登录页成功。

本次未修改客户端、同步协议或任务数据，也未处理“单批任务文件不能超过 1024 个”的独立问题。

## 验收映射

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 未传 `publicDir` 时使用 `apps/server/public` | 通过 | 新增默认目录行为回归测试 |
| 生产构建后根页面、登录页和管理页返回 200 | 通过 | `npm run build` 与真实 HTTP 请求 |
| 不存在的静态资源保留 `404 NOT_FOUND` | 通过 | `/assets/not-exist.js` 返回标准 JSON |
| 服务端重启后页面可加载 | 通过 | PID `38788` 监听 `4317`，Chrome 实际渲染登录页 |

## 自动化与运行验证

- `node --test apps/server/test/team-static.test.js`：3/3 通过。
- `npm run build`：通过，产物写入 `apps/server/public`。
- 首页引用的 favicon、主题脚本、JS 和 CSS 资源：全部返回 `200`。
- `/`、`/index.html`、`/login.html`、`/admin.html`：返回 `200`。
- `/assets/not-exist.js`：返回 `404`，正文为 `{"error":"静态资源不存在","code":"NOT_FOUND"}`。
- `/api/health`：返回 Team 模式健康状态，进程 PID 为 `38788`。
- `npx oxfmt --check apps/server/team/http.js apps/server/test/team-static.test.js`：通过。
- `python ./.trellis/scripts/task.py validate .trellis/tasks/11-13-fix-team-static-public-dir`：通过。
- `git diff --check`：通过，仅有既有任务文件的 CRLF 提示。

## 全量检查边界

- `npm test`：428 项中 426 通过、1 跳过、1 失败；唯一失败是桌面 UI 产物尚未构建。
- 执行 `npm run build:desktop` 后，对应 `apps/desktop/test/desktop-ui-build.test.js` 4/4 通过。
- 未在补齐桌面 UI 产物后重跑耗时约五分钟的全量测试。
- `npm run check:boundaries` 仍有 1 个既有失败：
  `plugins/witops-core/test/witops-plugins.test.js` 引用了旧 `tests/` 路径。

## 未执行与后续

- 已定位安装版客户端 `C:\Users\yuhaojie\AppData\Local\Trellis Board\trellis-board-client.exe`，
  但本轮未启动该 GUI 进程；已用真实 Chrome 验证同一客户端地址的完整静态加载与登录页渲染。
- 任务空间 `7b8d00fa-f478-4c47-a0ef-615462d5bdb5` 的 1024 文件批次上限问题仍未处理。
- 未提交、未推送、未归档。
