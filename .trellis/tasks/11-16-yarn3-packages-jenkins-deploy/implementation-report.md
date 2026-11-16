# 实现报告：yarn 3.5 + packages 迁移

分支 `main`，工作树未提交（按用户规则等显式授权）。

## 变更范围

| 区域 | 变更 |
| --- | --- |
| 目录 | `apps/{server,web,desktop}` → `packages/*`，删除空 `apps/`；`packages/{shared,test-support}` 未动 |
| 依赖 | 根 `package.json` 加 `packageManager: yarn@3.5.0`、`workspaces: ["packages/*"]`、脚本改 yarn；新增 `.yarnrc.yml`、`.yarn/releases/yarn-3.5.0.cjs`、`yarn.lock`；删除 `package-lock.json` |
| 配置 | `.gitignore`（`/packages/server/public/`、`.yarn/cache/`、`.yarn/install-state.gz`、`.pnp.*`、`!.env`）、`.oxfmtrc.json`、`.trellis/config.yaml` |
| 部署 | 根 `.env` 入库（首行 `node_version=24`）；`.env.example` 同步；README 新增「Jenkins 部署」段 |
| 脚本 | `scripts/dev.mjs`、`scripts/release-desktop.mjs` 路径改 `packages/` |
| 代码 | `packages/server/team/{cli.js,http.js}` 文案、两个测试文件路径断言、17 个插件 fixture、两个插件测试的宿主导入 |
| CI | `.github/workflows/windows.yml`：`apps/`→`packages/`、`npm ci`→`corepack enable`+`yarn install --immutable`、`npm run x`→`yarn x`、移除两处 `cache: npm` |
| 文档/spec | README、docs/*、packages/*/README、20 个 `.trellis/spec/**/*.md` 的路径与 npm→yarn 命令 |

## 验证结果（已实测）

- `yarn install --immutable`：1.4s 通过（首次 `--no-immutable` 生成 `yarn.lock`，377 包）。
- `yarn test:all`：`yarn test` 通过后继续执行 `yarn test:plugins`，plugins 66 项 / 65 通过 / 1 跳过 / 0 失败，退出码 0。
  - 首次全量跑（迁移后、修 CRLF 前）492 项：489 通过 / 1 失败 / 2 跳过；失败为 `workflow job node-tests missing`
    （Python 回写把 `windows.yml` 变成 CRLF，测试按 `\n  <job>:` 切分）。25 个被误伤文件已按 HEAD 恢复 LF，
    之后 `node --test packages/desktop/test/desktop-ui-build.test.js` 7/7 通过。
- `yarn start`（`TRELLIS_BOARD_MODE=standalone`、`PORT=4399`、数据目录在仓库外）：`GET /api/board/status` → 200，`GET /` → 200 且返回构建后的 SPA HTML。
- 前端产物：在 `packages/web` 内执行 `node ../../node_modules/vite/bin/vite.js build`，1.5s 完成，
  写入 `packages/server/public`（`index.html`、`login`、`admin`、`main-DFxgmRqY.js` 1.26MB）。
- `git check-ignore .env` → 命中 `!.env` 放行规则；`head -1 .env` = `node_version=24`。
- `git check-ignore`：`.yarn/cache`、`.yarn/install-state.gz` 被忽略，`.yarn/releases/yarn-3.5.0.cjs` 不被忽略。
- 无 `Dockerfile` / `.dockerignore` / `Jenkinsfile`。
- 残留 `apps/` 扫描（排除 `.trellis/tasks/**`、`.trellis/workspace/**`、`design/`、`.agents/`、构建输出）：
  仅 `.agents/skills/trellis-meta/references/customize-local/change-spec-structure.md:64,66`（PRD 明确排除的 trellis-meta 文档）。

## 未实测项与原因

- `yarn build` 的 `tsc -b` 阶段：`TS1127 Invalid character`，`src/api/{admin,board}.ts`、`src/hooks/{useAdminProjects,useBoard}.ts`、
  `src/lib/{admin-shared.ts,project-rail-association.d.ts,refresh-coordinator.d.ts,team-client.d.ts}`、`vite.config.ts`、
  `vite.desktop.config.ts` 在磁盘为 DLP 密文（Python 读到 `\xe0\xa8\x91...`，node 读到明文），TypeScript 7 是原生二进制
  （`node_modules/typescript/lib/getExePath.js` 解析出平台可执行文件），绕过 node 白名单。迁移前的同一份源码同样失败，
  与本次改动无关；用 node 侧 `vite build` 证明产物路径与构建流程正确。
- `yarn format:check`：37 个文件报未格式化，其中 `plugins/witops-core/util.js` 等文件在 `git status` 中未修改
  （内容等于 HEAD），`git show HEAD:plugins/witops-core/util.js` 单独跑 `oxfmt --check` 同样失败 ⇒ 该门禁在本机早已不通过。
  且 `yarn format` 会把加密文件按密文回写造成损坏，故不执行。
- team 模式启动：`node packages/server/team/cli.js init-admin` 需要两次交互式密码（非 TTY 时第二次读 stdin 因流已结束而挂起），
  无人环境无法完成首管理员初始化，按既有运维前置处理；启动链路已用 standalone 模式验证。
- Jenkins 镜像构建、`cargo`/`tauri` 打包：本机无 Docker/Rust 工具链，未跑。

## 风险与后续

- `.env` 入库后 `PORT`、`TRELLIS_BOARD_MODE=team` 成为仓库默认值；`TRELLIS_BOARD_DATA_DIR` 留空，由部署机注入，部署机需保证该目录在源码工作树之外（否则启动报 `TRELLIS_BOARD_DATA_DIR 必须位于源码工作树之外`）。
- 本机 `yarn` 仍是 1.22.22（corepack 在 fnm 下报 `$'\r': command not found`），所有验证均通过 `node .yarn/releases/yarn-3.5.0.cjs` 执行；CI/Jenkins 需要 `corepack enable`（workflow 已加该步骤）。
