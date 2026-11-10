# 检查报告

## 结论

本任务代码实现与 PRD、设计和实施计划一致。定向测试、前端 lint、类型检查、最终生产构建
和重启后的浏览器状态流验收通过。

## 检查并修复的问题

- 跨团队显式升级和并发升级可能返回其他团队的项目名称、分支和状态；已改为团队感知冲突映射，跨团队不返回敏感 `details`。
- `taskkill` 非零退出原先会被视为终止完成；已改为回退 `child.kill()`。
- 并发与清理测试夹具存在错误和 Windows 临时目录 `EPERM` 抖动；已修复测试清理。
- `merge`、初始化推送分叉后的 `rebase` 及其 abort 原先未传入项目认证；已改为复用当前认证并执行 210 秒远端超时。
- 公共拉取、同步、推送、稀疏收敛和远端提交检查可能把原始子进程超时泄漏为 HTTP 500；已统一通过 `remoteException()` 映射为 `GIT_REMOTE_TIMEOUT`。
- 操作执行超时统一在各自原值上增加 30 秒；速率窗口、SSH 信任 TTL、taskkill fallback 和 HTTP 关闭时限保持原值。
- 成功接入后 `resetForm()` 清空受控分支 Select 会触发 `changeBranch('')` 并弹出空 URL
  伪错误；已增加纯守卫，只允许分支和远端 URL 均非空时自动探测。
- 定时刷新原先只记录通用 message，无法区分真实失败；已改为记录结构化 TeamError 字段，
  并对非 TeamError 的 stack/cause、日志 details 和项目 `last_error` 统一脱敏。
- 错误诊断原先把 `Authorization: Bearer ...` 和 `Cookie: ...` 只替换到首个单词，后续凭证
  仍可能进入日志；现已整段脱敏，并覆盖 Proxy-Authorization、Set-Cookie、JWT 和 access_token
  等复合键。
- 结构化诊断详情原先只有单字段、深度和节点限制，缺少总文本预算；现由 details/cause 共享
  128 节点、约 12 KiB 文本预算，长对象键也受限；循环引用返回 `[circular]`，超限返回
  `[truncated]`。
- 绝对路径脱敏补齐带空格的引号路径、file URL、无空格分隔路径、UNC 路径和无引号 Windows
  路径；`AUTHORIZATION_REQUIRED`、`TOKEN_EXPIRED` 等错误 code 保持原值。

## 关键验证

- 顺序重复接入在 clone 前返回 409。
- 并发重复接入最多写入一条项目记录，失败请求清理本次 UUID。
- 同仓库不同分支均可接入。
- 显式升级同团队项目返回项目详情；跨团队不泄露详情。
- 清理失败保留原始工具链错误并记录清理错误。
- 子进程超时后等待进程树退出，返回原始超时错误。
- 新增规范已同步到 backend architecture、HTTP/filesystem 和 quality 文档。
- 空分支、空 URL 和空白字符串不会自动探测；显式“识别远端”仍保留空 URL 提示。
- scheduler 的日志包含 `name/code/status/message/details` 和兼容 `error` 字段。
- 临时数据库中的 `last_error` 为 `code: message`，不含 Token 或绝对路径。
- Authorization/Cookie/JWT/复合 token 键、循环引用、带空格路径和超长对象键均有回归断言。
- 新增规范已同步到 frontend rendering/state 和 frontend quality 文档。
- 新增规范已同步到 backend HTTP/filesystem 与 backend quality 文档。

## 残余问题

- 清理日志包含 actor、团队、项目和远端身份，但没有 HTTP `requestId`；补齐需要跨越当前 service 边界传递请求上下文，未纳入本次最小修复。
- 两个孤儿目录未删除。
- 当前已恢复项目未强制写库；诊断增强只会在后续真实刷新失败时产生新的 `last_error`。

## 证据

- 最终定向 Node 测试：26/26 通过，耗时约 16.9 秒。
- 重置守卫与错误诊断专项：9/9 通过。
- 前端 lint：通过，仅有既有 React warning。
- `tsc -b web/tsconfig.app.json web/tsconfig.node.json`：通过。
- `oxfmt --check`：任务相关文件通过。
- `task.py validate`：implement.jsonl 5 条、check.jsonl 4 条，通过。
- `git diff --check`：通过。
- 最终 `npm run build`：通过，包含 TypeScript 和 Vite 生产构建。
- 重启后的真实浏览器验收：模拟接入成功并打开“批准项目接入”弹窗后，通知区域为空，
  页面不存在“请先填写 Git 远端 URL”；最终 POST 被浏览器测试拦截，真实数据库仍为 5 个项目，
  未写入测试项目。
- 未提交、未推送。
