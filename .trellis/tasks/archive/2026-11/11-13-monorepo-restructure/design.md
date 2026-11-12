# Monorepo 结构设计

基线：`team-board` 上 11-12 完成后的最新提交。本设计只移动/删除文件、改解析路径与配置，
不改服务端业务逻辑、API、数据库、插件协议。

## 1. 目标结构（3 个应用包 + 2 个支撑包）

```
trellis-board/
├─ package.json                 # workspaces 根，统一脚本/锁文件
├─ package-lock.json            # 唯一锁文件
├─ apps/
│  ├─ server/                   # @trellis-board/server
│  │  ├─ index.js               # 入口：node apps/server/index.js
│  │  ├─ public/                # web 构建产物（gitignore）
│  │  ├─ team/  plugins/  test/
│  ├─ web/                      # @trellis-board/web（React/Vite）
│  │  ├─ src/  desktop/  test/  index.html …
│  └─ desktop/                  # @trellis-board/desktop（Tauri v2）
│     ├─ src-tauri/  ui/（构建产物）  test/  package-portable.ps1
├─ packages/
│  ├─ shared/                   # @trellis-board/shared（含 zip.js）
│  └─ test-support/             # @trellis-board/test-support（helpers/fixtures）
├─ plugins/                     # 运行时可放置目录，路径契约不变
├─ scripts/                     # 仓库级运维脚本（dev.mjs、check-boundaries.mjs 等）
├─ docs/  config/  design/
└─ .trellis/  .github/
```

`apps/*` 与 `packages/*` 声明为 workspace（共 5 个）；`plugins/`、`scripts/` 不是包。
迁移完成后 `server/`、`web/`、`shared/`、`desktop/`、`agent/`、`tests/` 全部不存在，
不留空目录（`git` 不跟踪空目录，但本地/部署副本必须删除）。

**删除 `agent/`**：桌面端 11-12 已用 Rust 进程内实现替换 Node sidecar，sidecar 是 `agent/*`
的唯一运行时消费者；CI 不再打包、README/docs 不再引用。保留的消费方只有 6 个测试与
`server/team/workspace-templates.js` 的 `readZipEntries`。因此：

- `agent/zip.js` → `packages/shared/zip.js`（纯 `node:fs/path/zlib`，无业务耦合）；
- 其余 `agent/**`（含 `cli.js`、`windows/`、`package-agent.ps1`、`trellis-agent.cmd`、
  `README.md`、10 个测试）整体删除；
- 删除依赖 agent 模块的 6 个根测试：`desktop-realtime-apply`、`workspace-bootstrap`、
  `workspace-client-flow`、`team-core`、`team-realtime-sync`、`team-events`。

## 2. 工作区包矩阵

| 包名 | 路径 | type | scripts | 说明 |
| --- | --- | --- | --- | --- |
| `@trellis-board/server` | apps/server | module | `start` | 无第三方运行时依赖 |
| `@trellis-board/web` | apps/web | module | `dev` `build` `build:desktop` `lint` `preview` `test` | 依赖装根 `node_modules` |
| `@trellis-board/desktop` | apps/desktop | module | `build`（`cargo tauri build`）`test`（cargo test） | 无 npm 依赖 |
| `@trellis-board/shared` | packages/shared | module | — | 纯 ESM，无依赖 |
| `@trellis-board/test-support` | packages/test-support | module | — | 私有，测试 helpers/fixtures |

包名只用于 npm 工具链（workspace 脚本转发、依赖图、发布元数据），**不作为运行时 import 说明符**。

## 3. 模块解析规则（关键取舍）

约束：部署方式是把仓库复制到目标机后直接 `node apps/server/index.js`，没有 `npm install`。
实测 Node 24：

- `imports` 子路径映射目标禁止逃出包 → `ERR_INVALID_PACKAGE_TARGET`；
- bare specifier（`@trellis-board/shared`）依赖 `node_modules` symlink，零安装下不可用。

因此：

| 区域 | 规则 | 示例 |
| --- | --- | --- |
| apps/server、plugins、scripts、packages/test-support | 相对仓库根的显式路径 | `apps/server/actions.js` → `../../packages/shared/slug.js`；`plugins/<id>/index.js` → `../../apps/server/plugins/sdk.js` |
| apps/web（构建期） | Vite alias + tsconfig paths | `@shared/*` → `../../packages/shared/*` |
| 包内引用 | 相对路径不变 | `apps/server/team/http.js` → `../database.js` |

配套防回归：`npm run check:boundaries` 运行 `scripts/check-boundaries.mjs`，扫描
`apps/server/**/*.js`、`plugins/**/*.js`、`scripts/**/*.js`、`packages/test-support/**/*.js`，命中以下模式即失败：
`from '@trellis-board/`、`from 'shared/`、`from '../../server/`、`from '../shared/`、
`from '../../../tests/`、`from '../agent/`。

