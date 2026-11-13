# 检查报告

## 结论

当前 monorepo/Rust 集成分支的代码级检查和自动化验证通过；变更位于独立 worktree，
未混入主工作区。真实浏览器、三客户端和 Tauri 安装包 E2E 尚未执行；Rust 编译因本机缺少
工具链无法验证。

## 验收映射

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| AC1 切换分支只移除监听，不撤销 binding | 通过 | 心跳、真实分支和 taskSpace 聚合测试 |
| AC2 全部切换后显示 `0/3 inactive` | 通过 | Team taskSpace 状态投影测试 |
| AC3 单客户端解绑只影响自身 | 通过 | detach 事务和审计测试 |
| AC4 全部解绑后显示 `0/0 unassociated` | 通过 | taskSpace 五态聚合测试 |
| AC5 心跳超时自动离线 | 通过 | listener/device stale 阈值测试 |
| AC6 解绑期间停止 watcher、上传和拉取 | 通过（代码级） | detachPending、配置边界和 watcher 测试 |
| AC7 解绑保留任务、冲突、审计和历史 | 通过 | detach 幂等与保留断言 |
| AC8 重复解绑幂等且单次审计 | 通过 | detach 事务测试 |
| AC9 普通成员不能读取监听详情 | 通过 | listeners 权限测试 |
| AC10 全项目范围按 taskSpace 独立展示 | 通过（代码级） | ProjectRail 纯状态和 Web 测试 |
| AC11 Node 覆盖监听、解绑、命令和聚合 | 通过 | 全量 `npm test`：426 通过、0 失败、1 跳过 |
| AC12 桌面失败待确认与成功后清理 | 通过（代码级） | Rust Agent 与 Tauri 源码检查 |
| AC13 零监听前后端双重门禁 | 通过 | taskCommandState、任务命令和 HTTP 测试 |
| AC14 旧客户端显示 unknown_legacy | 通过 | 状态优先级和门禁测试 |
| AC15 桌面解绑成功/失败重试闭环 | 通过（代码级） | Rust detach、runtime 重试与 cursor 清理路径 |

## 回归检查

- heartbeat 不再先把仓库不匹配的 binding 标记为在线。
- 创建/改派响应丢失后，即使监听归零，相同幂等键仍返回原操作。
- 配置已标记 `detachPending` 时，即使内存 binding 尚未刷新，也不会继续拉取、上传或写 cursor。
- Tauri 解绑不会覆盖用户已有的“暂停后台同步”状态。
- ProjectRail 不再把不可重试解绑错误误描述为自动重试。
- 旧服务端连接口完全缺少监听字段时，前端保持兼容，不误禁用创建/改派。
- 未保留针对 Rust 源码做正则断言的伪自动化测试；Rust 行为由源码内单测表达。

## 未完成门禁

- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`：本机无 `cargo`，未执行。
- 真实 Team 环境三客户端 E2E：未执行。
- 真实浏览器浅色/深色、1024/860px 和桌面安装包 E2E：未执行。
- 未归档任务。

## 最终检查

- 全量 `npm test`：427 项，426 通过，0 失败，1 跳过。
- `npm run build:desktop`、`npm run build`、`npm run check:boundaries`：通过。
- 本任务文件 `oxfmt --check`：通过；仓库级格式检查仅有 14 个无关既有文件未通过。
- `git diff --check`：通过。
