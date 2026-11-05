# 技术设计 · shadcn React 重写

## 1. 现状与约束

- 服务端：`server/index.js` 通过 `serveStatic()` 直接把 `public/` 目录下的文件送出（路径穿越已校验），API 全在 `handleApi()`。
- 前端：三个 HTML + 6 个浏览器模块，纯 `innerHTML` 模板渲染，无状态库、无类型、无构建。
- 测试：`node --test tests/*.test.js`，其中 6 个模块被直接 import（`dom.js`、`team-client.js`、`markdown.js`、`slug.js`、`execution-filter.js`、`archive-sort.js`）——这些是纯函数，必须原样保留。

## 2. 目标工程结构

```
web/                        # Vite root（源码）
  index.html                # 看板入口
  admin.html                # 管理台入口
  login.html                # 登录入口
  src/
    main/                   # 各页面引导（createRoot + Provider）
    pages/                  # board / admin / login 页面级组件
    features/               # 按域拆分的业务组件（kanban, attention, archive, team, admin-*, dialogs）
    api/                    # fetch 封装与 DTO 归一化（对应现有 /api/* 调用）
    hooks/                  # useBoard / usePolling / useTheme / useDialog
    lib/                    # 纯逻辑模块（由 public/ 原样迁入，供测试共用）
    components/ui/          # shadcn 生成的原语（button/card/badge/dialog/...）
    styles/globals.css      # Tailwind + shadcn token
public/                     # 构建产物（Vite outDir），由 Node 直接托管
```

**构建**：`web/vite.config.ts` 设 `root=web`、`build.outDir=../public`、`emptyOutDir=true`、`rollupOptions.input` 指向三个 HTML。产物为 `public/index.html`、`public/admin.html`、`public/login.html` + `public/assets/*`。服务端无需改动即可托管；`serveStatic` 的 `/` → `index.html` 映射继续生效。

**开发**：`vite dev` 仅在用户明确要求时启动；`server.proxy` 把 `/api` 转发到 `http://127.0.0.1:4317`。

## 3. 依赖与主题

- 依赖：`react`、`react-dom`、`vite`、`@vitejs/plugin-react`、`typescript`、`tailwindcss`、`@tailwindcss/vite`、`lucide-react`、`clsx`、`tailwind-merge`、`class-variance-authority`，以及 `shadcn` CLI 生成的原语所需 `@radix-ui/*` 子包。
- 初始化：`npx shadcn@latest init -t vite -p b3awTjpuKm`（style=mira / neutral / violet / indigo / Inter + Geist / radius default），随后按需 `add button card badge dialog tabs table input select switch checkbox avatar progress pagination tooltip dropdown-menu sonner`。
- token：`globals.css` 使用 `@theme inline` 暴露 `--color-*`，`:root` 与 `.dark` 两套变量；`.dark` 类由 `useTheme` 写到 `<html>`，同时设置 `color-scheme`。
- 与设计稿对齐：设计文件中的 `--primary #7008E7 / #5D0EC0` 与 preset violet 对齐；若 presets 生成值与设计稿有差，以设计稿为准并在 `globals.css` 中覆盖并注释来源。

## 4. 数据流与状态

```
API (/api/board, /api/task, /api/team/*, /api/admin/*)
        │  fetch + AbortController
        ▼
api/*.ts（归一化 DTO，保持现有字段名）
        ▼
hooks（useBoard / useTeam / useAdmin）—— 页面级单一数据源
        ▼
页面组件 → feature 组件 → shadcn 原语
```

- **轮询**：沿用现有 `setInterval` + `document.visibilityState` 判定；团队模式复用 ETag 请求头，304 时跳过状态更新，避免无谓重渲染。
- **弹层状态**：每个弹层一个 `useDialog` 控制器（open/close/esc/焦点回收），不引入全局 store。
- **列表轻量 → 详情按需**：保持 `/api/board` 只给轻量任务、打开详情才请求 `/api/task` 的既有契约。
- **错误处理**：请求失败走 toast + 局部占位，不阻塞整页；写操作失败保留表单输入。

## 5. 组件映射（设计稿 → 实现）

| 设计元素 | 实现 |
| --- | --- |
| 顶栏按钮 / 图标按钮 | `Button`（default/outline/ghost/destructive/sm/icon） |
| 卡片、面板 | `Card` + `CardHeader/Content/Footer` |
| 优先级、状态、阶段 | `Badge`（default/secondary/outline/destructive） |
| 弹层（9 类） | `Dialog` + `DialogContent`，Esc/遮罩关闭 |
| 管理台 tab | `Tabs` |
| 团队/归档/审计列表 | `Table` + 自研 `Pagination`（保留现有页码语义） |
| 表单 | `Input`、`Select`、`Switch`、`Checkbox`、`Textarea`、`Label` |
| 头像 | `Avatar` |
| 13 阶段证据条 | 自研 `StageTape`（13 段 `div`，gap 1，语义色） |
| 账号菜单 / 项目操作 | `DropdownMenu` |
| 提示 | `sonner` toast |
| 侧栏项目列表 | 自研 `ProjectRail`（沿用 `$--sidebar-*` token） |

## 6. 兼容性与迁移

- **纯逻辑模块**：`public/dom.js` → `web/src/lib/dom.ts`（保持不变逻辑）、`team-client.js`、`markdown.js`、`slug.js`、`execution-filter.js`、`archive-sort.js` 同样迁入 `web/src/lib/`；`tests/*.test.js` 的 import 路径同步更新，断言一字不改。
- **API 契约**：请求方法、路径、字段名、查询参数全部保持；`tests` 中的服务端测试不动。
- **安全**：React 默认转义，但 Markdown 走 `dangerouslySetInnerHTML` 时必须复用 `renderMarkdown()`（其内部已 `escapeHtml`）。禁止任何直接 `dangerouslySetInnerHTML` 拼接未转义文本。
- **删除策略**：新页面每完成一页并验收后，删除对应旧文件；全部完成后 `public/` 只保留构建产物。旧 `styles.css`/`team.css` 的样式资产在对照完成后删除。

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 看板行为漏项（160 个旧函数） | 功能回归 | 以现有 `els` id + 事件绑定为清单逐条移植；每阶段跑目标检查 |
| 轮询/ETag 语义变化 | 团队模式重复请求或数据滞后 | 保留原请求封装，304 分支单测覆盖 |
| 构建产物污染 `public/` | 旧文件残留或误删 | `emptyOutDir=true` + 首次构建前 git 检查；产物只由 build 生成 |
| 深色主题对比度 | 可读性 | 使用 preset 变量，不硬编码颜色；对照设计稿深色画板检查 |
| 规范冲突 | 后续任务违规 | 本任务内更新 `.trellis/spec/frontend/` |

**回滚**：单一提交完成切换；出问题 `git revert` 即可恢复旧 `public/`，`server/` 未改动，不涉及数据迁移。

## 8. 验证方式

- 目标检查：`node --test tests/*.test.js`；被迁移模块的单测保持绿。
- 构建交付：`npm run build` 后 `node server/index.js`，浏览器核对三个入口与设计稿关键画板。
- 不把 build/dev server 作为每步例行验证手段，仅在阶段末与交付前执行。
