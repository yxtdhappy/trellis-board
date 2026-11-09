# 团队任务卡片补齐目录名：实施报告

## 结论

团队任务查询的非 304 响应现在先经过现有 `normalizeTaskPage`，再写入前端状态。`relativeDir` 因此会按既有规则派生 `dirName`，共享任务卡能够正常显示任务目录名。

## 改动

- `web/src/api/board.ts`：`queryTeamTasks` 在 200 响应中使用 `normalizeTaskPage`；304 分支、ETag 透传和分页处理保持不变。
- `tests/team-web.test.js`：现有任务页规范化测试同时覆盖 camelCase `relativeDir` 和 snake_case `relative_dir`，断言目录名取路径最后一段。

## 边界

- 未修改 `TaskCard`、`useBoard`、服务端接口、权限逻辑或单机 `/api/board`。
- 未新增目录名解析逻辑，直接复用 `web/src/lib/team-client.js` 的既有实现。

## 验证

- `node --test tests/team-web.test.js`：16/16 通过。
- `npm --prefix web run lint`：通过，0 error。
- `\.\node_modules\.bin\tsc.cmd -b`：通过。
- `npm --prefix web run build`：通过，2576 个模块完成生产构建。
- `git diff --check`：通过。
