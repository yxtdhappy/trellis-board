# E2E 验证报告：分支不一致提醒降噪

- 日期：2026-11-20
- 客户端：Trellis Board 0.4.48（portable，CI 从 tag `v0.4.48` 构建）
- 修复提交：`5bd9c95`；发版提交：`1c494e5`
- 任务空间：`trellis-board`（绑定分支 `main`）
- 测试方式：临时创建内容相同的非绑定分支，避免改动工作区文件；每次验证后删除临时分支

## 结果

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | `main` 上启动客户端 | 项目栏“已关联 · 同步正常”，无任何提示 |
| 2 | 切到 `verify/toast-capture-3` | 右上角出现一次客户端内 toast：`项目「trellis-board」已暂停同步` / `本地当前分支为 verify/toast-capture-3，绑定分支为 main。切回绑定分支后会自动恢复。`；无模态框、无系统通知 |
| 3 | 观察项目栏 | `trellis-board` 显示“分支不一致，已暂停同步”，`main` 行显示“已暂停 / 在线监听 0” |
| 4 | 等待 45 秒 | 无第二条 toast、无模态框；`config.json` revision 与 SHA 完全不变 |
| 5 | 切回 `main` | 项目栏恢复“已关联 · 同步正常”，`main` 显示“在线监听 1”；无“已恢复”消息 |
| 6 | 再次切到 `verify/toast-capture-4` | 重新出现一次 toast；证明恢复后的再次提醒生效 |
| 7 | 暂停状态下 kill 并重启客户端 | 启动后直接进入 Board，项目栏仍为“已暂停”；启动连拍 15 秒内无 toast |

## 关键结论

- `task_sync_notice` 只在“正常 → 暂停”的边沿发出一次；通知由 `assert_binding_branch` 统一发射，ownership 校验、事件 pull、心跳等路径都会经过同一守卫，不再出现“先持久化后通知被吞”的问题。
- 暂停期间连续心跳、另一个非绑定分支、启动/重载均不重复提醒。
- 恢复后再次进入暂停会重新提醒一次。
- 非模态消息是客户端内 sonner toast（`position="top-right"`），不是 Windows 系统通知，不进入 `ControlHub`，不抢焦点。
- 暂停语义保持：不 pull/upload/本地写入/监听，项目栏显示已暂停；心跳在线监听数不包含该绑定。

## 验证限制

- 本机没有 Rust 工具链，`cargo test` 未在本地执行；0.4.48 由 CI 构建，工作流在打包前执行 `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`，构建与发布成功。
- 未验证非分支守卫 `task_sync_error` 的真实 UI 弹窗（由现有逻辑保持 + Rust 单测覆盖）。