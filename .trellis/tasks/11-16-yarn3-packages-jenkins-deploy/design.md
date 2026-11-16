# 技术设计：yarn 3.5 + packages 单层工作区 + Jenkins 镜像部署

基线：`main` @ `5c05b39`。本设计只搬目录、换包管理器、对齐 Jenkins 命令契约，不改服务端/前端/Rust 业务代码。

## 1. 目标布局

```text
trellis-board/
├─ package.json              # workspaces: ["packages/*"]，packageManager: yarn@3.5.0
├─ yarn.lock                 # 唯一锁文件（删除 package-lock.json）
├─ .yarnrc.yml               # nodeLinker: node-modules + 内网 registry + yarnPath
├─ .yarn/releases/yarn-3.5.0.cjs
├─ .env                      # 入库，首行 node_version=24
├─ Dockerfile / .dockerignore
├─ packages/
│  ├─ server/    # @trellis-board/server（原 apps/server）
│  ├─ web/       # @trellis-board/web（原 apps/web）
│  ├─ desktop/   # @trellis-board/desktop（原 apps/desktop，含 src-tauri）
│  ├─ shared/
│  └─ test-support/
├─ plugins/  scripts/  docs/  config/  design/
└─ .trellis/  .github/
```

`apps/` 目录迁移后不再存在。`packages/server`、`packages/web`、`packages/desktop` 与原来同深度，
因此以下**不需要改**：

- `packages/server/env-file.js`：`repoRoot = path.resolve(serverDir,'../..')`；
- `packages/server/config.js`、`packages/server/index.js` 的 `serverDir`/`publicDir`；
- `packages/web/vite.config.ts` 的 `outDir: path.resolve(rootDir,'../server/public')`；
- `packages/web/vite.desktop.config.ts` 的 `../desktop/ui`、`tsconfig` 的 `@shared` 别名；
- `packages/desktop/src-tauri/tauri.conf.json` 的 `frontendDist: "../ui"`；
- 包内 `import '../x.js'` 相对引用、`@trellis-board/*` 裸包名（由 yarn workspace 链接解析）。

> 注：`packages/web/vite.config.ts`、`vite.desktop.config.ts` 在本机以加密形态落盘（node/git 可读明文），
> 本任务不改这两个文件，避免触发加密写回问题。

## 2. yarn 3.5 接入

从 `C:\projects\mdp-mcp` 原样复制：

| 来源 | 目标 | 说明 |
| --- | --- | --- |
| `.yarnrc.yml` | 根 `.yarnrc.yml` | `nodeLinker: node-modules`；`npmRegistryServer: http://npm.weintdata.cn/repository/npm-public/`；`unsafeHttpWhitelist: npm.weintdata.cn`；`yarnPath: .yarn/releases/yarn-3.5.0.cjs` |
| `.yarn/releases/yarn-3.5.0.cjs` | 同路径 | 2.1 MB，入库 |
| — | `yarn.lock` | 由 `yarn install` 生成后提交 |
| `.yarn/cache/`、`.yarn/install-state.gz` | 不入库 | 追加到 `.gitignore` |

根 `package.json` 目标脚本：

```json
{
  "packageManager": "yarn@3.5.0",
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "start": "node packages/server/index.js",
    "board": "yarn start",
    "build": "yarn workspace @trellis-board/web build",
    "build:desktop": "yarn workspace @trellis-board/web build:desktop",
    "web:dev": "yarn workspace @trellis-board/web dev",
    "desktop:build": "yarn workspace @trellis-board/desktop build",
    "desktop:package": "pwsh -File packages/desktop/package-portable.ps1",
    "release:desktop": "node scripts/release-desktop.mjs",
    "capacity": "node scripts/team-capacity-check.js",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "test": "node --test \"packages/*/test/*.test.js\"",
    "test:plugins": "node --test \"plugins/*/test/*.test.js\"",
    "test:all": "yarn test && yarn test:plugins"
  }
}
```

- `start` 直接跑 `node packages/server/index.js`：容器与零安装部署都不依赖 `yarn workspace` 解析；
  `CMD ["yarn","start"]` 满足“镜像执行 yarn start”的约定。
- 根脚本内嵌套调用一律用 `yarn ...`；脚本由 yarn 启动，`yarn` 已在 PATH（corepack 或 yarnPath）。
- 保留 `@trellis-board/shared: "*"`，yarn 会链接到本地 workspace（版本匹配）。

## 3. 路径迁移清单（代码/配置）

| 文件 | 改动 |
| --- | --- |
| `package.json` | workspaces、脚本、packageManager、engines 保持 `>=24` |
| `scripts/dev.mjs` | `webDir = <root>/packages/web`；watch `packages/server/index.js` |
| `scripts/release-desktop.mjs` | `TAURI_CONF`、`Cargo.toml`、`Cargo.lock` 改 `packages/desktop/...`；版本文件遍历只保留 `packages` 一层 |
| `packages/server/team/cli.js`、`packages/server/team/http.js` | 用户可见命令文案 `node packages/server/team/cli.js ...` |
| `packages/server/test/team-static.test.js` | 用例名与静态目录断言 |
| `packages/desktop/test/desktop-ui-build.test.js` | 所有 `apps/...` 字面量 → `packages/...` |
| `packages/test-support/fixtures/plugins/*/index.js`（17 个） | `../../../../../apps/server/plugins/sdk.js` → `../../../../../packages/server/plugins/sdk.js` |
| `plugins/acp-dispatch/test/index.test.js`、`plugins/witops-core/test/index.test.js` | `../../../apps/server/*` → `../../../packages/server/*` |
| `plugins/README.md` | 宿主 SDK 引用路径、根测试命令（yarn） |
| `.trellis/config.yaml` | `server/web/desktop` 的 path → `packages/...`；其余不变 |
| `.oxfmtrc.json` | `ignorePatterns`: `packages/server/public`、`packages/desktop/src-tauri` |
| `.gitignore` | `/packages/server/public/`、`packages/desktop/src-tauri/{target,gen}`、`packages/desktop/ui/`；yarn 产物忽略；放行 `.env` |
| `README.md`、`docs/team-operations.md`、`docs/product-prd.md`、`packages/*/README.md` | `apps/`→`packages/`、`npm run`→`yarn`、`.env` 已入库说明、Jenkins 部署段 |
| `.trellis/spec/backend/*.md`、`frontend/*.md`、`guides/*.md`（21 个） | 路径、命令、目录表同步 |

