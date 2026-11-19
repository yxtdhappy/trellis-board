# 客户端模板哈希清理 E2E 报告

## 拓扑

| 层 | 进程 / 路径 | 说明 |
| --- | --- | --- |
| 客户端 | PID `1688` | 便携版 `0.4.44`，启动于 2026-11-19 09:10:15 |
| 被测仓库 | `D:\wit\trellis-board` | 当前 `main`，已有 `.trellis/tasks` |
| 日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs\desktop.log` | 操作前偏移 `54862703` |

## 逐步证据

| # | 操作 | 文件 / 日志证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 在 `.template-hashes.json` 注入 `.trellis/e2e-__pycache__/probe.pyc` | 探针键成功写入；原 manifest 已备份 | 构造成功 |
| 2 | 点击“初始化 trellis-board main 的编码 Agent”，选择未初始化的 Cursor，点击“初始化 1 个 Agent” | `.cursor/` 于 09:22:01 创建，包含 Agents、Commands、Hooks、Skills | Agent-only init 实际执行 |
| 3 | 读取初始化后的 manifest | 原 188 个键全部存在且值未变；新增 58 个真实模板键；探针键消失；结果无 pycache/pyc 键 | 通过 |
| 4 | 清理测试数据 | 恢复原 manifest，SHA-256 为 `3CEECE7DED2FB3B41A6E73E521CF1D22DA92DEE9E07A91D974706E1238B84156`；删除 `.cursor/` | 清理完成 |
| 5 | 核对 CI | GitHub Actions run `44420836007`：Rust unit tests、桌面打包、便携包 smoke test、Release 发布全部成功 | 通过 |

## 结论

- Agent-only 初始化真机路径通过：缓存哈希被清理，其他原始哈希未受影响。
- 完整 init 真机路径本轮未单独执行；其共用清理入口由单元测试覆盖，Rust 测试已在 CI 通过。
- `desktop.log` 没有初始化专用的成功日志行，只有与本操作无关的 ownership 轮询和 Archived 状态告警；本次功能判定依据为 UI 操作、文件创建时间和 manifest 前后差异。
