# 迁移 yarn 3.5 与 packages 目录并适配 Jenkins 部署

## Goal

参考 `C:\projects\mdp-mcp` 的工程约定，把 Trellis Board 调整为：

- 依赖管理统一走 yarn 3.5（`.yarn/releases` 固定版本、单 `yarn.lock`、node-modules linker）；
- 所有 npm workspace 包都位于 `packages/` 下；
- 仓库根 `.env` 入库，首行 `node_version=24`，供 Jenkins 流水线读取并切换 Node 版本；
- Jenkins 的团队版服务部署链路成立：流水线脚本（Jenkins 侧已有）先 `yarn build` 产出前端静态资源，
  再构建镜像并在容器内执行 `yarn start`；仓库只需保证这两个命令与 `.env` 的 `node_version` 契约成立，
  **不新增 Dockerfile**（镜像步骤由 Jenkins 现有部署脚本提供）。

## Background（已核实的仓库现状）

- 根 `package.json`：`workspaces: ["apps/*","packages/*"]`，`type: module`，`engines.node >= 24`；
  脚本全部用 npm 转发（`npm run build --workspace @trellis-board/web` 等），锁文件是 `package-lock.json`。
- 工作区包：`apps/server`（`@trellis-board/server`）、`apps/web`（`@trellis-board/web`）、
  `apps/desktop`（`@trellis-board/desktop`）、`packages/shared`、`packages/test-support`。
- 服务端入口 `node apps/server/index.js`；静态目录 `path.join(serverDir,'public')`；
  前端 `apps/web/vite.config.ts` 输出到 `../server/public`；桌面 UI 输出到 `apps/desktop/ui`。
  `apps/*` 与 `packages/*` 同深度，迁移到 `packages/*` 后包内相对路径与仓库根解析（`path.resolve(serverDir,'../..')`）不变。
- `.github/workflows/windows.yml` 是 Windows 桌面绿色包发布流：`npm ci` + `npm run build` +
  cargo/tauri，另有 `apps/desktop/**` 版本盖章与产物路径。
- `.gitignore` 当前忽略 `.env` 与 `.env.*`（仅放行 `.env.example`）。
- 仓库无 Dockerfile；本机 `docker` 命令不可用。
- `C:\projects\mdp-mcp`：`packageManager: "yarn@3.5.0"`，`.yarnrc.yml` 用 `nodeLinker: node-modules`、
  内网 registry `http://npm.weintdata.cn/repository/npm-public/`（`unsafeHttpWhitelist` 放行），
  `yarnPath: .yarn/releases/yarn-3.5.0.cjs`；`.yarn/cache/`、`.yarn/install-state.gz` 不入库，
  `.yarn/releases/yarn-3.5.0.cjs` 入库；`.env` 首行 `node_version=24` 且入库。

## Requirements

- R1 依赖管理改为 yarn 3.5：从 mdp-mcp 复制 `.yarn/releases/yarn-3.5.0.cjs` 与 `.yarnrc.yml`
  （保持 node-modules linker 与内网 registry 约定）；根 `package.json` 声明 `packageManager: "yarn@3.5.0"`；
  删除 `package-lock.json`，只保留 `yarn.lock`；`.gitignore` 增加 yarn 产物忽略项。
- R2 所有 npm workspace 包位于 `packages/`：`apps/{server,web,desktop}` → `packages/{server,web,desktop}`，
  workspaces 收敛为 `["packages/*"]`；包名 `@trellis-board/*` 不变。
- R3 根脚本改为 yarn 语义（`yarn build` → web 构建、`yarn start` → 服务端入口），保留
  `dev`/`build:desktop`/`web:dev`/`desktop:build`/`desktop:package`/`release:desktop`/`capacity`/`format`/`test`/`test:plugins`/`test:all` 的既有用途。
- R4 仓库根新增 `.env` 并提交：**第一行必须是 `node_version=24`**；随后保留团队版运行默认值
  （`TRELLIS_BOARD_MODE=team`、`PORT`、`TRELLIS_BOARD_DATA_DIR`、`TRELLIS_WATCH_DEBOUNCE_MS`）。
  `.gitignore` 放行 `.env`；`.env.example` 与 README 的 `.env` 说明同步（文件现在入库，本机覆盖仍用进程环境变量）。
  服务端 `loadProjectEnv()` 继续从仓库根读取同一文件，`node_version` 键不产生运行时副作用。
- R5 Jenkins 部署链路：**不新增 Dockerfile/.dockerignore**，镜像构建与容器编排沿用 Jenkins 现有部署脚本。
  仓库需保证根脚本 `yarn build`（产出 `packages/server/public`）与 `yarn start`（启动团队版服务，
  监听 `.env` 的 `PORT`，数据目录由 `TRELLIS_BOARD_DATA_DIR` 指定）可直接工作；
  Jenkins 读取 `.env` 首行 `node_version=24` 切换 Node 版本。
