# 客户端登录后隐藏团队管理入口检查报告

## 检查结论

- 实现位于 `BoardPage` 的组合层，使用现有 `window.__TAURI__?.core?.invoke` 特征区分客户端与浏览器。
- Tauri 客户端下 `adminHref` 为 `undefined`，`TopBar` 因可选值为空而不渲染“团队管理”。
- 普通浏览器下 `adminHref` 仍为 `/admin.html`，原有管理入口不变。
- 服务端、`admin.html` 和 `TopBar` 未修改。
- 现有 `.trellis/spec/frontend/rendering-and-state.md` 已明确 Tauri 与普通浏览器的运行时差异，无需新增规范。

## Findings（fixed）

- `task.json`：`task.py start` 写入的 CRLF 触发 `git diff --check` trailing whitespace；已机械规范为 LF。

## Findings（not fixed）

- `npm test` 全量执行约 8 分钟后仍有多项与本改动无关的超时失败，并连续约 2 分钟无输出，已终止命令。失败集中在 ACP 插件、桌面实时同步等测试，不能作为本任务回归结论。
- 当前未新增组件级测试；项目规范禁止“读取源码文本”的伪行为断言。
- 真实 Tauri WebView2 安装包未启动；本地 4317 团队服务当前拒绝连接。浏览器双模式验证使用同一运行时特征注入完成，结果见 `e2e-report.md`。

## Verification

- Lint：通过，0 error；保留项目既有 warning。
- TypeCheck：通过，`npm run build` 中的 `tsc -b` 成功。
- Build：通过，Vite 构建成功。
- 浏览器菜单验证：通过；普通浏览器保留“团队管理”，Tauri 运行时模拟隐藏该入口。
- Tests：未通过验收；全量测试存在无关超时，命令被主动终止。
- `git diff --check`：通过。
