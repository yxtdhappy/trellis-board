# 渲染与状态

## 状态模型

[public/app.js](../../../public/app.js) 使用单个模块级 `state` 对象，不依赖响应式框架或浏览器持久化。当前状态分为：

| 类别 | 字段示例 | 说明 |
| --- | --- | --- |
| 服务端快照 | `board`、`status` | 只由 API 成功响应更新 |
| 当前视图 | `view`、`projectId`、`scope`、`search`、`executionView` | 页面筛选；保存视图本身由 API 返回，不复制到长期状态 |
| 任务详情 | `selectedTask` | 当前打开或加载中的详情 |
| 归档筛选 | `archiveProject`、`archiveSearch` | 只影响归档视图 |
| 请求状态 | `loading`、`pollTimer`、`pickingFolders`、`addingProjects` | 控制禁用、轮询和表单反馈 |
| 创建表单 | `selectedFolders`、`createSlugManuallyEdited` | 对话框内临时状态 |

新增状态先判断是否可由 `state.board` 推导。能直接推导的显示值不要复制一份长期状态。

`flow`、任务 `execution` 摘要和详情完整依赖数组都来自 `/api/board` 与 `/api/task`；不要在前端自行重建依赖图。WIP 上限写入 `board_state` 后必须重新读取 Board。

## 渲染模式

页面没有虚拟 DOM，模式是：

```text
事件或 API 响应
  -> 更新 state
  -> renderX()
  -> 用模板字符串生成 HTML
  -> 对重新生成的动态节点重新 bindX()
```

`renderAll()` 依次刷新项目、指标、流水线、团队、归档和视图标题。局部变化可以只调用对应 `renderX()`，例如搜索输入只重绘指标、流水线和团队。

动态区域使用 `innerHTML` 后，旧节点上的监听器会消失。新增动态按钮时必须在对应 `bindTaskButtons()`、`bindArtifactButtons()`、`bindStageActions()` 或局部绑定函数中重新注册事件。

## 个人执行视图计数

- `baseFilteredActiveTasks({ executionView })` 是执行视图计数的统一入口，必须先组合项目、负责人、搜索和执行视图条件，再做任务组展开。
- 任务组中任一成员命中时，计数和 `renderTaskFamily()` 都使用展开后的全部组成员；流水线槽位显示组数量，因此“1 个组 / 4 个任务”不是计数冲突。
- 所有视图按钮、`execution-view-summary`、顶部“进行中”和流水线实际任务必须来自同一过滤结果。按钮计数可以一次计算多个视图，但不得为每个计数单独重绘 DOM 或修改筛选状态。
- 流动信号中的 WIP 是个人全局承载量，必须使用 Board `flow.implementationWip` / `flow.wipState`，不能随当前项目、负责人或搜索过滤子集重算；阻断、已解除和 DoR/DoD 队列可保持当前筛选范围。“被阻断”使用 `blocked` 过滤，“阻断已解除”使用 `isUnblockedReady`，两者不是同一条件。

## 风险与依赖详情

- 详情请求返回活动 `execution.blockedBy` / `execution.blocks`、已结束 `resolvedBlockedBy` / `resolvedBlocks` 和 `risk.dorMissing` / `risk.dodMissing`；列表没有这些完整数组时显示读取中，不应把缺失字段当成“无依赖”。
- 被阻断、反向阻断和解除按钮必须使用文本说明方向与原因。动态标题、项目名、创建人、原因、时间和依赖 ID 进入模板前都要经过 `safe()`。
- 已结束依赖放在默认折叠的历史区，显示原方向、原因、创建时间、解除时间和固定区间时长；不能把 `durationMs` 继续按当前时间重算。
- 创建或解除失败时保留 blocker 选择、原因输入和当前详情节点；成功后才重新读取 Board 与详情。提交期间禁用对应按钮，防止重复写入。
- DoR/DoD 折叠项只解释派生缺口，不得据此禁用阶段按钮。

## 任务组层级呈现

