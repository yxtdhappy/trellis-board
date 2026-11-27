# E2E / 实机验收报告

## 拓扑与版本证据

| 项目 | 值 |
| --- | --- |
| 任务目录 | `.trellis/tasks/11-27-company-spec-select-and-helper-path` |
| Git HEAD | `d0ef925`（叠加本任务工作区修改） |
| 隔离根路径 | `C:\projects\_trellis-board-e2e\11-27-company-spec` |
| 服务端模式 / 端口 | `TRELLIS_BOARD_MODE=team`，`http://127.0.0.1:4471/weint-spec-board` |
| 服务端健康证据 | `/api/health`: `processId=36384`, `serverStartedAt=2026-11-27T06:54:41.686Z`, `version=0.5.17` |
| 页面 Bundle 核对 | WebView2 加载 `/weint-spec-board/assets/main-vsjVRAhF.js`，与 `packages/server/public/index.html` 一致 |
| 桌面端构建产物 | `packages/desktop/src-tauri/target/debug/trellis-board-client.exe`（PID `2848`） |
| 客户端 SHA256 | `4B07DEDCB02A6C534110ED6D533E11A19B6480E8C7BE30E5248D85EF884ABC34` |
| WebView2 CDP 端口 | `9371` |
| 内嵌释放 `apply.mjs` | `clients\c1\runtime\kit\0.5.17\82ef95dc15aef305\features\company-spec\apply.mjs`（含 `resolveUtilsDir`） |
| Registry 验证方式 | 通过 `GIT_CONFIG_COUNT=1` 将 `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git` 透明重定向至隔离本地 bare registry（`registry.git`），端到端走真实 `trellis-board-client.exe` → 内嵌 `apply.mjs` → `@mindfoldhq/trellis/bin/trellis.js` → `dist/utils/*` |

---

## 1. L1 自动测试结果

- `node --test scripts/test/company-spec.test.js scripts/test/trellis-kit.test.js packages/web/test/company-spec.test.js`：**19/19 通过**（含 `bin/trellis.js` 入口测试、Select 标签解析、`normalizeCompanySpecPlan` 数组计数）
- `node --test packages/web/test/*.test.js`：**139/139 通过**
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml company_spec`：**12/12 通过**
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml kit_assets`：**2/2 通过**
- `yarn workspace @trellis-board/web lint`：**0 errors**
- `yarn workspace @trellis-board/web build` & `build:desktop`：**通过**

---

## 2. L3 真实客户端 + WebView2 CDP 实机验收（逐 AC）

| AC | 结论 | 证据 1（UI / DOM 状态） | 证据 2（进程 / 磁盘 / 产物复核） |
| --- | --- | --- | --- |
| **AC1 · 「选择模板」默认回显** | PASS | 打开已关联 monorepo 项目「公司开发规范」弹窗，`#company-spec-template` 回显 `自动识别（推荐）`（非 `auto`），下方提示 `workspace monorepo 暂不自动套用公司规范，请按包单独初始化` | 页面加载最新 bundle `/weint-spec-board/assets/main-vsjVRAhF.js` 与 `packages/server/public/index.html` 一致 |
| **AC2 · 「选择模板」切换回显** | PASS | 点击 `#company-spec-template` 选中 `前端 MOM3` 后，触发器文本回显 `前端 MOM3`（非 `wit-frontend-mom3`） | 同上（WebView2 真实渲染） |
| **AC3 · 「检查变更」模块加载与文件计数** | PASS | 点击「检查变更」无报错（`errorText: null`，不再报 `Cannot find module ...\utils\template-fetcher.js`），弹窗展示 `apply`、`无 → wit-frontend-mom3 · 2026.11.27`、`新增 3`、`冲突 1` 与「套用模板」按钮 | 磁盘复核客户端释放的 `apply.mjs` 位于 `clients\c1\runtime\kit\0.5.17\82ef95dc15aef305\features\company-spec\apply.mjs` 且包含 `resolveUtilsDir`；本机安装的 `@mindfoldhq/trellis` 入口为 `bin/trellis.js` |
| **AC4 · 「套用模板」落盘** | PASS | 点击「套用模板」完成并自动刷新状态，随后可进入 `update` 分支 | 磁盘核对 `repo\.trellis\spec\.company-spec.json` 已生成（`markerExists: true`） |
| **AC5 · 「更新策略」Select 回显** | PASS | 套用后再次点击「检查变更」进入 `action === 'update'`，`#company-spec-strategy` 默认回显 `保留本地修改（推荐）`（非 `keep-local`），切换后回显 `覆盖冲突文件`（非 `overwrite`） | 同上（WebView2 真实交互） |
| **AC6 · 长路径报错换行不溢出** | PASS | 在弹窗内容区插入原 Windows 长模块路径错误文本后，`pScrollWidth=507 === pClientWidth=507`、`bodyScrollWidth=539 === bodyClientWidth=539`、`pHeight=48`（正常折行，无横向滚动条） | 样式类 `text-xs text-destructive break-words [overflow-wrap:anywhere]` 已生效 |

---

## 3. 未覆盖项与环境说明

- **内网 Git 仓库直连（`git.weintdata.cn:1022`）**：当前测试网络无法解析 `git.weintdata.cn`（DNS 不可达），已通过 `GIT_CONFIG_COUNT` 重定向至本地 bare registry 完整验证 `apply.mjs` → `bin/trellis.js` → `dist/utils/*` → `git` 下载与前端预览渲染链路；后续在公司内网环境可直接不设重定向做一次冒烟。
- **`ProjectOnboardingDialog` 原生目录选择交互**：原生文件选择器无 CDP 自动化入口；已通过 `inspect_local_project` 对未初始化 MOM3 仓库实测返回 `companySpec.available=true`、`detected.template='wit-frontend-mom3'`、`templateCount=9`，且弹窗复用了与 `CompanySpecDialog` 同一纯函数 `companySpecSelectionLabel`（已有 L1 单测覆盖 `'none'` / `'auto'` / 模板 ID）。

---

## 4. 清理结果

- 已终止客户端进程树（`trellis-board-client.exe`）、隔离服务端（4471）及临时前端 dev 进程（5199）；
- 已删除隔离目录 `C:\projects\_trellis-board-e2e\11-27-company-spec`（`DIR_EXISTS=False`）；
- 已核对端口 `4471`、`5199`、`9371` 均无残留监听进程；未触碰生产端口 `4317`。
