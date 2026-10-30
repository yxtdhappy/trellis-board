# 前端质量规范

## 运行与测试

- 运行时要求 Node `>=24`；当前开发机验证版本为 Node `24.21.0`。
- 启动：`node server/index.js`、`npm start` 或 `npm run board`。
- 自动测试：`npm test`，执行 `node --test tests/*.test.js`。
- 项目没有 lint、TypeScript 类型检查或前端构建。不要声称这些检查已通过。

现有自动测试覆盖 Markdown、slug、归档排序、组合筛选、标签输入和阻断条件等纯模块；没有 DOM 自动化测试套件。改变布局、事件、对话框、轮询或真实 API 交互时，除单元测试外还必须用浏览器做真实页面验收。

## JavaScript

- 使用现有双引号、分号、两空格缩进和 ESM `import/export`。
- 优先小函数和明确数据流，保持与 `renderX/bindX` 一致的页面结构。
- 对服务端输入做必要的形状/空值兜底，但不要为不可能发生的状态堆叠多层错误处理。
- 只在本次改动造成时清理未使用变量或导入。

## DOM 与可访问性

- 可点击控件使用 `<button type="button">`，表单提交按钮使用明确 `type="submit"`。
- 页面已有语义结构：`aside`、`nav`、`main`、`section`、`dialog`；新增区域沿用并建立标题关联。
- 纯装饰图标加 `aria-hidden="true"`；无可见文字的图标按钮必须有 `aria-label`。
- 动态扫描/选择区域按现有模式使用 `aria-live="polite"`。
- 所有交互控件必须保留键盘可达性，并继承统一 `:focus-visible` 样式。
- 错误不能只靠颜色表达；保留文字说明。

## 样式

- 设计值优先使用 [public/styles.css](../../../public/styles.css) 中 `:root` 的 CSS 变量。
- 主布局是 `.app-shell` 两列 grid；`1180px` 和 `860px` 是两个现有断点。
- 新增动画必须兼容 `prefers-reduced-motion: reduce`。
- 不使用 CSS-in-JS、Tailwind、组件库或第二份全局重置。
- 当前字体通过 CSS 顶部 Google Fonts `@import` 加载；新增离线/企业网络约束时要单独评估，不要默默改变字体依赖。

## 安全检查

- 动态 HTML 只用 `safe()` 或 `renderMarkdown()` 处理。
- 禁止 `eval()`、动态 `<script>`、事件属性字符串和未校验的 `javascript:` URL。
- 新增内联事件处理器前先使用现有 `addEventListener` 模式。
- 任何写操作都通过 `api()`，失败时展示后端中文错误，不吞异常。

## 页面验收

涉及 UI 的改动至少验证：

1. 首屏加载、空白状态、服务端错误状态。
2. 键盘 Tab、Enter/Space 和 `:focus-visible`。
3. `860px` 以下布局不横向溢出，对话框可关闭。
4. 流水线、团队、归档三个视图切换正常。
5. 写操作成功后数据从 API 重新读回；失败时输入不丢失。
6. 浏览器控制台和网络请求没有新增未处理错误。
7. 依赖表单在 860px 以下不重叠、可 Tab 操作、可用 Escape 关闭对话框。
8. 阻断原因、方向和解除状态都有文本，不只依赖颜色。

## Review 清单

- [ ] 没有引入不存在的框架、构建链或类型系统。
- [ ] 动态内容已转义，Markdown 未绕过既有渲染器。
- [ ] 重新渲染的区域已重新绑定监听器。
- [ ] 依赖创建、解除和 WIP 保存按钮都有处理中状态和防重复提交。
- [ ] 阻断筛选缺失 `blocked` 字段时按 `any` 处理，旧保存视图继续工作。
- [ ] DoR/DoD 折叠内容是服务端派生缺口，不是前端第二套流程状态。
- [ ] 轮询只有一个活动计时器。
- [ ] 新 UI 有语义标签、键盘路径和可见焦点。
- [ ] 纯函数测试与实际浏览器验收都覆盖到改动风险。
