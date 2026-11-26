# 公司 Wiki 前后端规范清单（用于模板内容规划）

> 检索方式：Confluence PAT 登录 + REST API；base URL `http://wiki.weintdata.cn`。以下 pageId、版本、行数来自 2026-11-25 的实际读取。Wiki 内容属于公司内部资料，模板中只保留 pageId/版本/标题作为来源，不复制敏感信息。

## 1. 前端规范

### 1.1 当前主目录

《01前端开发代码编写与流程规范》pageId **114165874**，位于 Develop 空间。页面本身正文为空（导出仅 20 行），但有 14 个子页，是当前前端规范的目录页。

| 子页 | pageId | 版本/日期 | 规模 | 内容要点 | 模板去向 |
| --- | --- | --- | --- | --- | --- |
| 前端代码编写通用规范 | 28444179 | V8 / 2026-08-12 | 415 行 | Vue SFC、CSS 变量、页面/表单、接口/Vuex/权限、国际化、提交检查清单 | `frontend-vue2/references/` |
| 前端MOM3.0子应用开发规范 | 43164694 | V13 / 2026-06-04 | 453 行 | 版本锁定 node 16.20.2、Vue ^2.6.11、ant-design-vue 1.7.8、echarts ^5.3.3、vue-router ^3.3.4、@micro-zoe/micro-app ^0.8.10；目录结构、路由、通用 CRUD | `frontend-mom3/` |
| 前端技术栈选型（Web / PDA / 桌面端） | 131355439 | 2026-10-28 | — | 技术栈边界与选型 | `common/` 或 `guides/` |
| 前端Web/PDA通用格式化 | 131344513 | — | — | 格式化约定 | `frontend-vue2/references/` |
| 前端源码交付规范 | 114186651 | — | — | 源码交付 | `common/` |
| 客户端前端统一设计变量与主题规范 | 131345424 | — | — | 设计变量/主题 | `frontend-vue2/references/` |
| 前端按钮权限与可操作状态规范 | 131349785 | — | — | 按钮权限/状态 | `frontend-vue2/references/` |
| MOM3 Web 操作按钮与 Icon 开发规范 | 131351008 | — | — | MOM3 按钮/Icon | `frontend-mom3/references/` |
| 前端国际化英文大小写与组件开发规范 | 131351797 | — | — | 国际化大小写 | `frontend-vue2/references/` |
| 国际化开发文档 | 28445449 | — | — | i18n 流程 | `frontend-vue2/references/` |
| 国际化新增语言文档 | 131339383 | — | — | 新增语言 | `frontend-vue2/references/` |
| 前端开发环境与依赖管理 | 43164194 | — | — | 环境/依赖 | `frontend-vue2/references/` |
| PDA打包流程 | 70796753 | — | — | PDA 打包 | `frontend-vue2/references/`（按需） |
| MOM3.0前端定制服务开发手册 | 104537886 | — | — | MOM3 定制 | `frontend-mom3/references/` |

### 1.2 旧版/其他

- 《前端开发规范（PC）》pageId **12681910**，YYZX 空间，V5 / 2023-06-28，450 行；命名、注释、HTML/CSS/JS、性能、前端校验。较旧，作为补充而非主来源。
- 《前端开发规范》pageId **7766571**，SPC 空间，2022-12 创建，**空页**（无正文、无子页）。SPC 总入口不可用，实际规范在 Develop 空间。

## 2. 后端规范

