# 目录与模块

## 文件职责

| 路径 | 职责 |
| --- | --- |
| [public/index.html](../../../public/index.html) | 静态页面结构、原生 `<dialog>`、表单、`aria-*`、模块入口 |
| [public/app.js](../../../public/app.js) | 页面集成层：全局状态、API、渲染、事件、筛选、轮询 |
| [public/markdown.js](../../../public/markdown.js) | 精简 Markdown 渲染、HTML 转义、安全链接过滤 |
| [public/slug.js](../../../public/slug.js) | 任务标识生成、规范化与格式正则 |
| [public/archive-sort.js](../../../public/archive-sort.js) | 归档时间格式和稳定排序 |
| [public/styles.css](../../../public/styles.css) | 设计 token、布局、组件外观、响应式和减少动态效果 |
| [tests](../../../tests) | Node 内置测试；浏览器纯模块也在这里做单元验证 |

## 模块边界

[public/app.js](../../../public/app.js) 是集成根，可以依赖其他 `public/*.js`。纯函数模块不能反向依赖 `app.js`，也不应直接查询页面 DOM。

`public/slug.js` 同时被浏览器和 [server/actions.js](../../../server/actions.js) 导入。它必须保持无 Node 专属依赖、无 DOM 依赖，只做纯字符串处理。新增跨端共享模块前先确认它能在 Node 和浏览器两种运行时直接加载。

Markdown 和归档排序已经有独立模块与测试。不要在 `app.js` 再复制正则、比较器或 HTML 转义表。

## 命名

- 文件和目录使用小写 kebab-case，例如 `archive-sort.js`。
- 纯函数使用动词或领域名，例如 `normalizeTaskSlug()`、`sortArchivedTasks()`。
- 页面渲染函数使用 `renderX()`，事件绑定使用 `bindX()`，取数或加载使用 `loadX()`。
- DOM 引用集中放在 `els`；只有动态生成的局部节点在绑定函数里查询。
- CSS class 使用现有语义名和 `is-*` 状态名，例如 `is-active`、`is-live`、`is-risk`。

## 新增模块的落点

- 浏览器和 Node 都需要、且完全无环境依赖：放 `public/`，并从明确命名的小模块导出。
- 只在浏览器使用且涉及 DOM：优先留在 `app.js` 的渲染/绑定边界；逻辑超过单页职责时再拆独立模块。
- 只计算任务阶段、文件证据或缓存：放 `server/`，不要塞进前端。
- 只用于测试夹具：放对应 `tests/*.test.js`，不要为测试把临时逻辑加入生产模块。

## 反模式

- 引入 `node:fs`、`node:path` 到 `public/`。
- 为一个工具函数新建 `shared/`、`utils/` 多层目录，却没有真实第二消费者。
- 在 `index.html` 写大段业务数据或模板，绕过现有渲染函数。
- 在多个模块各写一份 slug 正则或 Markdown 链接白名单。
