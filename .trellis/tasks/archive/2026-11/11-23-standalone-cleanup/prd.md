# 清理 standalone 残留

## Goal

删除 standalone 的可执行代码与前端双路径，使 Team 成为唯一运行模式；保留历史文档说明，不保留可运行的 standalone 分支。

## Background

`packages/server/standalone/` 仍有 13 个文件、约 1080 行；`index.js` 直接 `startApplication`；前端 `useBoard` 有 94 处 `teamMode` 分支与 `loadBoard` 单人路径；`BoardPage` 保留 `STANDALONE_PLUGIN_NAV`。Team 是当前唯一主线，standalone 已标记 Legacy，继续保留双路径会让插件/角色改造反复兼容历史分支。

## Requirements

### R1 服务端删除 standalone

- 删除 `packages/server/standalone/` 整个目录。
- 删除 `packages/server/test/standalone.test.js`。
- `packages/server/index.js` 只走 Team 启动路径，不再 import `standalone/server.js`。
- `packages/server/config.js` 去掉 standalone 模式分支；`TRELLIS_BOARD_MODE` 只接受 `team`（非法值显式报错）。
- 保留 `packages/server/plugins/` 与 Team 插件运行时；不删除 Team 插件代码。

### R2 前端收敛为 Team 单路径

- `packages/web/src/hooks/useBoard.ts` 删除 `loadBoard` 单人加载路径与 `teamMode` 分支，固定走 `loadTeamPage` / `loadAssignments` / `loadTeamStatus`。
- 删除 `/api/runtime` 失败时静默回落 standalone 的逻辑；Team 部署下请求失败应显式报错。
- 删除 `BoardPage` 的 `STANDALONE_PLUGIN_NAV` 与 `!teamMode` 分支。
- 清理 `api/admin/types.ts`、`api/admin/readers.ts` 中的 standalone 类型/读取分支。
- 保留 `api/board.ts` 等仍被 Team 使用的接口。

### R3 文档与脚本

- 更新 `.trellis/spec/backend/index.md`：移除“暂不删除旧代码”的表述，改为 standalone 已删除。
- 更新 `docs/team-operations.md`、`README.md` 中仍把 standalone 描述为可用模式的段落。
- `.worktree/.agent/docs/50-plugins.md` 的历史 standalone 段落移入历史区或标注“代码已删除”。

### R4 范围边界

- `client/trellis-board-web`（4403）分支本轮不改动。
- 不改动 4317 远端实例。
- 不删除 `plugins/` 下的插件实现。

## Acceptance Criteria

- [ ] `packages/server/standalone/` 不存在；`grep -rn "standalone" packages/server --include=*.js` 只剩注释/历史说明，无运行分支。
- [ ] `node packages/server/index.js` 在 Team 环境变量下正常启动；`TRELLIS_BOARD_MODE=standalone` 启动失败并给出明确错误。
- [ ] `yarn test` 全通过（standalone 测试已删除，其余测试无回归）。
- [ ] `yarn build`（`tsc -b && vite build`）通过。
- [ ] 4401 登录、看板、团队视角、管理页、归档索引回归通过。
- [ ] `useBoard.ts` 不再出现 `teamMode` 分支；`loadBoard` 已删除。
- [ ] 4403（`client/trellis-board-web`）代码无改动。

## 落点

- 主改：`.worktree/trellis-board-team`（`packages/server`、`packages/test-support`、文档）。
- 关联改动：`.worktree/trellis-board-dev`（`packages/web` 的 `useBoard`、`BoardPage`、admin 类型）。
- 任务文档在 main 分支创建，执行阶段在两个 worktree 分别提交。

## Notes

- 该任务会触碰 `useBoard` 核心数据路径，必须按“先服务端、后前端”的顺序执行，并逐段验证团队看板数据。
- 不引入新状态库或路由库。
- 历史 standalone 文档保留说明，但不保留可执行代码。
