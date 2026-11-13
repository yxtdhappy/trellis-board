# 技术设计：server 读取仓库根 `.env`（dotenv 依赖）

## 现状

| 事实 | 位置 |
| --- | --- |
| `apps/server/package.json` 没有任何 dependencies | 只有 `type`/`scripts`；根 `package.json` 也不给 server 传依赖 |
| 安装已是既有前置 | `README.md:42` 启动步骤含 `npm install`；`.github/workflows/windows.yml:59,142` 在测试/构建前执行 `npm ci` |
| "零安装部署"约束的落点 | `scripts/check-boundaries.mjs:14,32`、`.trellis/spec/backend/index.md:3` 与基本约束、`.trellis/spec/guides/code-reuse-thinking-guide.md:3`、`README.md:29-31,38`（清单见 `research/dependency-opportunities.md`） |
| 仓库内 dotenv | 17.4.2，来自 `apps/web` → `shadcn` → `@dotenvx/dotenvx` 的传递依赖；声明后由根 lockfile 固定 |
| 配置只读 `process.env` | `apps/server/config.js:72` `parseTeamConfig(env = process.env)` |
| 模块级 env 求值（必须晚于加载） | `apps/server/index.js:49` `const WATCH_DEBOUNCE_MS = Math.max(100, Number(process.env.TRELLIS_WATCH_DEBOUNCE_MS \|\| 400))` |
| 服务入口 | `apps/server/index.js:994` 主入口守卫 → `startApplication()` |
| Team CLI 入口 | `apps/server/team/cli.js:176` `main()`，内部调用 `parseTeamConfig(process.env)` |
| 仓库根 | `apps/server/config.js:6` `appDir = path.resolve(serverDir, '../..')` |
| 客户端不携带 Node 运行时 | `apps/desktop/package-portable.ps1:8` → 依赖放宽不影响桌面打包 |

## 方案对比

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. **声明 npm 依赖** | `npm install dotenv --workspace @trellis-board/server`，`env-file.js` 里 `import dotenv from 'dotenv'` | **采用**：安装已是 README/CI 的前置，零安装约束按用户要求移除 |
| B. `process.loadEnvFile()` | Node 24 原生 API | 否决：非 dotenv 语义、无法注入 `processEnv`，且用户指定 dotenv |
| C. vendor 源码 | 复制 `dotenv/lib/main.js` 到 `apps/server/vendor/` | 否决：约束移除后没有必要维护副本 |
| D. 自写解析器 | 手写 `.env` 解析 | 否决：语义偏差（多行双引号、`\n` 转义、BOM、`export`） |

## 模块设计

### `apps/server/env-file.js`

```js
import path from 'node:path'
import dotenv from 'dotenv'
import { appDir } from './config.js'

export function loadProjectEnv({
  directory = appDir,
  env = process.env,
  file = path.join(directory, '.env'),
} = {}) {
  const result = dotenv.config({ path: file, processEnv: env, quiet: true })
  if (!result.error || result.error.code === 'ENOENT') {
    return { file, loaded: Object.keys(result.parsed ?? {}).length > 0 }
  }
  throw new Error(`读取 .env 失败：${file}（${result.error.message}）`)
}
```

已实测的 dotenv@17.4.2 行为：

- 缺失文件返回 `{ parsed: {}, error: { code: 'ENOENT' } }`，不抛错、不写 `processEnv`；
- `processEnv` 可注入普通对象（单测用）；
- **已存在的键不被覆盖**（`PORT=9999` 在进程环境、文件 `PORT=1111` → 仍 9999），即命令行/进程环境优先；
- `export B="x y"`、`#` 注释按官方语义解析；
- `quiet: true` 抑制 v17 启动横幅。

无循环导入：`env-file.js → config.js`（只取 `appDir`），`config.js` 不引用 `env-file.js`。

### 依赖声明

`apps/server/package.json` 增加 `"dependencies": { "dotenv": "^17.4.2" }`；根 `package-lock.json` 由
`npm install` 更新。工作区提升后 `apps/server` 从根 `node_modules/dotenv` 解析。

