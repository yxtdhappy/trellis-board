# 渲染与状态

## 状态模型

[public/app.js](../../../public/app.js) 使用单个模块级 `state` 对象，不依赖响应式框架或浏览器持久化。当前状态分为：

| 类别 | 字段示例 | 说明 |
| --- | --- | --- |
| 服务端快照 | `board`、`status` | 只由 API 成功响应更新 |
| 当前视图 | `view`、`projectId`、`scope`、`search` | 页面筛选，不写回服务端 |
| 任务详情 | `selectedTask` | 当前打开或加载中的详情 |
| 归档筛选 | `archiveProject`、`archiveSearch` | 只影响归档视图 |
| 请求状态 | `loading`、`pollTimer`、`pickingFolders`、`addingProjects` | 控制禁用、轮询和表单反馈 |
| 创建表单 | `selectedFolders`、`createSlugManuallyEdited` | 对话框内临时状态 |

新增状态先判断是否可由 `state.board` 推导。能直接推导的显示值不要复制一份长期状态。

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

## 服务端数据

`/api/board` 初始化 `state.board`，之后由状态轮询发现新的 `generatedAt` 再加载。任务详情通过 `openTask()` 和 `loadTaskDetail()` 按需请求 `/api/task`，使用 `taskKey` 找回列表任务并合并详情。

不要假设列表任务包含 `artifacts` 正文。[server/loader.js](../../../server/loader.js) 的列表投影会删除大字段；只有详情响应可读取产物内容。

## API 调用

所有页面请求统一走 [public/app.js](../../../public/app.js) 的 `api()`：

- 有请求体时自动设置 JSON 请求头并序列化请求体。
- 尝试解析 JSON 错误体。
- 非 2xx 时抛出 `payload.error`，调用方使用 `showError()` 或表单消息展示。

新增请求不要直接写第二套 `fetch` 错误处理。涉及写操作时，成功响应后重新加载看板，保持服务端为事实来源。

## 轮询生命周期

`scheduleStatusPoll()` 当前节奏：

- 常规：750ms。
- 正在刷新或排队：250ms。
- 请求失败：1500ms。
- 页面重新可见：立即调度一次。

轮询发现 `status.lastRefreshAt !== state.board.generatedAt` 后才加载完整 board；没有新数据时只更新同步状态文案。新增定时任务必须沿用单计时器 `state.pollTimer`，避免重复轮询。

## 对话框

任务详情、产物、创建任务和项目管理使用原生 `<dialog>`，通过 `showModal()` 打开、`close()` 关闭。关闭按钮使用 `data-close-dialog`、`data-close-artifact`、`data-close-create`、`data-close-projects` 分组绑定。

对话框提交失败时保留用户输入，在对话内的 `form-message` 或页面错误条显示中文错误；成功后按现有流程清空或刷新。

## DOM 安全

- 所有动态文本和属性值进入模板前使用 `safe()`。
- 任务产物只通过 `renderMarkdown()` 输出；它会转义原始 HTML 并限制链接协议为 `#`、`http:`、`https:`、`mailto:`。
- 错误条和普通消息优先使用 `textContent`，不要拼接原始 HTML。
- 表单值来自服务端时仍要转义，例如 `<option value="${safe(member)}">`。
- 新增链接时不要在 `app.js` 自建 URL 白名单；复用 Markdown 安全规则或抽成有测试的浏览器模块。

## 反模式

- `innerHTML` 中直接插入 `task.title`、错误文本或服务端路径。
- 只更新 `state` 却不重新渲染，或只改 DOM 而不更新 `state`。
- 在轮询回调里递归创建多个计时器。
- 点击任务后假设列表对象已经有完整产物。
- 把 `task.stages` 当成不可变顺序以外的对象映射；当前前端同时依赖数组顺序和阶段 `index`。
