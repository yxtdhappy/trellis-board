# 跨包引用与测试归属盘点（规划期实测）

命令均在仓库根执行，HEAD `de77ffb`，2026-11-13。

## 1. 零安装约束下的模块解析实验

```
apps/server/package.json: {"type":"module","imports":{"#shared/*":"../packages/shared/*"}}
node apps/server/index.js
→ Error [ERR_INVALID_PACKAGE_TARGET]: Invalid "imports" target "../packages/shared/*"
```

结论：Node `imports` 目标不能逃出包目录；workspace 包名又依赖 `node_modules` symlink。
复制仓库后直接 `node apps/server/index.js` 的部署方式因此只能使用相对路径跨包。
web 只在构建期解析，可继续用 Vite alias。

## 2. 跨包引用点（迁移前计数）

| 位置 | 引用 | 文件数/处数 |
| --- | --- | --- |
| `server/**` | `../shared/*.js`、`../../shared/*.js` | 9 个文件 |
| `server/team/workspace-templates.js` | `../../agent/zip.js` | 1 处 → 改 `packages/shared/zip.js` |
| `plugins/*/index.js` | `../../server/plugins/sdk.js` | 3 处 → 改 `../../apps/server/plugins/sdk.js` |
| `plugins/*/test/*.js` | `../../../tests/helpers/*`、`../../../server/*` | 11 处 |
| 根 `tests/*.test.js` | `./helpers/*` | 13 个文件 |
| `web/src` + vite/tsconfig | `@shared/*` | 5 处（2 个 TSX + alias 配置） |

## 3. Node agent 已无生产消费方的证据

- `11-12-rust-desktop-agent-single-exe`（已归档）删除 `desktop/sidecar/**`，并用 Rust 重写全部
  agent 能力；删除前 `desktop/sidecar/{main,desktop-association,desktop-device,trellis-runtime}.js`
  分别 import `../../agent/{api,config-store,project-onboarding,protocol,credential-store,process}.js`。
  sidecar 删除后，仓库内不再有生产代码 import `agent/*`。
- `.github/workflows/windows.yml` 不再调用 `package-agent.ps1`，也不产出 agent ZIP。
- `README.md`、`docs/*.md`、`desktop/README.md` 均不再引用 `agent/`。
- 剩余消费方：`server/team/workspace-templates.js`（只用 `readZipEntries`）+ 16 个测试。
- `agent/zip.js` 仅依赖 `node:fs/path/zlib`，可平移到 `packages/shared/zip.js`。

## 4. 根测试归属（71 个，按 import 实测）

| 归属 | 数量 | 文件 |
| --- | --- | --- |
| apps/server/test | 50 | actions, board-events, data-migration, database-v10, database, execution-history, execution-metrics, execution-projection, execution-store, loader, metadata, persistence, plugin-cancel, plugin-capability, plugin-core-capabilities, plugin-docs, plugin-events, plugin-http, plugin-manifest-conventions, plugin-oversized-frame, plugin-protocol, plugin-real-task, plugin-repository-events, plugin-sdk, plugin-secrets, plugin-store, plugin-supervisor, plugin-version, repositories, scan-commit, server-logger, task-index-args, task-location, team-agent-slot, team-board-events, team-credentials, team-error-diagnostics, team-gitless-http, team-isolation, team-registration, team-release, team-sparse-onboarding, team-static, team-task-commands, team-task-index-v10, team-task-snapshot, team-task-spaces, team-workspace-template, watcher, task-space-duplicate-cleanup |
| apps/web/test | 10 | archive-sort, clipboard, condition-checks, execution-filter, markdown, onboarding-associations, onboarding-probe, project-rail-association, task-view-key, team-web |
| packages/shared/test | 4 | shared-remote-identity, slug, task-snapshot, trellis-agent-tools |
| apps/desktop/test | 1 | desktop-ui-build |
| 随 agent 删除 | 16 | `agent/test` 10 个 + desktop-realtime-apply、workspace-bootstrap、workspace-client-flow、team-core、team-realtime-sync、team-events |

50+10+4+1 = 65 保留，65+6 删除 = 71，与迁移前 `tests/*.test.js` 数量一致。
根 `tests/` 目录在迁移后删除，`plugins/*/test` 6 个不变。

## 5. 依赖仓库根的测试代码

- `packages/test-support/plugin-runtime.js`：`appDir = path.resolve(dirname, '../..')` → 迁移后
  仍指向仓库根（`packages/test-support/../..`）。
- `packages/test-support/task-repository.js`、`plugin-real-task.test.js`：用 `process.cwd()`
  复制 `.trellis/scripts`；测试统一由根脚本执行（cwd=仓库根），迁移后保持可用。
- `plugin-docs.test.js`、`plugin-manifest-conventions.test.js`、`team-static.test.js`：
  用 `fileURLToPath(new URL('..', import.meta.url))` 求根；深一层后必须改为 `'../..'` 或
  `'../../..'`，逐文件核对。
