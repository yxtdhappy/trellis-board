# 前端质量规范

## 运行与检查

- 运行时要求 Node `>=24`。
- 类型检查与构建：`npm --prefix web run build`（`tsc -b && vite build`，产物写入 `public/`）。
- 单元测试：`npm test`（`node --test tests/*.test.js`）。
- 格式化：`npm run format`（`oxfmt .`）、`npm run format:check`（CI 用）。oxfmt 是唯一格式化工具，配置在根 `.oxfmtrc.json`（`printWidth 100`、无分号、单引号、2 空格、LF），不要再引入 Prettier/ESLint 格式化规则；改完代码先跑 `npm run format`。
- 本地联调：`npm run web:dev`（Vite 代理由 `/api` → `127.0.0.1:4317`，先 `npm start` 起服务端）。
- 交付前必须实际打开 `/`、`/admin.html`、`/login.html` 验收；构建成功不等于功能正确。

## TypeScript

- 禁止 `any` 与 `as any`；外部数据先按 `unknown` 接收，再用类型守卫或窄接口收敛。
- 只在无法运行时校验的位置使用 `as`，并在同一行标注原因。
- 组件 props 与 hook 返回值都要有名字的类型；不要用 `ReturnType<typeof fn>` 发布契约。
- `verbatimModuleSyntax` 打开：类型导入使用 `import type`。

## React

- 状态放在最靠近使用的组件；跨组件共享才提升到 hook。
- 副作用只在 `useEffect` 中发生，并在清理函数里释放定时器、监听器和 AbortController。
- 列表 `key` 使用业务键（`taskKey`、`userId`），不用数组下标。
- 不为了复用而抽抽象；出现第三处相同逻辑再提取。

## 可访问性

- 交互元素用 `<button type="button">` 或 shadcn `Button`；表单提交按钮 `type="submit"`。
- 图标按钮必须有 `aria-label` 或 `title`；装饰图标 `aria-hidden="true"`。
- 弹层依赖 `role="dialog"`、Esc 关闭与焦点回收（由 `components/ui/dialog` 保证）。
- 错误提示用文本表达，不只靠颜色。

## 样式

- 只用 token 类：`bg-background`、`text-foreground`、`border-border`、`text-muted-foreground`、`bg-primary` 等。
- 间距与圆角沿用现有尺度（卡片 `rounded-xl p-4`、按钮 `h-8 text-xs`、徽章 `rounded-full px-2 py-0.5`）。
- 深色模式必须验证：任何写死颜色的类都会在 `.dark` 下失效。
- 窄屏：管理台两列在 `<1024px` 折叠为单列；看板侧栏在 `<1024px` 隐藏。

## 测试边界

- 纯逻辑模块（`web/src/lib/*.js`、`shared/slug.js`）的现有断言必须保留；迁移只能改 import 路径。
- 组件内部状态重置所需的纯守卫优先放入 `web/src/lib/*.js`，由现有 Node 测试覆盖，不为单个
  条件引入 React 渲染测试框架。
- 不要新增“读取源码文本”的断言（例如匹配函数名或字符串字面量）；行为用单元测试或浏览器验收证明。
- 改变 API 请求形状时必须同步 `server/` 侧测试与 `.trellis/spec/backend/`。
