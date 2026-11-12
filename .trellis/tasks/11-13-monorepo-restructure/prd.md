# 项目结构改造为 monorepo

## Goal

把当前「根目录散放 + `web/` 子包」的单仓结构，重组为 npm workspaces 管理的 monorepo：
各端（服务端、前端、桌面客户端）成为明确的应用包，共享代码与测试支撑成为支撑包，构建、测试、发布入口
统一从仓库根驱动，同时保持现有 standalone/team 两种运行模式和 Windows 打包产物不变。

## Background（仓库现状，已核实）

- 根 `package.json`（`trellis-board@0.2.0`，`type: module`，`node >= 24`）没有 workspaces；
  依赖只有 `@mindfoldhq/trellis@0.6.17`，开发依赖 `oxfmt`。根脚本：`dev`、`board`/`start`、
  `build`（`npm --prefix web run build`）、`web:dev`、`capacity`、`format`、`test`、
  `test:plugins`、`test:all`。
- `web/` 是独立 npm 包（自己的 `package-lock.json`、React 19 / Vite 8 / TS 7 / Tailwind 4），
  构建产物写到根 `public/`（`web/vite.config.ts` 的 `build.outDir = ../public`）；
  桌面 UI 由 `web/vite.desktop.config.ts` 输出到 `desktop/ui/`。两处产物都被 `.gitignore` 忽略。
- `shared/` 是无依赖纯 ESM：server 通过 `../shared/*.js`、agent 通过 `../shared/*.js`、
  web 通过 `@shared/*` 别名（`web/vite.config.ts` + `web/tsconfig.app.json`）复用。
- `server/` 由 `node server/index.js` 启动，按 `path.resolve(serverDir, '..')` 定位仓库根，
  静态目录固定为 `<root>/public`；插件默认从 `<root>/plugins/<id>/index.js` 加载
  （`server/plugins/supervisor.js` 的 `resolveModule`），可用 `module` 覆盖为绝对路径。
- `agent/` 是独立 Node CLI（`trellis-agent.cmd`），通过 `agent/package-agent.ps1` 按显式文件
  白名单打 ZIP，产物默认到仓库 `dist/`；依赖 `../shared/*.js`。**但它已无生产消费方**：
  桌面端在 `11-12-rust-desktop-agent-single-exe` 中改为 Rust 进程内实现并删除了
  `desktop/sidecar/**`（sidecar 是 `agent/*` 的唯一运行时使用者）；CI 不再打包它，
  README/docs 也不再引用。当前仅 6 个测试与 `server/team/workspace-templates.js` 的
  `agent/zip.js` 还在引用。
- `desktop/` 是 Tauri v2 客户端（`desktop/src-tauri`），`frontendDist: "../ui"`，UI 是
  `web` 的构建产物；`desktop/package-portable.ps1` 只打包 `cargo tauri build` 的 EXE。
- `plugins/<id>/` 是运行时插件，`index.js` 通过相对路径 `../../server/plugins/sdk.js` 引用宿
  主 SDK；插件测试通过 `../../../tests/helpers/*`、`../../../server/*` 引用宿主导出。
  除 `a2a-intake`、`acp-dispatch`、`scenario-copilot` 外都被 `.gitignore` 排除。
- 测试分三处：根 `tests/*.test.js`（71 个，覆盖 server 与插件宿主协议）、
  `agent/test/*.test.js`（10 个）、`plugins/*/test/*.test.js`（6 个）。
- CI `.github/workflows/windows.yml`：`node-tests` job 用两个 lockfile 缓存，执行
  `npm ci`、`npm ci --prefix web`、`npm run build`、`npm test`、`node --test agent/test/*.test.js`；
  `desktop-build` job 安装 Tauri CLI 后 `npm ci`、`npm ci --prefix web`、`npm run build`、
  `npm --prefix web run build:desktop`、`cargo test`。
- 文档/规范中大量以 `server/`、`web/`、`agent/`、`desktop/`、`shared/`、`plugins/` 作为锚点：
  `README.md`、`docs/team-operations.md`、`desktop/README.md`、`agent/README.md`、
  `plugins/README.md`、`.trellis/spec/frontend/directory-structure.md`、
  `.trellis/spec/backend/desktop-agent-runtime.md` 等。

## Constraints

- 运行时行为不变：`npm start` / `node apps/server/index.js` 仍能在默认端口 4317 提供看板，
  `apps/server/public` 静态资源、插件加载、Tauri 构建链全部可用。
- 保持零第三方运行时依赖（Node 内置 `node:sqlite`）；不引入 turbo/nx/lerna 等编排工具。
- 保持 Windows 优先：PowerShell 打包脚本、DPAPI、NSIS 产物路径不能失效。
- `plugins/` 是用户可自行放置的目录，路径契约（`plugins/<id>/` 与 `plugin.json` 的 `id` 相等）
  不能改变；内置插件仍随仓库发布。
- 生产部署目录布局（`TRELLIS_BOARD_DATA_DIR`、日志、SQLite）不受影响。

## Requirements

- R1：仓库根成为 npm workspaces 根，所有子包使用同一份 `package-lock.json`；
  移除 `web/package-lock.json`，`npm ci` 一次安装全部工作区依赖。
- R2：按功能收敛为 **3 个应用包** `apps/{server,web,desktop}`，共享代码与测试支撑放 `packages/{shared,test-support}`；包名、入口、`exports` 明确；桌面包的 `build` 脚本封装
  `cargo tauri build`。
