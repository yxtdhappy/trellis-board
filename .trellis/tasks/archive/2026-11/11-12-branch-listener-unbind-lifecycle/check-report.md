# 检查报告

## 结论

代码级检查、GitHub Windows 构建和核心 Team/桌面 E2E 通过。已验证监听五态聚合、权限脱敏、
零监听服务端门禁、真实客户端快捷解绑、taskSpace/审计保留和测试数据清理。三台真实客户端
切换、60 秒离线超时、断网解绑重试、运行中 watcher/upload 停止和响应式布局仍未完成真机验收。

## 验收映射

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| AC1 切换分支只移除监听，不撤销 binding | 部分通过 | 隔离 DB fixture 验证状态变化；未用真实三客户端心跳复现 |
| AC2 全部切换后显示 `0/3 inactive` | 通过 | 隔离 fixture + 真实桌面 UI：`0/3 当前未激活，关联保留` |
| AC3 单客户端解绑只影响自身 | 通过 | 服务 E2E：A revoked、B/C 保持 approved + listening、UI `2/2`；另完成真实桌面单客户端解绑 |
| AC4 全部解绑后显示 `0/0 unassociated` | 通过 | 服务 E2E + 真实桌面 UI：`0/0 无客户端关联` |
| AC5 心跳超时自动离线 | 通过 | listener/device stale 阈值测试 |
| AC6 解绑期间停止 watcher、上传和拉取 | 通过（代码级） | detachPending、配置边界和 watcher 测试 |
| AC7 解绑保留任务、冲突、审计和历史 | 部分通过 | taskSpace 和审计保留已实测；含真实任务/冲突的探针未复核 |
| AC8 重复解绑幂等且单次审计 | 通过 | 服务 E2E：重复解绑返回 `alreadyDetached=true`，审计不增加 |
| AC9 普通成员不能读取或操作其他用户设备 | 部分通过 | 真实 HTTP：监听详情负责人 200、只读成员 403；跨用户 detach 仅自动化测试 |
| AC10 全项目范围按 taskSpace 独立展示 | 通过 | 真实桌面 UI 分别显示 `online/inactive/unassociated/unknown_legacy` |
| AC11 Node 覆盖监听、解绑、命令和聚合 | 通过 | 全量 Node 426 通过、0 失败、1 跳过；GitHub Server and web tests 成功 |
| AC12 桌面失败待确认与成功后清理 | 通过 | GitHub Rust unit tests 成功；真实客户端成功后 binding/cursor 清理已实测 |
| AC13 零监听前后端双重门禁 | 通过 | UI 禁用；HTTP `409`，`sync_task_command` 前后均为 0 |
| AC14 旧客户端显示 unknown_legacy | 通过 | UI `0/1 旧客户端，监听状态未知`；HTTP `409 TASK_SPACE_NO_ONLINE_LISTENER`，不写操作项 |
| AC15 桌面解绑成功/失败重试闭环 | 部分通过 | 真实客户端成功路径通过；断网待确认与自动重试仅 Rust 自动化测试 |

## 回归检查

- heartbeat 不再先把仓库不匹配的 binding 标记为在线。
- 创建/改派响应丢失后，即使监听归零，相同幂等键仍返回原操作。
- 配置已标记 `detachPending` 时，即使内存 binding 尚未刷新，也不会继续拉取、上传或写 cursor。
- Tauri 解绑不会覆盖用户已有的“暂停后台同步”状态。
- ProjectRail 不再把不可重试解绑错误误描述为自动重试。
- 旧服务端连接口完全缺少监听字段时，前端保持兼容，不误禁用创建/改派。
- 未保留针对 Rust 源码做正则断言的伪自动化测试；Rust 行为由源码内单测表达。

## 未完成门禁

- 本机仍无 `cargo`；GitHub Actions `43378479104` 已在 Windows 环境执行 Rust unit tests 并通过。
- 真实三客户端切换和真实 60 秒心跳超时：未执行。三客户端状态使用隔离 DB fixture + 真实服务聚合 + 真实 UI。
- 断网解绑、恢复网络后自动重试、运行中 watcher/upload/pull 停止写入：未做真机复测。
- 真实浏览器浅色/深色、1024/860px 布局：未执行。
- 桌面便捷接入弹窗存在既有预检返回契约问题（返回 `{ ok, result }`，前端按顶层结果解析），不在本任务范围，未修改。
- 未归档任务。

## 最终检查

- 全量 `npm test`：427 项，426 通过，0 失败，1 跳过。
- `npm run build:desktop`、`npm run build`、`npm run check:boundaries`：通过。
- 本任务文件 `oxfmt --check`：通过；仓库级格式检查仅有 14 个无关既有文件未通过。
- `git diff --check`：通过。
- GitHub Actions `43378479104`（`main@e930bcc`）：Windows Node tests 和 desktop build 全成功。
