# 桌面复制兼容修复检查报告

## 1. 检查范围

- `web/src/browser/clipboard.js` 的 Clipboard API 与同步 DOM 回退。
- 任务名、一次性凭证、设备令牌三个复制入口。
- 临时 textarea 清理、焦点恢复、失败返回和敏感数据边界。
- 非安全 HTTP 上下文与 Tauri/WebView2 桌面验收。

## 2. 实现结论

- 三个业务入口统一使用 `@/browser/clipboard.js`，`web/src` 业务组件不再直接调用
  `navigator.clipboard`。
- DOM 工具放在 `web/src/browser/`，不违反 `web/src/lib/*.js` 的 DOM-free 约束；
  前端目录规范已同步新增 `browser/` 职责和依赖方向。
- 临时 textarea 在成功、`execCommand` 抛异常、返回 `false` 时都会清理。
- 回退完成后尝试恢复原焦点；原焦点失效时不影响复制结果。
- 不新增 Tauri 插件、Rust 权限、服务端接口、数据库变更或运行时依赖。

## 3. 自动验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 剪贴板专项 | `node --test tests/clipboard.test.js` | 5/5 通过 |
| Web lint | `npm --prefix web run lint` | 退出码 0，仅既有告警 |
| Web 构建 | `npm run build` | TypeScript + Vite 通过 |
| 格式 | `oxfmt --check` 目标文件 | 通过 |
| 空白错误 | `git diff --check` | 通过 |
| 调用点扫描 | `rg "navigator.clipboard|clipboard.writeText" web/src` | 业务入口无直接调用 |

全量 `npm test` 曾在并行负载下因无关
`plugins/acp-dispatch/test/index.test.js` 的会话取消超时失败；该用例单独复跑 1/1 通过，
不属于本任务改动。

## 4. 非安全 HTTP 浏览器验证

在 `http://192.168.65.27:4318` 的真实 Chromium 页面确认：

- `isSecureContext=false`；
- `navigator.clipboard` 不存在；
- 点击任务卡复制后 toast 为“已复制”；
- 剪贴板内容精确为 `11-11-fix-desktop-clipboard-copy`；
- 临时 textarea 数量为 0，焦点恢复，未打开任务详情。

## 5. Tauri/WebView2 验收状态

已将 worktree 构建产物临时提供给现有 4317 服务，Tauri 窗口成功识别 4 个当前任务卡。
执行任务卡复制时，Windows 前台窗口为 `LockApp / Windows 默认锁屏界面`，页面无法取得
真实用户激活手势，复制返回失败。该结果属于锁屏脚手架问题，不能用于判定实现失败。

原 `public` 静态产物已从临时备份完整恢复，4317 服务未重启、数据库未修改。

## 6. 待完成

- 用户解锁 Windows 后，重新加载 Tauri 窗口并点击任务卡复制。
- 必须核对 Windows 剪贴板等于任务目录名、toast 为“已复制”、textarea 清理、焦点恢复。
- 完成桌面验收前不提交、不推送、不归档。