插件 SDK 不单独成包，继续随宿主放在 `apps/server/plugins/{sdk.js,protocol.js}`，server 内部引用
不变。外部插件（`plugins/` 下自建）只需把 `../../server/plugins/sdk.js` 改为
`../../apps/server/plugins/sdk.js`；`plugins/README.md` 增加迁移说明，不保留旧路径转发文件。

## 4. 路径契约变更表

| 位置 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 服务端入口 | `node server/index.js` | `node apps/server/index.js` |
| `serverDir` | `server/` | `apps/server/` |
| `appDir`（插件根） | `path.resolve(serverDir,'..')` = 仓库根 | `path.resolve(serverDir,'../..')` = 仓库根 |
| 静态目录 | `<root>/public` | `apps/server/public`（`join(serverDir,'public')`） |
| scan worker / 文件夹选择器 | 同 serverDir | 不变（相对 serverDir） |
| 插件默认模块 | `./plugins/<id>/index.js`（相对 appDir） | 不变（appDir 仍是仓库根） |
| web outDir | `../public` | `../server/public`（相对 apps/web） |
| desktop UI outDir | `../desktop/ui` | `../desktop/ui`（相对 apps/web，落到 apps/desktop/ui，表达式不变） |
| `@shared` alias | `../shared` | `../../packages/shared`（两个 vite config 与 tsconfig.app.json 同步） |
| dev.mjs webDir | `<root>/web` | `<root>/apps/web`；vite 入口 `<root>/node_modules/vite/bin/vite.js` |
| .gitignore | `/public`、`desktop/ui/` | `/apps/server/public/`、`/apps/desktop/ui/` |
| .oxfmtrc ignorePatterns | `public`、`desktop/src-tauri` | `apps/server/public`、`apps/desktop/src-tauri` |

`apps/server/index.js` 的静态文件防穿越逻辑（`path.resolve(publicDir, '.'+requested)` 前缀校验）
保持不变，只改 `publicDir` 计算。

## 5. 测试与 fixtures

