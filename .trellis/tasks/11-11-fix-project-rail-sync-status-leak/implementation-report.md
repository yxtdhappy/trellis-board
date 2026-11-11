# 项目栏同步状态跨项目污染实施报告

## 实现

- `ProjectRail.tsx` 的父项目状态改为聚合项目自身 `taskSpaces`，不再读取全局 `currentTaskSpace`。
- 新增 `web/src/lib/project-rail-association.js`，统一安装状态筛选和
  “关联失效、`error`、`syncing`、`pending`、`ready`”优先级。
- 当前选中分支的关联图标继续使用该分支自身 association，不误用父项目聚合状态。
- 新增 `tests/project-rail-association.test.js`，覆盖项目隔离、多分支聚合、关联失效和未关联场景。

## 验证

- `node --test tests/project-rail-association.test.js`：3/3 通过。
- `npm --prefix web run lint`：通过，仅有仓库既有 warning。
- `npm run build`：TypeScript 与 Vite 构建通过。
- `npm exec oxfmt -- --check`：本次涉及文件通过。
- `git diff --check`：通过。
