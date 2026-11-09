# 团队任务卡片补齐目录名检查报告

## 检查结论

- `web/src/api/board.ts` 的 `queryTeamTasks` 只在 200 响应进入现有 `normalizeTaskPage`；304 分支、ETag 透传和分页字段契约保持不变。
- `normalizeTaskPage` 复用 `normalizeTeamTaskRow`，从 `relativeDir` 或兼容字段 `relative_dir` 取路径最后一段生成 `dirName`。
- `useBoard` 在写入 `teamPage` 前取得规范化结果，后续 `teamRowToBoardTask` 会保留 `dirName`，共享 `TaskCard` 无需改动。
- 本任务未修改 `TaskCard`、`useBoard`、服务端、单机 `/api/board` 路径或权限逻辑。
- 现有 `.trellis/spec/` 已覆盖团队分页、ETag、任务身份和前端规范化边界，无需同步规范。

## Findings（fixed）

- `tests/team-web.test.js`
- Issue：新增回归只用了 `relative_dir`，没有直接覆盖团队接口实际返回的 camelCase `relativeDir`。
- Fix：同一任务页测试同时覆盖 `relativeDir` 和 `relative_dir`，分别断言最后一段目录名，并继续断言分页与查询字段。

## Findings（not fixed）

- 无。

## Verification

- Lint：通过，`npm --prefix web run lint` 为 0 error；保留仓库既有 warning。
- TypeCheck：通过，在 `web/` 执行 `.\node_modules\.bin\tsc.cmd -b`。
- Tests：通过，`node --test tests/team-web.test.js`，16/16。
- 浏览器运行态：通过，`http://127.0.0.1:4317/` 的目标卡片显示 `11-08-project-onboarding-remote-info`。
- 复制任务名：通过，点击按钮后 `Get-Clipboard` 读回 `11-08-project-onboarding-remote-info`。
- `git diff --check HEAD`：通过。
- 最终 Vite 构建：主会话执行 `npm --prefix web run build`，通过。
