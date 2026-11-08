# 检查报告

## 结论

本次实现通过代码审查、聚焦测试、前端 lint、最终构建和主要浏览器验收。开工条件在实现阶段继续可见，完成条件按阶段展示，用户界面已移除原英文条件简称。

## Findings (fixed)

- `web/src/lib/condition-checks.js`
  - 问题：新增模块重复维护规划阶段 ID，容易与前端既有阶段顺序漂移。
  - 修复：复用 `FILTER_STAGES`，按“规划评审”位置派生规划阶段集合。
- `web/src/features/board/ConditionChecks.tsx`
  - 问题：详情数组尚未返回时，缺失的计数会被当作 0，可能短暂显示“全部满足”。
  - 修复：区分“计数未知”和“明确为 0”；未知时显示读取中，不显示成功状态。
  - 问题：完成条件为 0 时外层仍是警告色。
  - 修复：未知使用中性色，缺失使用警告色，满足使用成功色。

## Findings (not fixed)

- 完整 `npm test` 的单次执行有 1 个既有 Windows 临时目录清理失败：
  - 用例：`plugins/acp-dispatch/test/index.test.js` 中 `toolCall 缺 kind 时回退到缓存，缓存也没有则按 other 处理`
  - 原因：测试夹具目录 `EPERM`
  - 状态：单独重跑通过，和本次改动无直接关系。
- 隔离 standalone 页面存在 `/api/runtime` 404 控制台错误。该端点不属于本次改动，不影响看板加载和验收。
- 当前 `4317` 服务仍是旧进程，未按用户要求擅自重启；新产物已在 `public/`，需要另行授权重启后才能在日常服务中看到。
- 当前工作区另有他人创建的任务目录 `.trellis/tasks/11-08-archived-task-assignment-readonly/`，本次未触碰。

## Verification

### Focused tests

- `node --test tests/condition-checks.test.js`: 4/4 通过。
- `node --test tests/execution-projection.test.js`: 9/9 通过。
- 合计聚焦测试：13/13 通过。

### Full tests

- `npm test`: 334 个测试，328 通过、5 跳过、1 失败、0 取消。
- 失败项为上述 Windows `EPERM` 清理问题；聚焦用例单独重跑通过。

### Lint

- `npm --prefix web run lint`: 通过。
- 仅有仓库既有 warning，本次新增文件没有引入新的 lint warning。

### Build

- `npm run build`: 通过。
- 仅执行一次最终构建。
- `tsc -b && vite build` 成功，2571 个模块完成转换并写入 `public/`。

### Diff hygiene

- `git diff --check`: 通过。
- `web/src` 中无用户可见的 `DoR`、`DoD` 文案。

### API

隔离服务 `http://127.0.0.1:4318`：

- 健康检查返回 `200`。
- 实现中任务列表返回：
  - `开工条件缺 2`
  - `完成条件缺 5`
- 同一任务详情返回：
  - `dorMissingCount=2` 且包含 2 条开工缺口。
  - `dodMissingCount=5` 且包含 5 条完成缺口。
- 列表仍只返回数量，详情才返回数组。

### Browser

- 1440px 浅色：详情弹窗宽度 `1240px`，无横向溢出；开工条件默认折叠，点击“查看明细”后展示 2 条缺口。
- 1024px：条件表仍为四列，无横向溢出。
- 860px 浅色与深色：条件表切换为单列卡片，无横向溢出。
- 实现态：显示开工条件欠债和完成条件表，13 阶段证据保留。
- 规划态：开工条件直接展开，完成条件显示“暂不适用”。
- 全部满足的归档任务：显示“5 项完成条件已全部满足”，不渲染空表。
- 卡片文案验证：出现“开工条件缺 3”“完成条件缺 5”“开工条件仍缺 2”。
- 流动信号验证：显示“条件缺口 / 按当前阶段检查”。

### Temporary service

- 隔离服务 PID `33156` 已停止。
- `4318` 当前无监听进程。

## Remaining verification

- 未重启用户现有 `4317` 服务，因此该端口尚未加载本次后端代码和最新静态产物。
- 主代理补充验证：隔离 `4318` 下 `/admin.html` 可正常渲染；独立模式访问 `/login.html` 会回到看板首页。两页均无本次改动引起的加载错误。
