# 前端开发规范

适用范围：`public/`。当前前端是原生 HTML、CSS 和浏览器 ES Module，没有 React、Vue、组件框架、Hooks、TypeScript、打包器或构建步骤。

## 规范索引

| 文档 | 内容 |
| --- | --- |
| [目录与模块](./directory-structure.md) | 文件职责、命名、浏览器与 Node 共用模块 |
| [渲染与状态](./rendering-and-state.md) | 全局 `state`、`renderX/bindX`、对话框、轮询、DOM 安全 |
| [质量与验证](./quality-guidelines.md) | 测试、可访问性、响应式、CSS 和浏览器验收 |

## 页面入口

- [public/index.html](../../../public/index.html) 是唯一页面骨架，末尾用 `<script type="module" src="/app.js">` 启动。
- [public/app.js](../../../public/app.js) 负责取数、全局状态、视图渲染、事件绑定和轮询。
- [public/styles.css](../../../public/styles.css) 是唯一主样式文件。
- 页面数据来自 [server/index.js](../../../server/index.js) 暴露的 `/api/*`，不直接读取仓库文件。

## 必须记住的契约

- 首批静态节点通过 `#id` 被 `els` 集中引用；静态节点改名时必须同步 `public/index.html`、`public/app.js` 和 `public/styles.css`。
- 动态任务按钮使用 `data-task="${taskKey}"`，项目和目录操作也使用 `data-*` 属性传递稳定标识。
- 列表先显示由 `/api/board` 返回的轻量任务；打开详情时再请求 `/api/task`。
- 所有来自服务端或用户输入的文本必须先经过 `safe()` 才能进入模板字符串；Markdown 只走 `renderMarkdown()`。
- 修改阶段顺序时检查 `STAGE_LANES` 的下标映射，以及详情页对 `task.stages` 的顺序假设。

## 当前明确不做

- 不为单个页面引入框架、组件库或构建链。
- 不把前端改成 TypeScript；运行时校验和转义才是当前边界。
- 不把 Node 内置模块导入浏览器代码。
- 不把 API 数据处理逻辑复制进多个渲染函数；需要复用时应新建独立浏览器模块。
