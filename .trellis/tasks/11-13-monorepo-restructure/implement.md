# 实施计划

前置：11-12 已合并/提交，工作区干净，从最新 `team-board` 拉分支 `codex/monorepo-restructure`。
每个检查点结束必须通过该点的验证命令；失败先修复再前进。

## 检查点 0：基线与分支

1. `git status --porcelain` 必须为空（11-12 未提交改动会污染 diff）。
2. 获得用户对 PRD/design 的确认后 `python .trellis/scripts/task.py start monorepo-restructure`。
3. 记录基线：`npm test`（71）、`npm run test:plugins`（6）、`node --test agent/test/*.test.js`（10）、
   `npm --prefix web run build` 全绿。
4. `git switch -c codex/monorepo-restructure`；`task.py set-branch monorepo-restructure codex/monorepo-restructure`。

## 检查点 1：骨架、移动、删除

```bash
mkdir -p apps packages
git mv server apps/server
git mv web apps/web
git mv desktop apps/desktop
git mv shared packages/shared
git mv agent/zip.js packages/shared/zip.js      # 先救出唯一生产用途
git rm -r agent                                  # 删除 Node agent（含 10 个测试/打包脚本/windows）
git mv tests/helpers packages/test-support
git mv tests/fixtures packages/test-support/fixtures
git mv tests/artifacts packages/test-support/artifacts   # 若存在
```

删除 6 个依赖 agent 的根测试（`git rm`）：`tests/desktop-realtime-apply.test.js`、
`tests/workspace-bootstrap.test.js`、`tests/workspace-client-flow.test.js`、`tests/team-core.test.js`、
`tests/team-realtime-sync.test.js`、`tests/team-events.test.js`。

其余 65 个根测试按 research/import-inventory.md §4 映射 `git mv` 到
`apps/{server,web,desktop}/test`、`packages/shared/test`；唯一的跨包测试
`task-space-duplicate-cleanup.test.js` 一并移到 `apps/server/test/`，然后删除根 `tests/`。

新增 5 个 `package.json`（design.md §2）：根（`workspaces: ["apps/*","packages/*"]`）、
apps/server、apps/web、apps/desktop、packages/{shared,test-support}。
删除 `apps/web/package-lock.json` 与 `apps/web/node_modules`；根 `npm install` 重建唯一锁文件。

清理空目录（`git` 不跟踪空目录，但本地与部署副本会残留）：

```bash
for d in server web shared desktop agent tests; do
  [ -d "$d" ] && find "$d" -type f | grep -q . && echo "LEFTOVER: $d" || rm -rf "$d"
done
ls -d server web shared desktop agent tests 2>/dev/null   # 必须无输出
```

验证：`npm install` 成功；`npm ls --workspaces --depth 0` 列出 5 个包；`git status` 中
`package-lock.json` 为唯一新增大文件；旧目录全部不存在。

## 检查点 2：一次性的相对 import 重写（临时 codemod）

写 `.tmp-codemod.mjs`（项目根，执行后删除）：

1. `mapPath(oldAbsPath)` 前缀映射：`server/→apps/server/`、`web/→apps/web/`、
   `desktop/→apps/desktop/`、`shared/→packages/shared/`、`agent/zip.js→packages/shared/zip.js`、
   `tests/helpers/→packages/test-support/`、`tests/fixtures/→packages/test-support/fixtures/`、
   65 个测试的新位置。
2. 遍历 `.js/.mjs/.ts/.tsx/.d.ts`，匹配 `from '…'`、`import('…')`、`require('…')`，只处理
   `./`、`../`：旧位置解析 → 新位置 → 从新文件位置重算相对说明符。
3. 手工改动（codemod 不覆盖）：
   - `apps/server/index.js`：`appDir = path.resolve(serverDir, '../..')`；
     `publicDir = path.join(serverDir, 'public')`。
   - `apps/server/team/workspace-templates.js`：改 `../../packages/shared/zip.js`。
   - `apps/web/vite.config.ts`、`vite.desktop.config.ts`：`@shared` →
     `path.resolve(webDir,'../../packages/shared')`；`build.outDir` →
     `path.resolve(rootDir,'../server/public')`（desktop 配置的 `../desktop/ui` 不变）。
   - `apps/web/tsconfig.app.json`：`@shared/*` → `../../packages/shared/*`。
   - `scripts/dev.mjs`：`webDir = join(rootDir,'apps/web')`；vite bin 走
     `join(rootDir,'node_modules','vite','bin','vite.js')`。
   - `.gitignore`、`.oxfmtrc.json`：见 design.md §4。

验证（强门禁）：

```bash
node .tmp-verify-imports.mjs   # 所有相对 import fs.existsSync 必须为 true
grep -rn "from '\.\./\.\./shared/\|from '\.\./\.\./\.\./shared/" apps/server --include=*.js   # 空
grep -rn "server/plugins/sdk\|agent/" plugins apps/server scripts tests --include=*.js         # 无运行时引用
node --test apps/web/test/*.test.js packages/shared/test/*.test.js
```

## 检查点 3：测试归属与根路径

