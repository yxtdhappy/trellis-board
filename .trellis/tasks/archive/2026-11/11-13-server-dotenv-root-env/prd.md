# server 读取项目根目录 .env（dotenv）

## Goal

服务端启动时读取仓库根目录 `.env`，把其中键值注入进程环境变量，让 `standalone` 与 `team`
两种模式都能从文件配置。用户明确指定使用 dotenv 实现，并允许新增 npm 依赖——仓库原有的
"零安装部署 / 无第三方运行时依赖"约束一并移除。

## Requirements

- R1 引入 dotenv 的加载能力（dotenv 语义：`KEY=VALUE`、`#` 注释、单/双引号、`export` 前缀、多行双引号值）。
- R2 加载发生在任何配置解析之前，且对三条入口都生效：
  - `node apps/server/index.js`（standalone 与 team 共用入口）
  - `npm start` / `npm run board`（同一条入口）
  - `node apps/server/team/cli.js init-admin|status`（CLI 同样按环境变量决定模式与数据库路径）
- R3 文件固定为仓库根目录 `.env`，与启动时的 cwd 无关。
- R4 文件缺失属于正常情况：不报错、不中断启动、不增加日志噪音。
- R5 优先级：真实进程环境变量优先于 `.env` 中的同名键，`.env` 不得覆盖命令行/进程已设置的值。
- R6 文件存在但读取失败（权限、目录占位等非 ENOENT 错误）必须让启动失败，并给出可定位的中文错误；
  不允许静默降级成"配置没生效但服务照常跑"。
- R7 `.env` 不入库（`.gitignore` 已含 `.env`、`.env.*`、`!.env.example`）；新增 `.env.example` 模板列出可用键。
- R8 移除"零安装部署 / 无第三方运行时依赖"约束及其派生的三条限制，且不新增替代限制：
  `.trellis/spec/backend/index.md` 删除"不依赖 Web 框架或数据库驱动包"与"跨包引用只用仓库相对路径"；
  README 删除"未安装依赖也能启动 / 没有第三方运行时依赖"；
  `.trellis/spec/guides/code-reuse-thinking-guide.md` 删除"刻意保持小而直接"的规则表述。
  删除 `scripts/check-boundaries.mjs` 及其 `check:boundaries` npm script 与 CI 步骤。
  跨包引用统一迁移到 workspace 包名（`@trellis-board/shared/*`、`@trellis-board/test-support/*`、
  `@trellis-board/server/*`），web 的 `@shared` 别名移除；被多个 workspace 共用的第三方依赖提升到
  根 `package.json`，仅单包使用的留在该包。
- R9 文档更新：README 启动章节说明 `npm install` 前置、`.env` 加载来源、缺失行为、优先级与可用键。

## Constraints

- C1 依赖安装已是既有前置：`README.md:42` 的启动步骤含 `npm install`，
  `.github/workflows/windows.yml:59` 在测试前执行 `npm ci`；本任务不改变 CI 安装流程。
- C2 不做变量插值（不引入 dotenv-expand），不做 `.env.local` / `.env.production` 分层，不读 `dotenvx` 加密文件。
- C3 插件子进程与 Git 子进程继承 `process.env`，因此 `.env` 生效后自然可见；不为它们各自加载文件。
- C4 桌面客户端进程内不运行 server、不携带 Node 运行时（`apps/desktop/package-portable.ps1:8`），本任务不改动 `apps/desktop`。
- C5 跨包引用只写 workspace 包名，不再保留相对路径写法；`plugins/*`、`scripts/*` 不是 workspace，
  它们通过根 `node_modules` 的 workspace 符号链接解析，不额外声明依赖。
- C6 不新增 HTTP API、不改 SQLite schema、不改扫描缓存签名。

## Acceptance Criteria

- [ ] A1 `apps/server/test/env-file.test.js` 覆盖：注入成功、已存在键不被覆盖、缺失文件不抛错且不写值、
      dotenv 语法（引号/注释/`export`/多行）、显式文件路径、cwd 与仓库根不一致时仍读根目录 `.env`。
- [ ] A2 真机冒烟：仓库根 `.env` 写 `PORT=<空闲端口>`、`TRELLIS_WATCH_DEBOUNCE_MS=1200`，
      `npm start` 后监听该端口、日志 `debounce=1200ms`、`/api/health` 返回 200；删除 `.env` 后回到 4317 正常启动。
- [ ] A3 优先级：进程环境 `PORT=4501` 与 `.env` 中 `PORT=4500` 并存时监听 4501（命令行覆盖文件）。
- [ ] A4 `.env` 中 `TRELLIS_BOARD_MODE=team` 时，`node apps/server/team/cli.js status` 输出 `mode: "team"`
      （证明 CLI 入口同样加载）。
- [ ] A5 `apps/server/package.json` 的 dependencies 只新增 `dotenv`，`package-lock.json` 同步；`npm ci` 后启动正常；
      `npm test`、`npm run test:plugins`、`npm run build` 通过。
- [ ] A6 无 `.env` 时启动日志与当前一致，无 dotenv 横幅、无"未找到 .env"提示。
- [ ] A7 非 ENOENT 读取错误（测试里用目录占位 `.env` 模拟）抛出含路径的中文错误。
- [ ] A8 README、`.env.example` 落地；README 不再声称"未安装依赖也能启动"或"没有第三方运行时依赖"；
      `.trellis/spec/backend/index.md`、`.trellis/spec/guides/code-reuse-thinking-guide.md` 中的旧约束全部改写；
      `scripts/check-boundaries.mjs` 与 `check:boundaries` 引用全部删除；`@shared` 别名与相对跨包 import 全部消失。

## Non-Goals

- 前端、桌面客户端、插件的独立 env 文件加载。
- 多环境文件合并、加密 env、配置热重载。
- 借本次放宽约束做 server 代码重构/换框架（另行评估，见任务目录 `research/dependency-opportunities.md`）。