- 团队视图先按负责人分卡，再在卡内按 `groupKey` 组织任务；`groupKey` 相同时不得继续平铺成员。
- 真实父任务只能从完整 `state.board` 的同组成员中按 `groupRole === "parent"` 解析。负责人筛选可能把父子拆到不同卡；子任务所在卡必须显示父任务标题和负责人上下文，不能把 `members[0]` 或子任务自身兜底成父任务。
- Kanban 组头显示真实父任务及完整子任务数；子任务使用连续树线、分支端点和同级裂变按钮，不把计划按钮嵌套进任务按钮。
- 注意力队列保持原排序和截断顺序，只给组内子任务附加紧凑父路径；父路径缺失时显示“组内子任务”，不得据此调整优先级。
- 子任务数与父上下文来自组关系，不在每个成员行重复“N 个任务一组”。任何新增任务或计划按钮仍使用原生并列按钮，并在 `innerHTML` 后重新绑定。

## 服务端数据

`/api/board` 初始化 `state.board`，之后由状态轮询发现新的 `generatedAt` 再加载。任务详情通过 `openTask()` 和 `loadTaskDetail()` 按需请求 `/api/task`，使用 `taskKey` 找回列表任务并合并详情。

不要假设列表任务包含 `artifacts` 正文。[server/loader.js](../../../server/loader.js) 的列表投影会删除大字段；只有详情响应可读取产物内容。

## API 调用

所有页面请求统一走 [public/app.js](../../../public/app.js) 的 `api()`：

- 有请求体时自动设置 JSON 请求头并序列化请求体。
- 尝试解析 JSON 错误体。
- 非 2xx 时抛出 `payload.error`，调用方使用 `showError()` 或表单消息展示。
- `fetch` 自身失败时转换为中文连接错误，不把浏览器的 `Failed to fetch` 直接展示给用户。

新增请求不要直接写第二套 `fetch` 错误处理。涉及写操作时，成功响应后重新加载看板，保持服务端为事实来源。

## 轮询生命周期

`scheduleStatusPoll()` 当前节奏：

- 常规：750ms。
- 正在刷新或排队：250ms。
- 请求失败：1500ms。
- 页面重新可见：立即调度一次。

轮询发现 `status.lastRefreshAt !== state.board.generatedAt` 后才加载完整 board；没有新数据时只更新同步状态文案。新增定时任务必须沿用单计时器 `state.pollTimer`，避免重复轮询。

## 对话框

任务详情、产物、创建任务、项目管理、计划字段和组合视图使用原生 `<dialog>`，通过 `showModal()` 打开、`close()` 关闭。关闭按钮使用各自的 `data-close-*` 分组绑定。计划字段从卡片和详情打开同一对话框；成功后重新读取 Board，失败时保留输入。

对话框提交失败时保留用户输入，在对话内的 `form-message` 或页面错误条显示中文错误；成功后按现有流程清空或刷新。

短高度视口中的长表单必须使用固定行布局：标题、提示、错误消息和主操作保持在视口内，只允许表单主体 `.form-grid` 在 `minmax(0, 1fr)` 行内滚动。不要依赖整张 dialog 的 `overflow-y` 承载表单滚动；错误消息出现或移动端 footer 变成纵向排列时，主操作仍必须可见。

## DOM 安全

- 所有动态文本和属性值进入模板前使用 `safe()`。
- 任务产物只通过 `renderMarkdown()` 输出；它会转义原始 HTML 并限制链接协议为 `#`、`http:`、`https:`、`mailto:`。
- 错误条和普通消息优先使用 `textContent`，不要拼接原始 HTML。
- 表单值来自服务端时仍要转义，例如 `<option value="${safe(member)}">`。
- 新增链接时不要在 `app.js` 自建 URL 白名单；复用 Markdown 安全规则或抽成有测试的浏览器模块。
- 任务卡内部的可操作控件必须是并列原生按钮。打开任务的透明按钮和计划编辑按钮不能互相嵌套，避免形成无效的可访问性树。

## 反模式

- `innerHTML` 中直接插入 `task.title`、错误文本或服务端路径。
- 只更新 `state` 却不重新渲染，或只改 DOM 而不更新 `state`。
- 在轮询回调里递归创建多个计时器。
- 点击任务后假设列表对象已经有完整产物。
- 把 `task.stages` 当成不可变顺序以外的对象映射；当前前端同时依赖数组顺序和阶段 `index`。