### 调用点（入口第一条 import）

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| `apps/server/index.js` | 文件第一条 `import './env-bootstrap.js'` | `config.js` 在 import 时求值 `dataDir`/`databaseFile`，ESM 静态 import 先于模块体执行；放在模块体里的调用太晚，`.env` 的 `TRELLIS_BOARD_DATA_DIR` 不会生效，`WATCH_DEBOUNCE_MS`（第 49 行）也会取到旧值 |
| `apps/server/team/cli.js` | 第一条 `import '../env-bootstrap.js'` | 同一原因：`cli.js:3` 从 `config.js` 解构 `databaseFile` |

- `apps/server/env-file.js` 只导出纯函数 `loadProjectEnv()`；副作用单独放 `apps/server/env-bootstrap.js`，
  后者仅两行（import + 顶层调用）。这样测试 import `env-file.js` 不会加载仓库 `.env`。
- 默认目录由 `env-file.js` 自己的 `import.meta.url` 推算（`apps/server` → 仓库根），不 import `config.js`，
  避免把配置模块的求值顺序拖进来。
- `scripts/dev.mjs` 用 `node --watch apps/server/index.js` 启动，自动继承，无需改动。

### 限制移除（删除，不替换成新限制）

- `scripts/check-boundaries.mjs` 整体删除（连同 `package.json` 的 `check:boundaries`、
  `.github/workflows/windows.yml` 步骤、README 与 spec 引用）：三条规则移走后只剩旧目录名守卫，
  属于一次性迁移残留检查，不再是常规约束。
- `.trellis/spec/backend/index.md:3`：删"不依赖 Web 框架或数据库驱动包"。
- `.trellis/spec/backend/index.md` 基本约束：改为"跨包引用使用 workspace 包名；被多个 workspace 共用的
  第三方依赖在根 `package.json` 声明，仅单包使用的留在该包"。
- `.trellis/spec/guides/code-reuse-thinking-guide.md:3`：删"这个仓库刻意保持小而直接"的规则表述。
- `README.md`：删"未安装依赖也能启动 / 没有第三方运行时依赖"，跨包段落改为 workspace 包名 +
  根 `package.json` 提升依赖。
- 跨包 import 全部迁移（`apps/server` 29 个文件、`packages/test-support`、`plugins/*`、`scripts/*`、
  `apps/web` 4 个 TSX），`@shared` 别名从两个 vite config 与 `tsconfig.app.json` 移除，依赖声明进
  `apps/server`、`apps/web`、`packages/test-support` 的 `package.json`。

## 行为契约

- 缺失 `.env`：无输出、无状态变化。
- `.env` 存在：只补充未设置的键（`override: false` 不暴露开关），命令行环境变量始终优先。
- 非 ENOENT 读取错误（如 `.env` 是目录）：抛 `读取 .env 失败：<绝对路径>（<原因>）`，走既有启动失败路径。
- 不记录、不打印文件内容；`debug` 关闭。

## 兼容性与回滚

- 无 schema/API/缓存签名变化；无 `.env` 时行为与现状一致。
- 新增安装前置只对"从未执行 `npm install` 的裸仓库"生效，README 已要求安装。
- 回滚 = 还原 `package.json`/`package-lock.json`，删除 `env-file.js`、`.env.example`，撤销两处调用与文档改写。

## 风险

| 风险 | 处置 |
| --- | --- |
| `config.js` 的 `dataDir` 早于加载求值 | 加载做成入口第一条 import 的副作用模块；冒烟用 `.env` 里的 `TRELLIS_BOARD_DATA_DIR` 断言 `board.sqlite` 落在该目录 |
| dotenv v17 横幅污染启动日志 | `quiet: true`；A6 断言无横幅 |
| 忘记 `npm install` 导致 `ERR_MODULE_NOT_FOUND` | README 启动步骤已含安装；错误本身可定位，不额外加兜底 |
| `.env` 误入版本库 | `.gitignore` 已覆盖；`.env.example` 只放占位键 |
| 依赖放宽被误解为"可以随便加包" | spec 写明依赖在各包 `package.json` 声明、被多包共用的提升到根 `package.json` |
