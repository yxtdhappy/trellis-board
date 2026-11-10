# 实时同步阻塞与误弹窗检查报告

## 结论

Node/HTTP/Worker/Agent 范围的实现和自动回归通过。桌面 Rust 源码已接线并补静态断言与 Rust
单测，但当前机器没有 Cargo/Rust 工具链，原生编译和 WebView2 真机验证尚未闭环。

## 对照检查

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Git 已收敛写回不上报 | 通过 | `desktop-realtime-apply` 新增用例 |
| 真实未提交修改仍上报 | 通过 | 同一用例继续产生 preflight/upload |
| Git 检查失败保留 pending | 通过 | 不可用仓库路径用例弹出且不删除 pending |
| 超时与显式取消可区分 | 通过 | 不响应 HTTP 假服务与 `AbortController` |
| 实时物化离开 HTTP 主线程 | 通过 | Worker `live-materialize` 与延迟 scanner 用例 |
| 320 任务健康检查 `<1s` | 通过 | 最终全量测试 healthMax=33ms |
| 多 revision 合并、旧结果丢弃 | 通过 | deferred first materialize 用例 |
| 投影失败保留 Board/revision 并重试 | 通过 | 注入首轮失败，revision 仍为 2，随后收敛 |
| 幂等重放不重复物化 | 通过 | 已有内存 Board 时 materialize 调用数保持 1 |
| 临时物化目录清理 | 通过 | 成功与路径拒绝后均无新增临时目录 |
| 关闭窗口不丢 pending | 代码通过，实机待验 | `dismiss_control` 只 hide，Agent 单测保留 pending |
| 首次聚焦、去重、托盘恢复 | 静态接线通过，实机待验 | Rust 源码与 `desktop-package` 静态断言 |
| Rust 编译与单测 | 阻塞 | `cargo` 不在 PATH |

## 自动验证

- `npm test`：475 项，470 通过、5 跳过、0 失败。
- `oxfmt --check`（本次 10 个 JS 文件）：通过。
- `node --check`（本次 7 个 JS 源文件）：通过。
- `git diff --check`：通过。
- 全局 `npm run format:check`：本次修改文件已格式化；仍报告 9 个无关既有文件。

## 风险与边界

- 未改 SQLite schema、实时 HTTP 字段、责任人确认权限和审计语义。
- `live.changed` 现在晚于写入响应，但发生在真实索引替换成功之后；测试覆盖旧结果不覆盖新 revision。
- 完整桌面窗口行为仍依赖 Cargo/MSVC/Windows SDK 环境和 WebView2 真机验证。