- R3：根脚本统一转发：`dev`、`build`（web + desktop UI）、`start`、`test`（全部单测）、
  `test:plugins`、`format`、打包脚本入口；CI 只用根脚本。
- R4：跨包 import 统一为「从仓库根可解析的显式路径」，且运行时包（server/plugins）
  不依赖 `node_modules` 解析，保持零安装部署；前端构建期使用 Vite alias。
  - 已实验否决 workspace 包名导入：复制仓库后直接 `node apps/server/index.js` 时没有
    `node_modules`，包名无法解析；Node `imports` 子路径映射也不能指向包外
    （`ERR_INVALID_PACKAGE_TARGET`）。
  - 因此 server/plugins 使用相对仓库根路径（如 `../../packages/shared/slug.js`），
    web 使用 `@shared` alias；禁止在运行时包中出现 workspace 包名 import。
  - 插件 SDK 不单独成包，继续随宿主放在 `apps/server/plugins/{sdk,protocol}.js`；外部插件
    改以相对路径 `../../apps/server/plugins/sdk.js` 引用。
- R5：构建产物位置与静态服务路径保持一致（web → 服务端静态目录），或通过显式配置解耦；
  `desktop/ui` 仍由桌面构建链生成。
- R6：所有测试迁移到所属工作区，`node --test` 发现规则与 CI 命令同步更新。
  随 Node agent 删除，其 16 个测试（`agent/test` 10 + 依赖 agent 模块的根测试 6）一并删除；
  其余测试数量不减少、断言不放宽。删除清单与理由必须写入 design.md。
  迁移后不保留根 `tests/`：唯一的跨包测试 `task-space-duplicate-cleanup.test.js` 归入
  `apps/server/test`，根 `tests/` 目录整体删除。旧目录 `server/`、`web/`、`shared/`、
  `desktop/`、`agent/`、`tests/` 均不得残留（含空目录）。
- R7：CI 两个 job 适配新结构（缓存路径、安装/构建/测试命令），Windows 打包脚本适配新路径。
- R8：文档与 `.trellis/spec` 中的路径引用更新为新结构，不保留过时路径。

## Acceptance Criteria

- [ ] `npm ci` 在干净仓库一次安装全部工作区依赖，无 `web/package-lock.json`。
- [ ] `npm start` 后 `http://127.0.0.1:4317` 正常返回看板页面，`/api/board/status` 正常。
- [ ] `npm test` 跑完根、各工作区、插件全部测试且全绿；迁移后为 65（根+工作区）+6（插件），
      等于迁移前 71 减去随 `agent/` 删除的 6 个根测试；`agent/test` 10 个随目录删除。
- [ ] `npm run build` 产出 `apps/server/public`，`npm run build:desktop` 产出 `apps/desktop/ui`。
- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 仍通过。
- [ ] `apps/desktop/package-portable.ps1` 在迁移后路径下可执行并产出同名 EXE 包。
- [ ] `grep` 全仓无残留的旧结构引用（`../web/`、`../server/`、`../shared/`、`../../../tests/`、
      `desktop/ui/` 旧源码路径、`web/package-lock.json`、`agent/` 运行时引用）。
- [ ] CI 工作流只调用根脚本，缓存路径与新 lockfile 一致。
- [ ] 文档与 spec 中不存在指向旧目录的失效链接/命令；README、`docs/`、`plugins/README.md`、
      各应用 README 与 `.trellis/spec/{backend,frontend,guides}` 全部按新结构更新。
- [ ] 迁移完成后旧目录 `server/`、`web/`、`shared/`、`desktop/`、`agent/`、`tests/` 均不存在
      （含空目录残留）。

## Out of Scope

- 不引入第三方构建编排（turbo/nx/lerna）、发布流水线或版本管理策略（changesets）。
- 不改变服务端运行时架构、API、数据库 schema、插件协议。
- 不重写 Rust 桌面端；删除 Node `agent/` 只移除已无消费方的旧实现，不做功能移植。
- 不重写前端/服务端业务代码，仅移动与改 import/配置。
- 不做 Git 历史拆分（不拆子仓库、不引入 submodule）。

## Risks

- 存在进行中的任务 `11-12-desktop-web-shadcn-unification`（`in_progress`，分支
  `codex/rust-desktop-agent-single-exe`，工作区有未提交改动，涉及 `web/*`、`desktop/*`）。
  结构调整与其改动路径冲突，必须约定先后顺序（建议等其完成后从最新代码开始）。
- 移动 `tests/helpers/*` 会同时影响根测试与插件测试的相对引用，需要一次性改完。
- 插件 SDK 的引用方式决定外部插件兼容性；`plugins/` 本身是运行时可放置目录，不能强制它
  依赖工作区安装。
- 删除 Node agent 会失去 6 个 server↔Node 客户端集成测试的覆盖；客户端侧回归由
  `desktop/src-tauri` 的 cargo 测试承接，服务端侧 `team-*` 测试保留。

## Open Questions（已解决）

- Q1（已确认）：目录布局采用 `apps/` + `packages/` 分离；本任务在 11-12 完成后从最新代码开始。
- Q2（已确认）：运行时跨包引用采用相对仓库根路径，不采用 workspace 包名（零安装部署约束）；
  详见 R4 与 design.md。