| 文档 | pageId | 版本/日期 | 规模 | 内容要点 | 模板去向 |
| --- | --- | --- | --- | --- | --- |
| 后端服务开发规范 | 7766573 | V119 / 2026-05-28 | 855 行 | 文件格式、工程/包/类命名、常量/变量/方法、编码风格、高效编码、数据库、SQL、缓存、接口、Kafka | `backend-java/`（按主题拆 references） |
| 后端SDK开发规范 | 52858212 | 2026-01-22 | — | SDK 设计/命名/兼容 | `backend-java/references/sdk.md`（按需） |
| 软件开发交付规范 | 6062284 | 2026-08-27 | — | 交付物/流程 | `common/` |
| 错误提示消息设计规范 | 87729359 | 2025-07-15 | — | 错误码/文案 | `common/` |
| 开发分支管理总图 | 7766045 | — | — | 分支模型 | `common/` |
| MOM3.0 后端服务开发规范 | 58634174 | 2024-11-11 | — | MOM3 后端特定 | `backend-java/references/mom3.md` |
| MOM3.0 后端SDK开发规范 | 58634181 | — | — | MOM3 SDK | 同上（按需） |
| MOM3.0 后端服务开发手册 | 58632067 | 2026-08-31 | — | 开发手册 | 同上（按需） |
| MOM3.0 后端定制服务开发手册 | 104537762 | — | — | 定制服务 | 同上（按需） |

## 3. 内容与项目技术栈的匹配

本项目 `trellis-board` 的技术栈（事实）：

- `packages/web`：React 19 + TypeScript + Vite 8 + Tailwind 4 + shadcn/@base-ui + monaco。
- `packages/server`：Node.js ESM（cookie/dotenv/pino/pino-roll，无 Web 框架）。
- 根 `package.json`：`engines.node >= 24`、`packageManager yarn@3.5.0`。
- 桌面端：Tauri（Rust）。

结论：

- 公司现有前端规范是 **Vue 2 + ant-design-vue**，不能直接套到 React 19；需要 `frontend-react` 适配版（通用条款 + React 对应实现）。
- 公司后端规范是 **Java/Spring**，不能直接套到 Node；需要 `backend-node` 适配版（错误处理、日志、接口、分层等通用原则 + Node 实践）。
- 通用部分（交付规范、错误提示、分支管理、命名/注释精神）可进入 `common`。
- 《前端技术栈选型（Web/PDA/桌面端）》与 Tauri/桌面端相关，进入 `guides/` 或 `common/`。

## 4. 内容缺口

1. **React / Node 适配内容不存在**：需要新写并评审，不能只改标题。
2. **MOM3 规范与 Vue 2 强绑定**：模板必须锁定版本，避免与 React 项目混用。
3. **前端 SPC 总入口为空**：不要引用 7766571 作为来源；以 114165874 的子页为准。
4. **Wiki 版本会变**：模板中的 pageId/版本/导出日期必须记录，更新时走 diff 评审。
5. **部分页面正文可能为表格/附件**：导出脚本需处理 Confluence storage format，人工校对后再入模板。

## 5. 模板内容映射建议

```
bundles/
├── common/
│   ├── guides/index.md
│   ├── guides/delivery.md            # 6062284
│   ├── guides/error-messages.md      # 87729359
│   └── guides/branching.md           # 7766045
├── frontend-vue2/
│   ├── index.md
│   ├── quality-guidelines.md
│   └── references/
│       ├── coding-standard.md        # 28444179
│       ├── design-tokens.md          # 131345424
│       ├── button-permissions.md     # 131349785
│       └── i18n.md                   # 28445449 / 131351797
├── frontend-mom3/
│   ├── index.md
│   └── references/
│       ├── subapp-standard.md        # 43164694
│       └── mom3-ui.md                # 131351008
├── backend-java/
│   ├── index.md
│   ├── quality-guidelines.md
│   └── references/
│       ├── naming.md                 # 7766573
│       ├── database.md
│       ├── api.md
│       └── cache-kafka.md
├── frontend-react/                   # 新写/评审
│   ├── index.md
│   └── quality-guidelines.md
└── backend-node/                     # 新写/评审
    ├── index.md
    └── quality-guidelines.md
```

## 6. 复现/更新方式

- 使用 `wit-confluence-login-scraper` 的导出脚本，按 pageId 清单导出 Markdown 到临时目录，人工校对后更新 `bundles/`。
- 每次更新记录：pageId、pageVersion、导出日期、变更摘要。
- 不把 PAT、Cookie、内网账号写入仓库；导出脚本只从环境变量读取凭据。
