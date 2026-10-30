# 计划与注意力：真实端到端验证

## 环境

- 页面：`http://127.0.0.1:4317`
- 分支：`codex/personal-plan-attention`
- 新服务进程：PID `4488`
- 数据：真实 `data/board.sqlite`
- 迁移前快照：`.audit/personal-plan-attention-real-20261030/board-before-v2.sqlite`
- 浏览器：Ego Lite Chromium

## 迁移演练

使用 SQLite `VACUUM INTO` 对运行中的真实库创建一致性快照，再在副本上执行新代码迁移。

- 迁移前：schema v1，8 个项目、682 个任务、9 个进行中、673 个归档。
- 副本迁移后：schema v2，项目与任务计数保持一致。
- 副本生成独立可读的 v1 备份。

正式服务停止旧 PID `32992` 后，由新 PID `4488` 启动。真实库自动生成 `data/board.sqlite.v1-backup`，主库升级到 v2。

## API 验证

- `/api/health` 返回 `ok`，PID 与监听进程均为 `4488`。
- `/api/board` 首次完整扫描后保持 8 个项目、682 个任务、9 个进行中、673 个归档。
- 真实库建立 9 条 `tracking_started`，首次 v2 启动没有 `stage_observed` 或旧历史补造。

## 浏览器验证

### 计划字段

从注意力队列打开“个人执行：计划与注意力”，在详情中打开计划字段编辑器并保存：

- 截止：`2026-10-30`
- 里程碑：`个人执行增强 / Slice 1`
- 标签：`personal`、`attention`

保存后 Board API 立即读回相同值；焦点卡和注意力队列同步显示“今天截止”和两个标签。目标 Trellis `task.json` 未被修改。

### 保存视图

通过页面创建“个人执行 MVP”：

- 优先级：`P1`
- 标签：`personal`

创建后自动切换至该视图。实际匹配 1 个任务组，按任务组展开显示 4 个任务。

初次 E2E 发现按钮显示 1、汇总和列表显示 4。修复后再次验证：

- 按钮：`个人执行 MVP 4`
- 汇总：`个人执行 MVP · 4 项`
- 顶部进行中：`4`
- Kanban 去重任务数：`4`

### 回归

- 默认范围下，全部 8 个内置/自定义视图满足四路计数一致。
- 叠加项目 `trellis-board`、负责人“只看我的”和搜索“个人执行”后仍一致。
- 团队视角、归档索引、项目管理、创建任务和空状态未回归。
- 视图切换只触发一批视图栏更新，没有逐视图重绘。
- 浏览器控制台无 error/warn，相关页面和 API 请求返回 200。

### 重启持久化

停止 PID `4488` 后由新 PID `42200` 重新启动当前代码。重启后从 API 和页面读回：

- 截止：`2026-10-30`
- 里程碑：`个人执行增强 / Slice 1`
- 标签：`personal`、`attention`
- 保存视图“个人执行 MVP”保持相同 ID 和筛选条件
- 项目 8、任务 682、进行中 9、归档 673

重新加载页面并切换“个人执行 MVP”后：

- 按钮计数：`4`
- 视图汇总：`个人执行 MVP · 4 项`
- 顶部进行中：`4`
- 可见任务：`4`

最终截图：`.audit/personal-plan-attention-real-20261030/real-e2e-restarted.png`

## 增量：同一任务组层级

环境保持真实服务 PID `42200`，前端静态文件修改后强制忽略缓存重载；本轮未重启服务、未写计划字段、未清理 SQLite 数据。

### 团队视角

- yhj 卡显示 `7 个进行中任务`，其中“个人版执行增强”是唯一父任务组头，显示 `3 个子任务`。
- 三个子任务形成同一缩进子树：计划与注意力、追溯与复盘、风险与流动。
- 卡片只显示 4 个任务行，不再为每行重复“4 个任务一组”，但仍保留 4 个任务打开按钮和 4 个计划按钮。
- 子任务详情与计划编辑器均可打开和关闭，未保存数据。
- 1440px 截图：`.audit/personal-plan-attention-real-20261030/hierarchy-team-1440.png`。

### Kanban

- “个人版执行增强”组显示 `父任务 · trellis-board` 与 `3 个子任务`。
- Kanban 只有 1 张父卡，3 个子任务使用连续树线和端点；每行任务按钮与计划按钮可操作且无重叠。
- 1440px 截图：`.audit/personal-plan-attention-real-20261030/hierarchy-kanban-1440.png`。

### 注意力队列

- 队列仍按临近截止、P0/P1、检查等原权重排序，没有按父子关系重新分组。
- 当前可见的两个组内子任务均显示紧凑路径“父任务 · 个人版执行增强”。

### 计数与窄屏

