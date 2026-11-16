# 执行计划：yarn 3.5 + packages 迁移

按顺序执行；每个检查点先验证再进入下一步。提交需用户明确授权后再做（本计划不含自动 commit）。

## CP1 目录迁移

1. `git mv apps/server packages/server`、`git mv apps/web packages/web`、`git mv apps/desktop packages/desktop`，删除空 `apps/`。
2. 根 `package.json`：`workspaces: ["packages/*"]`、脚本改 yarn（见 design §2）、加 `packageManager: "yarn@3.5.0"`。
3. `scripts/dev.mjs`、`scripts/release-desktop.mjs` 路径改 `packages/`；release 的版本文件只遍历 `packages/*`。
4. `.oxfmtrc.json`、`.gitignore`、`.trellis/config.yaml` 路径改 `packages/`。

验证：`git status` 显示 rename；`node -e "require('./package.json')"` 可解析；`ls apps` 不存在。

## CP2 yarn 3.5 接入

1. 复制 `C:\projects\mdp-mcp\.yarnrc.yml` → 根；复制 `.yarn/releases/yarn-3.5.0.cjs`。
2. `.gitignore` 追加 `.yarn/cache/`、`.yarn/install-state.gz`、`.pnp.*`。
3. 删除 `package-lock.json`；`node .yarn/releases/yarn-3.5.0.cjs install` 生成 `yarn.lock`。
4. `node .yarn/releases/yarn-3.5.0.cjs install --immutable` 复跑通过。

验证：`git ls-files .yarn` 仅 `releases/yarn-3.5.0.cjs`；`git status` 无 `package-lock.json`。

## CP3 `.env` 入库

1. 新建根 `.env`：首行 `node_version=24`，后接 `PORT=4317`、`TRELLIS_BOARD_MODE=team`、
   `TRELLIS_BOARD_DATA_DIR=`、`TRELLIS_WATCH_DEBOUNCE_MS=400`。
2. `.gitignore`：`.env.*` 忽略、`!.env` 与 `!.env.example` 放行。
3. `.env.example` 增加 `node_version=24` 与“`.env` 已入库”的说明；README `.env` 段落同步。

验证：`git check-ignore -v .env` 无输出；`head -1 .env` 为 `node_version=24`；
`node -e` 调 `loadProjectEnv()` 后 `process.env.PORT` 为 4317、`TRELLIS_BOARD_MODE` 为 team。

## CP4 代码/测试/插件路径

1. `packages/server/team/{cli.js,http.js}` 文案路径改 `packages/server`。
2. `packages/server/test/team-static.test.js`、`packages/desktop/test/desktop-ui-build.test.js` 所有 `apps/` 字面量改 `packages/`。
3. `packages/test-support/fixtures/plugins/*/index.js` 17 处 SDK 相对路径改 `packages/server/plugins/sdk.js`。
4. `plugins/acp-dispatch/test/index.test.js`、`plugins/witops-core/test/index.test.js` 宿主导入改 `packages/server/*`。
5. `plugins/README.md` 路径与命令。

验证：`node .yarn/releases/yarn-3.5.0.cjs test:all` 全绿（65 + 6）。

## CP5 文档与 spec

1. `README.md`、`docs/team-operations.md`、`docs/product-prd.md`、`packages/{server,web,desktop}/README.md`：
   `apps/`→`packages/`、npm 命令→yarn、`.env` 入库说明、Jenkins 部署段（`yarn build` → 镜像 → `yarn start`）。
2. `.trellis/spec/backend/*.md`、`frontend/*.md`、`guides/*.md` 路径/命令同步。
3. 不动归档任务、journal、`design/`、`.agents/skills/trellis-meta/**`。

验证：`git grep -n "apps/" -- ':!.trellis/tasks/archive' ':!**/journal-*.md' ':!.agents' ':!design'` 无命中。

## CP6 CI（不新增镜像文件）

1. `.github/workflows/windows.yml`：路径 `apps/`→`packages/`；`npm ci`→`corepack enable` + `yarn install --immutable`；
   `npm run x`→`yarn x`；删除两处 `cache: npm` / `cache-dependency-path: package-lock.json`
   （Yarn 2+ 的缓存由 yarn 自己维护，setup-node 的 yarn 缓存不可靠，故不加 `cache: yarn`）。
2. 仓库不新增 `Dockerfile`/`.dockerignore`/`Jenkinsfile`：镜像由 Jenkins 部署脚本构建，仅依赖 `yarn build` + `yarn start`。

验证：workflow YAML 可解析且 job/触发/发布步骤未变；`git status` 无新增镜像文件。

## CP7 全量验收

1. `node .yarn/releases/yarn-3.5.0.cjs build` → `packages/server/public/index.html`。
   本机 `tsc -b` 报 `TS1127 Invalid character`：`packages/web` 的若干源文件（`src/api/*.ts`、
   `src/hooks/*.ts`、`src/lib/*.d.ts`、`vite*.config.ts`）在磁盘上是 DLP 加密态，node 读取时由
   白名单解密，而 TypeScript 7 是原生二进制（`typescript/lib/getExePath.js`），读到密文。
   迁移前同样失败，与本次改动无关；改用 node 侧的 `vite build` 验证产物落盘。
2. `... start`（`TRELLIS_BOARD_MODE=standalone`），`curl http://127.0.0.1:4399/api/board/status` 与 `/`。
   team 模式启动需要 `init-admin` 的交互式 TTY 输密码，无法在无人环境验证，按既有运维前置处理。
3. `... test:all` 全绿。
4. `format:check` 不可作为门禁：HEAD 上未改动的文件同样被判为未格式化（oxfmt 与本机加密态/历史
   漂移），且 `format` 会把加密文件写成密文回写损坏，故不执行 `format`。
5. 残留 `apps/` 扫描（排除归档任务、journal、`design/`、`.agents/`）；`git status` 汇总改动。

产物：实现报告写明验证结果、未实测项（Jenkins 镜像构建、cargo/tauri 打包）与原因。
