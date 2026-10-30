# 代码库事实

## 运行与依赖

- `package.json` 声明 `"type": "module"` 和 Node `>=24`。
- 项目没有第三方运行时依赖，没有 lint、typecheck 或构建脚本。
- 启动命令为 `node server/index.js`，测试命令为 `node --test tests/*.test.js`。

## 后端与持久化

- HTTP 服务使用 `node:http`，默认监听 `127.0.0.1:4317`。
- 扫描由 Worker Thread 执行，主线程负责 API、缓存、刷新编排和静态资源。
- Board 自身状态写入 `data/board.sqlite`，使用 Node 内置 `node:sqlite`。
- 四个旧 JSON 只作为数据库首次初始化的迁移来源和回滚备份，运行时不再写入。

## 前端

- `public/` 使用原生 HTML、CSS 和浏览器 ES Module。
- 没有 React、Vue、组件框架、Hooks、TypeScript、打包器或构建步骤。
- 页面通过 `/api/*` 获取看板数据，不直接读取仓库文件。

## 测试与规范

- 自动测试使用 `node:test`。
- 当前规范分为 backend、frontend 和 guides 三层。
- 任务事实来源仍是白名单仓库中的 `.trellis/tasks/**`；SQLite 不保存第二套权威任务文件。