不动：`.trellis/tasks/archive/**`、`.trellis/workspace/**/journal-*.md`（历史记录）、`design/**`、
`.agents/skills/trellis-meta/**`（模板参考，非本项目路径）。

## 4. `.env`（入库）

```dotenv
node_version=24
PORT=4317
TRELLIS_BOARD_MODE=team
TRELLIS_BOARD_DATA_DIR=
TRELLIS_WATCH_DEBOUNCE_MS=400
```

- 首行严格为 `node_version=24`（LF，`.gitattributes` 已有 `* text=auto eol=lf`）。
- `packages/server/env-file.js` 用 dotenv 读取整文件；`node_version` 只是多出的键，无运行时消费方。
- `.gitignore` 的 `.env` 规则改为只忽略 `.env.*` 且放行 `.env`：
  `.env.*` 保留忽略，`.env.example` 与 `.env` 用 `!` 放行。
- 进程环境变量仍优先（dotenv 不覆盖已存在键），本机临时覆盖行为不变。

## 5. Jenkins 部署契约（不提供 Dockerfile）

镜像构建与容器编排由 Jenkins 现有部署脚本负责，仓库**不新增 Dockerfile/.dockerignore**。仓库只承诺：

- `yarn install --immutable` 在 Jenkins 的 Node 24 环境可复跑（`.yarnrc.yml` 指向内网 registry）；
- `yarn build` 产出 `packages/server/public`，与 `packages/server/index.js` 的静态目录一致；
- `yarn start` 直接启动团队版服务：读取 `.env` 的 `PORT`（默认 4317）与 `TRELLIS_BOARD_MODE=team`，
  数据目录由 `TRELLIS_BOARD_DATA_DIR` 指定并挂载；
- `.env` 入库且首行 `node_version=24`，Jenkins 读取后切换 Node 版本。

根 `start` 用 `node packages/server/index.js` 而不是 `yarn workspace ...`，容器内不依赖 workspace 解析；
Jenkins 侧仍以 `yarn start` 作为启动命令。

## 6. GitHub Actions

保持 job 结构/触发/发布行为不变，只做移动后必然失效的最小替换：

- `apps/` → `packages/`（tauri 配置、Cargo manifest、working-directory、artifact 路径、盖章路径）；
- `npm ci` → `corepack enable` + `yarn install --immutable`；`npm run x` → `yarn x`；
  缓存从 `package-lock.json` 改 `yarn.lock`（`cache: yarn`）。
- `node-version: 24` 维持硬编码（`.env` 的 `node_version` 供 Jenkins 读取）。

## 7. 验证

| 步骤 | 命令 | 期望 |
| --- | --- | --- |
| 安装 | `node .yarn/releases/yarn-3.5.0.cjs install` | 生成 `yarn.lock`，无报错 |
| 幂等 | `... install --immutable` | 通过 |
| 构建 | `node .yarn/releases/yarn-3.5.0.cjs build` | `packages/server/public/index.html` 等产物 |
| 启动 | `node .yarn/releases/yarn-3.5.0.cjs start` + `curl /api/board/status` | 200 JSON |
| 测试 | `... test:all` | 65 + 6 全绿 |
| 格式 | `... format:check` | 通过（或对改动文件跑 `oxfmt`） |
| 残留 | `git grep -n "apps/" -- ':!.trellis/tasks/archive' ':!**/journal-*.md' ':!.agents' ':!design'` | 无命中 |

本机无 docker、无 Rust：镜像与桌面打包不在本任务验证范围，Jenkins/CI 侧按现有脚本执行。

## 8. 取舍与回滚

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| nodeLinker | node-modules | 与 mdp-mcp 一致；vite/cargo/plugin 子进程与现有零安装脚本都按实体 `node_modules` 工作 |
| 锁文件 | 只留 `yarn.lock` | yarn 3.5 不维护 `package-lock.json`，双锁文件必然漂移 |
| `start` 实现 | `node packages/server/index.js` | 避免镜像启动依赖 `yarn workspace` 解析；外部仍是 `yarn start` |
| GHA 改动幅度 | 仅路径 + 安装命令 | 用户要求 GHA 流程不变；不改就会因目录迁移直接失败 |
| 镜像定义 | 不进仓库 | Jenkins 部署脚本已包含 Dockerfile/镜像步骤，仓库重复维护会漂移 |

回滚：`git reset --hard <迁移前提交>` + `git clean -fd` 清理新生成的 `yarn.lock`/`node_modules`；
无数据迁移，`TRELLIS_BOARD_DATA_DIR` 下的 SQLite 不受影响。