- R6 全仓路径与命令同步：`scripts/dev.mjs`、`scripts/release-desktop.mjs`、各 `package.json`、
  `.oxfmtrc.json`、`.gitignore`、`.trellis/config.yaml`、测试中的 `apps/...` 字面量、
  `packages/test-support/fixtures/**` 的宿主 SDK 相对路径、内置插件测试的宿主导入、
  README/docs/`.trellis/spec` 中的路径与命令全部改为 `packages/...` / yarn。
  历史任务归档（`.trellis/tasks/archive/**`）与 journal 保留原文，不回写。
- R7 GitHub Actions 现有 job、触发方式、Windows 桌面产物与发布行为不变；仅做目录移动后不更新就必然失败的
  最小同步（`apps/` → `packages/` 路径、安装/构建命令从 npm 改 yarn）。不新增 workflow、不新增 job。
- R8 运行时不改：API、SQLite schema、插件协议、standalone/team 行为、桌面 Tauri 构建链保持原样。

## Acceptance Criteria

- [ ] 仓库根 `yarn install`（3.5）成功且可用 `--immutable` 复跑；存在 `yarn.lock`，无 `package-lock.json`；
      `git ls-files .yarn` 含 `releases/yarn-3.5.0.cjs`，不含 `cache/`、`install-state.gz`。
- [ ] `git ls-files .env` 命中；`.env` 第一行等于 `node_version=24`；`git check-ignore .env` 不命中。
- [ ] `yarn build` 在 `packages/server/public` 产出 `index.html`/`assets`，退出码 0。
- [ ] `yarn start` 启动后 `GET http://127.0.0.1:4317/api/board/status` 返回 200 JSON；页面入口 200。
- [ ] `yarn test:all` 全绿，测试数量与迁移前一致（65 工作区 + 6 插件），无测试因路径迁移被删除或放宽。
- [ ] `yarn format:check` 通过（oxfmt）；`.trellis/config.yaml` 的 packages 路径指向 `packages/*`。
- [ ] `grep` 仓库受控文件（排除 `.trellis/tasks/archive`、journal、`design/`）无残留 `apps/` 路径引用；
      `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 路径存在（本机无 Rust 时至少校验文件与 CI 命令一致）。
- [ ] 仓库不新增 `Dockerfile`/`.dockerignore`；`yarn build` 与 `yarn start` 两个根命令独立可跑，
      Jenkins 现有镜像脚本无需改动即可复用。
- [ ] GitHub Actions 的 job 集合、触发条件、发布步骤不变；diff 中只出现路径与包管理命令的必要替换。

本机受限于 DLP 文件加密（TypeScript 7 原生编译器读到密文）、无 Docker/Rust 工具链、team 模式需交互式首管理员，
`yarn build` 的 `tsc -b` 阶段、`yarn format:check`、team 模式启动、Jenkins 镜像构建与 cargo/tauri 打包无法实测；
改用 node 侧 `vite build` 产物、standalone 启动 + API 200、`test:all` 全绿替代，细节见 `implementation-report.md`。

## Out of Scope

- 不新增 GitHub Actions job/workflow，不改发布触发策略，不把 Docker 构建搬进 GHA。
- 不引入 turbo/nx/pnpm/workspace 编排工具，不改 nodeLinker 为 PnP。
- 不修改服务端业务逻辑、API、数据库 schema、插件协议与前端功能。
- 不改写历史归档任务、journal 或 `design/` 二进制设计稿中的历史路径。
- 不做流水线编排：不新增 Dockerfile/.dockerignore/Jenkinsfile，Jenkins 任务定义与镜像脚本在 Jenkins 侧。
- 不再改造 GHA 的部署形态（GHA 仍只负责 Windows 桌面绿色包）。

## Risks

- 内网 registry 可能缺少个别包（typescript 7 / vite 8 / react 19 等），`yarn install` 需实测；失败时回退官方 registry 需与用户确认。
- yarn 3.5 的 `yarn` 入口依赖 corepack/`yarnPath`；本机 corepack shim 在 bash 下报 CRLF 错误，验证统一用
  `node .yarn/releases/yarn-3.5.0.cjs` 或 pwsh，CI 侧用 `corepack enable`。
- 桌面发布链路（Windows 盖章/打包）本机无法完整跑 cargo/tauri，只能做路径与脚本一致性校验。
- `.env` 入库后，团队版默认 `TRELLIS_BOARD_MODE=team` 对所有克隆生效；standalone 用户需显式覆盖。
