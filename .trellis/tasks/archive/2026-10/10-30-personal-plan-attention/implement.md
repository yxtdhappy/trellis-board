# 计划与注意力：实施计划

## 前置检查

- [x] `task.py current` 指向 `10-30-personal-plan-attention`。
- [x] 父任务和本任务均有已评审的 PRD、Design、Implement。
- [x] `implement.jsonl`、`check.jsonl` 有真实 spec 条目。
- [x] 当前工作区无关改动已记录，不会被加入提交。

## 实施顺序

### 1. 固定数据模型

- [x] 在 `server/database.js` 加入 v1 -> v2 顺序迁移、v2 新库初始化和版本拒绝测试。
- [x] 保持旧 JSON 一次性导入逻辑，不重写旧文件。
- [x] 增加 schema 迁移失败回滚夹具。

验证：

- v1 数据库保留现有五张表后新增四张 v2 表。
- 重复打开不重复迁移。
- v2 新库和 v1 升级后的表结构一致。

### 2. 稳定任务身份

- [x] 在 `server/loader.js` 生成 `executionTaskKey` 和 `executionIdentityValid`。
- [x] 在 board 汇总时检查跨项目局部冲突，不把冲突身份写进 SQLite。
- [x] 更新 `toTaskListItem()`、扫描缓存版本和必要测试。

验证：

- 活动任务移动到归档路径后稳定身份不变。
- 人为制造重复身份时任务可见但禁止扩展写入。

### 3. 领域服务

- [x] 新增 `server/execution-store.js`。
- [x] 实现计划字段、标签集合、保存视图和事件的事务写入。
- [x] 实现 board 批量读取，避免 N+1。
- [x] 新增 `server/execution-projection.js`，组合 attention reasons 和 `historyStatus`。
- [x] 计划字段无变化时不追加事件。
- [x] 事件操作使用 `crypto.randomUUID()` correlation ID。

验证：

- 无效日期、超长文本、空标签和重复标签被提前拒绝。
- 同一次计划更新失败时标签和事件均不写入。

### 4. HTTP 边界

- [x] 增加统一任务解析函数，复用白名单与 `.trellis/tasks` 根校验。
- [x] 新增 `PUT /api/tasks/execution`。
- [x] 新增保存视图 POST/PUT/DELETE 路由。
- [x] `/api/board` 和 `/api/task` 叠加执行投影。
- [x] 人工阶段写入与 `stage_manual_confirmed` 事件同事务提交。
- [x] `server/repositories.js` 删除项目时清理 v2 扩展数据。
- [x] 提升 `SCAN_SCHEMA_VERSION` 并更新缓存兼容测试。

验证：

- 不存在任务、越界路径、非白名单项目均返回中文错误。
- 成功写后重新 GET 能读回；失败无部分写入。

### 5. 扫描阶段观察

- [x] 在刷新编排中对比上一 board 与新 board 的 `derivedStage`。
- [x] 首次 v2 只写 `tracking_started`，不补旧阶段事件。
- [x] 后续真实变化写 `stage_observed`，时间使用扫描完成时间。
- [x] 归档任务不建立停滞基线。

验证：

- 第一次扫描事件只有基线和人工写入，没有伪造旧阶段。
- 修改阶段证据后，下一次扫描恰好新增一条对应观察事件。

### 6. 浏览器纯函数与页面

- [x] 新增 `public/execution-filter.js`，实现默认日期、标签规范化和组合筛选匹配。
- [x] 新增 `tests/execution-filter.test.js`。
- [x] 按原型重排首屏，保留现有导航、项目筛选和三个主视图。
- [x] 增加保存视图行、推荐卡、注意力队列和计划字段摘要。
- [x] 新增计划字段 `<dialog>`，卡片与详情复用。
- [x] 新增组合视图 `<dialog>` 和自定义视图删除。
- [x] 动态节点重绘后重新绑定任务、编辑、视图、对话框事件。
- [x] 所有动态文本使用 `safe()`；图标按钮有 `aria-label`；保留键盘焦点。
- [x] 样式扩展现有 `:root` token，并在 1180px/860px 断点验证。

验证：

- 计划编辑失败保留输入，保存成功从 API 读回。
- 视图切换后任务、阶段、负责人和搜索筛选仍正确。
- 1440px 与 860px 以下无页面级横向溢出。

## 最终验证

全部开发完成后只执行一次完整验证：

```powershell
npm test
Get-ChildItem server,public,tests -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }
node server/index.js
```

真实浏览器验收：

- [x] 首页加载、空状态和服务端错误状态。
- [x] 从卡片与详情各修改一次计划字段。
- [x] 停止服务并重开，字段和自定义视图仍存在。
- [x] 检查目标仓库 `task.json` 未变化。
- [x] 任务详情阶段确认后，事件时间线出现人工来源事件。
- [x] 归档索引、团队视图、项目管理和创建任务无回归。
- [x] 键盘 Tab/Enter/Space、焦点样式、对话框关闭正常。
- [x] 浏览器控制台和网络请求无新增未处理错误。

## 风险与回滚

- `database.js` 迁移是最高风险点；测试失败时修迁移，不绕过版本检查。
- 列表投影增加字段后一次更新所有消费者，避免详情与列表身份不一致。
- 页面重排前记录现有视图切换和轮询行为，回归失败时优先恢复原信息层级。
- 未通过完整检查前不提交，不运行破坏性 Git 命令。