- 当前真实 Board 为 8 个项目、683 个任务、9 个进行中、674 个归档。
- 8 个视图按钮计数依次为 `9、8、7、4、0、4、4、4`；默认视图汇总、顶部“进行中 9”和 Kanban 去重任务数一致。
- 860px 下仍显示 3 个子任务，文档宽度 845px，页面无水平溢出；任务标题截断后不与阶段或计划按钮碰撞。
- 窄屏截图：`.audit/personal-plan-attention-real-20261030/hierarchy-team-narrow.png`。
- 浏览器 console 无 error/warn。

## 增量：全屏与短高度视口

本轮重新强制忽略缓存加载真实页面。精确尺寸设置通过 Chromium CDP `Emulation.setDeviceMetricsOverride` 执行；Chrome DevTools MCP 仍用于页面数据、控制台和网络请求检查，但其视口模拟返回成功后页面 `innerWidth/innerHeight` 仍为 `1440×1000`，因此精确几何断言改用 Ego Lite Chromium 的 CDP 会话完成。

截图右侧的控制区属于浏览器/Ego 外壳，不在应用页面 DOM 内，未纳入页面布局修复或页面宽度断言。

### 1416×659

- 页面等到真实推荐任务和注意力项出现后再测量，避免扫描空态污染结果。
- `.focus-grid` 计算样式为 `align-items: start`。
- `.focus-panel` 为 `235.80–608.19px`，高度 `372.39px`，自身内容所需高度 `371.72px`，底部空内容仅 `0.67px`。
- `.attention-panel` 为 `235.80–894.90px`，高度 `659.09px`；推荐卡与该栏不相等，原约 300px 的拉伸空白消失。
- 页面横向溢出为 `false`；截图：`.audit/personal-plan-attention-real-20261030/fullscreen-focus-1416x659.png`，实际 `1416×659`。
- 点击“创建任务”后，dialog 为 `39.56–619.77px`，完整位于视口；dialog 和 form 的计算 `overflowY` 均为 `hidden`。
- `.form-grid` 为 `189.83–547.65px`，`overflowY: auto`，`scrollHeight 442px / clientHeight 358px`；标题 `40.23–133.69px`、提示 `149.69–189.83px`、footer `547.65–620.44px` 均可见。
- 临时显示 `#create-message` 后，消息占 `493.50–531.65px`，主体缩为 `scrollHeight 442px / clientHeight 304px`，footer 位置和高度不变并仍位于视口内。消息根因只做 DOM 展示，未提交表单、未发创建请求。
- 关闭前恢复 `hidden`，Escape 后 dialog 已关闭。截图：`.audit/personal-plan-attention-real-20261030/fullscreen-create-1416x659.png`，实际 `1416×659`。

### 860×700

- 创建表单为单列，主体 `scrollHeight 668px / clientHeight 337px`，仅主体滚动。
- footer 为 `529.75–658.67px`；取消按钮 `544.42–588.54px`，创建按钮 `600.54–644.67px`，均完整可见且无重叠。
- dialog 无横向溢出；Escape 正常关闭。截图：`.audit/personal-plan-attention-real-20261030/fullscreen-create-860.png`，实际 `860×700`。

### 1440×900 回归

- `.focus-grid` 仍为顶部对齐；推荐卡高度 `373.16px`，注意力栏高度 `659.09px`，无页面横向溢出。
- 原始加载、控制台和网络检查显示根页面、`app.js`、`styles.css`、辅助模块与 `/api/board` 均为 200，控制台无 error/warn。

### 证据采集说明

DOM、交互和布局断言通过 Chrome DevTools MCP 完成。Chrome 截图工具无法把文件写入工作区，因此仅使用 Ego Lite 在独立的临时浏览器空间复现同一页面并持久化截图；Ego 任务完成后关闭。两种浏览器均连接本机 `http://127.0.0.1:4317/`，未修改后端状态。

精确设备尺寸截图同样由 Ego Lite Chromium 完成，原因是 Chrome DevTools MCP 的视口模拟未反映到页面运行时尺寸；DOM、交互和网络/控制台仍由 Chrome DevTools MCP 复核。

## 质量门

- `npm test`：82 项通过，0 失败。
- `server/`、`public/`、`tests/` 全部 JavaScript：`node --check` 通过。
- `git diff --check`：无输出。
- 项目没有 lint、TypeScript 类型检查或构建链，相关项为 N/A。

## 保留状态

本轮真实 E2E 有意保留用户的计划字段和“个人执行 MVP”视图；它们不是临时垃圾数据。迁移与 E2E 证据保存在 `.audit/personal-plan-attention-real-20261030/`。

项目没有 lint、TypeScript 类型检查或构建链，因此未执行这些不存在的检查。