1. 移动后测试的 `process.cwd()` 依赖改为 `fileURLToPath(new URL('../..', import.meta.url))` 等
   显式根路径；核对 research/import-inventory.md §5 列出的文件。
2. `packages/test-support/plugin-runtime.js` 的 `appDir` 仍等于仓库根。
3. fixture `module` 路径改为 `./packages/test-support/fixtures/plugins/<n>/index.js`。
4. `plugin-docs.test.js` 的归档任务文档路径不变（`.trellis/...`）。

验证：

```bash
npm test              # 65（50 server + 10 web + 4 shared + 1 desktop）
npm run test:plugins  # 6
```

## 检查点 4：打包链与 CI

1. `apps/desktop/package-portable.ps1`：仅校验 `$PSScriptRoot` 相对路径；根脚本
   `desktop:package` 转发。删除根脚本 `agent:package`。
2. `.github/workflows/windows.yml`：删除 `--prefix web` 安装、第二缓存键与 agent 测试步骤；
   改为 `npm ci` + `npm run build` + `check:boundaries` + `test:all`；cargo 路径改
   `apps/desktop/src-tauri/Cargo.toml`。

验证：

```bash
npm run build && npm run build:desktop
npm run desktop:build   # 有 Rust 时执行；无 Rust 记录为未验证
pwsh -File apps/desktop/package-portable.ps1 -WhatIf   # 若脚本支持；否则检查路径解析后跳过产物
```

## 检查点 5：文档、规范、Trellis 配置、边界守卫

1. 更新 `README.md`、`docs/team-operations.md`、`plugins/README.md`（SDK 引用
   `../../apps/server/plugins/sdk.js` + 测试命令）、`apps/web/README.md`、
   `apps/desktop/README.md`、`SCENARIO-P2-REPORT.md`（如含旧路径）；删除 `agent/README.md`
   与所有 Node agent 命令。
2. 逐文件更新 `.trellis/spec/backend/`（9 个）、`.trellis/spec/frontend/`（4 个）、
   `.trellis/spec/guides/`（3 个）中的入口命令、目录表与相对链接。
3. `.trellis/config.yaml` 增加 5 个包映射；`get_context.py --mode packages` 输出一致。
4. 新增 `scripts/check-boundaries.mjs` 并挂到 `check:boundaries`。

验证：

```bash
npm run check:boundaries
grep -rn "node server/index.js\|npm --prefix web\|desktop/ui\b\|trellis-agent.cmd\|\`server/\|\`web/\|\`shared/\|\`agent/\|\`tests/" --include=*.md --include=*.yml --include=*.json . | grep -v node_modules
python .trellis/scripts/get_context.py --mode packages
```

## 检查点 6：端到端验收

```bash
npm ci
npm run build
npm run check:boundaries
npm run test:all
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
node apps/server/index.js &   # 等待 4317，curl / 与 /api/board/status，然后停止
```

HTTP 冒烟：`http://127.0.0.1:4317` 返回看板 HTML；`/api/board/status` 返回 JSON；插件列表含
3 个内置插件。最后按 AGENTS.md 汇报变更与验证结果，获提交确认后再提交。

## 回滚点

| 检查点 | 失败处理 |
| --- | --- |
| 1 | `git reset --hard HEAD`（未提交移动/删除） |
| 2–3 | `git checkout -- .` + 删除未跟踪文件，保留检查点 1 提交（如已提交） |
| 4–5 | 同上；打包/CI 单独回退 |
| 整体 | `git reset --hard <迁移前提交>`；`agent/` 可从历史恢复；无数据迁移 |

## 明确不做

- 不引入 turbo/nx/changesets；不改服务端 API/DB/插件协议；不拆 Git 历史；
- 不为旧路径保留转发 shim；不把 Node agent 移植到新结构（已确认删除）。

## 执行记录（实际偏差）

- 边界守卫扫描 `apps/server`、`plugins`、`scripts`、`packages/test-support`（根 `tests/` 已删除）。
- `apps/server/test/plugin-docs.test.js` 删除「PRD 代码索引的行号与仓库一致」用例：它校验归档 PRD
  对 `server/index.js` 等旧路径的行号锚点，结构迁移后无法成立；表格结构用例保留。
- `apps/desktop/test/desktop-ui-build.test.js` 整体重写为 monorepo 路径（根 `../../..`、产物
  `apps/desktop/ui`、CI 断言 `npm run build:desktop` 先于 `npm run test:all`）。
- `apps/server/team/git-manager.js` 的 `DEFAULT_TRELLIS_CLI` 由两级上溯改为三级；`apps/server/config.js`
  的 `appDir` 同步改为 `../..`，否则 Team 初始化报「服务端缺少固定的 Trellis CLI」。
- `apps/web/package.json` 在 codemod 回滚时被恢复成旧名 `web`，已重新改为 `@trellis-board/web`。
- 验证结果：`npm test` 398 tests / 396 pass / 2 skipped / 0 fail；`npm run test:plugins` 39 / 38 pass /
  1 skipped；`npm run build`、`npm run build:desktop`、`npm run check:boundaries` 通过；
  `node apps/server/index.js` 启动后 `/`、`/admin.html`、静态资源均 200。