| 归属 | 数量 | 根路径写法 |
| --- | --- | --- |
| apps/server/test | 50 | 仓库根 = `new URL('../../..', import.meta.url)`；含 `task-space-duplicate-cleanup`（跨 scripts/server/shared） |
| apps/web/test | 10 | 包内相对 import（`../src/lib/...`） |
| packages/shared/test | 4 | `../slug.js` 等包内相对 |
| apps/desktop/test | 1 | 仓库根 = `new URL('../../..', import.meta.url)` |
| packages/test-support | — | helpers + fixtures；`appDir = path.resolve(dirname,'../..')` 仍为仓库根 |
| plugins/*/test | 6（不变） | helpers 改 `../../../packages/test-support/*`；宿主导出改 `../../../apps/server/*` |
| 删除 | 16 | `agent/test` 10 个 + 依赖 agent 的 6 个根测试（见 §1） |

`process.cwd()` 仍以仓库根为前提（根脚本执行），但新移动的测试统一改为基于
`import.meta.url` 求根。fixture 的 `module` 路径由 `./tests/fixtures/plugins/<n>/index.js`
改为 `./packages/test-support/fixtures/plugins/<n>/index.js`。

根脚本测试发现：

```json
"test": "node --test \"apps/*/test/*.test.js\" \"packages/*/test/*.test.js\"",
"test:plugins": "node --test \"plugins/*/test/*.test.js\"",
"test:all": "npm test && npm run test:plugins"
```

迁移前 71 个根测试 − 6 个 agent 相关 = 65（50 server + 10 web + 4 shared + 1 desktop）；
插件 6 个不变。根 `tests/` 目录删除。

## 6. 打包链

只保留桌面端打包：`apps/desktop/package-portable.ps1` 全部路径基于 `$PSScriptRoot`，移动目录
即可用；根脚本 `desktop:package` 转发。`tauri.conf.json` 的 `frontendDist: "../ui"` 不变。
`dist/` 不再有 agent ZIP 产物；`.gitignore` 保留 `dist/` 以兼容旧工作区。

## 7. 根脚本

```json
{
  "dev": "node scripts/dev.mjs",
  "start": "node apps/server/index.js",
  "board": "npm start",
  "build": "npm run build --workspace @trellis-board/web",
  "build:desktop": "npm run build:desktop --workspace @trellis-board/web",
  "web:dev": "npm run dev --workspace @trellis-board/web",
  "desktop:build": "npm run build --workspace @trellis-board/desktop",
  "desktop:package": "pwsh -File apps/desktop/package-portable.ps1",
  "capacity": "node scripts/team-capacity-check.js",
  "check:boundaries": "node scripts/check-boundaries.mjs",
  "format": "oxfmt .",
  "test": "node --test \"apps/*/test/*.test.js\" \"packages/*/test/*.test.js\"",
  "test:plugins": "node --test \"plugins/*/test/*.test.js\"",
  "test:all": "npm test && npm run test:plugins"
}
```

`npm run build:desktop` 只构建 UI；`npm run desktop:build` 才调用 cargo/Tauri，避免开发机
缺 Rust 时根构建失败。

## 8. CI（.github/workflows/windows.yml）

- `node-tests`：setup-node cache 只指向根 `package-lock.json`；`npm ci`；`npm run build`；
  `npm run check:boundaries`；`npm run test:all`。
- `desktop-build`：`npm ci`；`npm run build`；`npm run build:desktop`；
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- 删除 `npm ci --prefix web`、第二 lockfile 缓存键与 `node --test agent/test/*.test.js`。

## 9. 文档 / 规范 / Trellis 配置

迁移属于结构变更，文档与 spec 必须同一次提交内更新，不允许留到后续任务。

- 顶层文档：`README.md`（命令、目录树、插件 SDK 路径）、`docs/team-operations.md`
  （`node apps/server/index.js`、`node apps/server/team/cli.js init-admin`）、
  `plugins/README.md`（插件 SDK 引用 `../../apps/server/plugins/sdk.js`、测试命令）、
  `apps/web/README.md`、`apps/desktop/README.md`（构建命令与目录树）、
  `SCENARIO-P2-REPORT.md`（如含旧路径则一并修）；`agent/README.md` 随目录删除。
- `.trellis/spec/backend/`（`index.md`、`architecture-and-runtime.md`、
  `desktop-agent-runtime.md`、`desktop-realtime-sync.md`、`http-and-filesystem.md`、
  `plugin-runtime.md`、`plugin-testing.md`、`quality-guidelines.md`、
  `scanning-and-persistence.md`）与 `.trellis/spec/frontend/`（`index.md`、
  `directory-structure.md`、`quality-guidelines.md`、`rendering-and-state.md`）、
  `.trellis/spec/guides/*.md`：逐文件更新入口命令、目录表、相对链接
  （`../../../server/...` → `../../../apps/server/...`）与测试路径。
- 更新后执行校验：`grep -rn "\(^\|[^a-z]\)\(server/\|web/\|shared/\|agent/\|tests/\|desktop/ui\)" README.md docs plugins/*/README.md apps/*/README.md .trellis/spec`，
  命中项逐条判断是否为新结构下的合法路径，非法即修。
- `.trellis/config.yaml`：

```yaml
packages:
  - path: apps/server
    type: backend
  - path: apps/web
    type: frontend
  - path: apps/desktop
    type: frontend
  - path: packages/shared
    type: shared
  - path: packages/test-support
    type: shared
default_package: apps/server
```

（字段以 `get_context.py --mode packages` 实际输出为准，落地时校验。）

## 10. 兼容性与取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 3 应用包 vs 4 | 3（server/web/desktop） | 用户按功能划分；Node agent 已无生产消费方，删除而非搬家 |
| bare 包名 vs 相对路径 | 相对路径 | 零安装部署是产品约束；web 构建期仍可用 alias |
| 是否保留旧 `server/`、`web/`、`shared/`、`desktop/`、`tests/` 目录 | 不保留，含空目录 | 单一约定；空目录会被误认为有效结构，外部插件一次性迁移 |
| 根 `tests/` 是否保留 | 删除，唯一跨包测试并入 apps/server/test | 避免为 1 个测试维持根目录与额外 glob |
| web 是否独立 lockfile | 合并到根 | R1；workspaces 单锁文件 |
| desktop 是否纳入 workspace | 纳入 | 统一脚本入口；cargo 不受 npm 影响 |
| 插件 SDK 是否独立成包 | 不独立，留在 apps/server/plugins | 用户要求；SDK 与宿主协议同版本演进，独立包没有消费方 |
| 删除 agent 的测试覆盖 | 接受 | 客户端由 Rust cargo 测试覆盖；服务端 team-* 测试保留 |

## 11. 发布与回滚

- 单分支一次性迁移，按 implement.md 的 6 个检查点提交/验证。
- 回滚：`git reset --hard <迁移前提交>`；删除的 `agent/` 可从历史恢复；
  无数据迁移，`TRELLIS_BOARD_DATA_DIR` 与 SQLite 不受影响。
- 部署文档先更新再合并；旧部署脚本若写死 `public/`、`server/index.js`，需同步（grep 全仓）。
