# 执行清单：server 加载仓库根 `.env`

前置：PRD/design 已确认（design 方案 A：声明 `dotenv` 依赖，移除零安装约束表述）。

## 1. 声明依赖

```bash
npm install dotenv@^17.4.2 --workspace @trellis-board/server
```

验收：`apps/server/package.json` 出现 `dependencies.dotenv`，根 `package-lock.json` 更新，
`node -e "console.log(require('dotenv/package.json').version)"` → 17.4.2。

## 2. 新增 `apps/server/env-file.js`

按 design 的签名实现：

- `dotenv.config({ path: file, processEnv: env, quiet: true })`
- 无错误或 `error.code === 'ENOENT'` → 返回 `{ file, loaded: !error }`
- 其它错误 → `throw new Error(\`读取 .env 失败：${file}（${result.error.message}）\`)`
- 默认目录由模块自身 `import.meta.url` 推算，不 import `config.js`。

再新增 `apps/server/env-bootstrap.js`：`import { loadProjectEnv } from './env-file.js'` + 顶层 `loadProjectEnv()`。

## 3. 两处调用

- `apps/server/index.js`：第一条 `import './env-bootstrap.js'`。
- `apps/server/team/cli.js`：第一条 `import '../env-bootstrap.js'`。

必须排在 `config.js` 等 import 之前：`config.js` 在 import 时求值 `dataDir`，模块体里的调用太晚。

## 4. 新增 `apps/server/test/env-file.test.js`

`node:test` + `node:assert/strict`，临时目录 `fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-env-'))`，`finally` 清理：

1. 注入：`A=1` + 空 `env` → `env.A === '1'`，`loaded === true`。
2. 优先级：`env = { PORT: '9999' }` + 文件 `PORT=1111` → 仍 `9999`。
3. 缺失：`env` 不变、不抛、`loaded === false`。
4. 语法：`export B="x y"`、`# 注释`、多行双引号值。
5. 显式 `file`/`directory` 参数。
6. 非 ENOENT：目标路径为目录 → 抛错且消息以 `读取 .env 失败：` 开头并含该路径。

## 5. 根目录 `.env.example`

`PORT`、`TRELLIS_BOARD_MODE`、`TRELLIS_BOARD_DATA_DIR`、`TRELLIS_WATCH_DEBOUNCE_MS`
（注释 + 占位值，无真实数据），文件头注明"复制为 `.env` 后生效，命令行环境变量优先"。

## 6. README

- 删除 `README.md:29-31` "不依赖 workspace 包名解析…在未安装依赖的目录中也能启动"，改为
  "跨包引用统一用 workspace 包名，共享第三方依赖提升到根 `package.json`"。
- 删除 `README.md:38` "没有第三方运行时依赖"，保留 Node 24 + `node:sqlite` 说明。
- 启动段后加 `.env` 小节：读仓库根 `.env`、与 cwd 无关、缺失静默、命令行环境变量优先、`.env` 不入库、
  `.env.example` 为模板。

## 7. 限制移除

- 删除 `scripts/check-boundaries.mjs`、`package.json` 的 `check:boundaries`、CI 步骤与全部引用。
- `.trellis/spec/backend/index.md:3` 与「基本约束」：删"不依赖 Web 框架或数据库驱动包"，
  「基本约束」改为 workspace 包名 + 根 `package.json` 提升共享依赖。
- `.trellis/spec/guides/code-reuse-thinking-guide.md:3`：删"刻意保持小而直接"。
- 跨包 import 迁移到 `@trellis-board/*`；web 去掉 `@shared` 别名与 tsconfig paths 键，改为
  `@trellis-board/shared/*`；`npm install` 同步 lock。

## 8. 验证

```bash
node --test apps/server/test/env-file.test.js
npm test
npm run test:plugins
npm run build
```

真机冒烟：

1. 根 `.env`：`PORT=4321`、`TRELLIS_WATCH_DEBOUNCE_MS=1200` → `npm start`，`curl 127.0.0.1:4321/api/health` 200，
   日志 `debounce=1200ms`。
2. 优先级：`PORT=4501 npm start` 时监听 4501（`.env` 里是 4321）。
3. `.env` 追加 `TRELLIS_BOARD_MODE=team` → `node apps/server/team/cli.js status` 输出 `mode: "team"`。
4. `.env` 写 `TRELLIS_BOARD_DATA_DIR=<工作树外目录>` → 启动后 `board.sqlite` 落在该目录。
5. 删除 `.env` → 4317 启动，日志无 dotenv 横幅；`git status` 中 `.env` 未被跟踪，`.env.example` 被跟踪。

## 回滚

还原 `apps/server/package.json`、`package-lock.json` 与 README/spec 文案，恢复 `scripts/check-boundaries.mjs`
与 import 路径，删除
`apps/server/env-file.js`、`.env.example`。无数据与 schema 影响。

## 可选后续（不在本任务）

`research/dependency-opportunities.md` 记录的 ZIP 编解码换 `fflate`、HTTP 小工具去重；其余（框架、日志、git、SQLite）明确不做。
