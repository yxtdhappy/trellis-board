# 修复任务复制在桌面客户端失败

## Goal

修复 Team Board 在 Tauri/WebView2 非安全来源下复制任务名失败，并统一处理一次性凭证与设备令牌复制入口的兼容回退。

用户点击“复制任务名”后必须稳定得到成功反馈，且系统剪贴板内容要等于任务目录名；不能要求用户把远端 Board 改成 HTTPS，也不能依赖未安装的 Tauri 剪贴板插件。

## Background

- 用户截图显示桌面客户端点击任务卡“复制任务名”后出现“复制失败” toast。
- `web/src/features/board/TaskCard.tsx` 当前只调用 `navigator.clipboard.writeText(task.dirName)`；
  调用缺失或 reject 时直接显示错误。
- 同类调用还存在于：
  - `web/src/features/admin/OneTimeCredentialDialog.tsx`
  - `web/src/features/admin/DevicesTab.tsx`
- WebView2 的异步 Clipboard API 受安全上下文和权限策略限制。Tauri 远端 Board 支持
  `http://<局域网IP>:4317`，该来源可能不是安全上下文。
- Tauri 当前未安装 clipboard plugin，也没有 clipboard capability；本次不新增原生插件。

## Requirements

- 增加一个前端共享的复制函数，所有现有复制入口统一使用，不再分别直接调用
  `navigator.clipboard`。
- 复制函数按以下顺序工作：
  1. 存活上下文且 `navigator.clipboard.writeText` 可用时，优先使用异步 Clipboard API；
  2. API 不存在或因安全上下文、权限、焦点限制而 reject 时，使用用户点击手势内的兼容回退；
  3. 两种方式都失败时返回可识别的失败结果，由调用方保留现有中文错误反馈。
- 兼容回退必须使用临时 DOM 元素执行复制，复制完成后删除临时元素，并恢复调用前焦点。
- 修复范围覆盖任务名、一次性凭证和设备令牌三个现有复制入口。
- 不改变复制内容、成功文案、一次性凭证展示逻辑或敏感数据存储边界。
- 不为所有复制失败自动改写用户剪贴板内容，也不在日志中记录任务名、凭证或令牌。
- 不新增运行时依赖。

## Acceptance Criteria

- [ ] 在 Tauri/WebView2 使用非安全 HTTP Board 来源、`navigator.clipboard` 缺失或 reject 时，
      点击任意任务卡“复制任务名”能写入准确的 `dirName`，并显示“已复制”。
- [x] Clipboard API 可用的安全上下文中继续使用原生异步路径，行为无回归。
- [x] 一次性凭证复制和设备令牌复制使用同一兼容函数，成功率与任务名复制一致。
- [x] 兼容回退完成后临时 textarea 从 DOM 删除，焦点回到触发前的元素。
- [x] 两种复制方式都失败时页面不抛未处理异常，继续显示清晰失败提示。
- [x] 不新增 Tauri 插件、Rust 权限、服务端接口或数据库变更。
- [x] `web` lint、TypeScript 构建通过，并实际验证不安全 HTTP 上下文下的复制结果。
- [ ] 真实桌面客户端验证任务名复制成功；验证过程不输出、保存或提交凭证内容。

## Out of Scope

- 引入 Tauri clipboard-manager 插件或其他原生剪贴板依赖。
- 强制远端 Board 使用 HTTPS。
- 自动读取或覆盖系统剪贴板历史。
- 修改任务详情、表单提交或其他非复制交互。

## Notes

- 这是轻量缺陷任务，PRD 足以描述产品验收，不单独增加 `design.md` / `implement.md`。
- 兼容回退采用标准 DOM 临时 textarea + `document.execCommand('copy')` 方案；该 API 已弃用但在
  Chromium/WebView2 中仍可作为不安全上下文的同步用户手势回退。
