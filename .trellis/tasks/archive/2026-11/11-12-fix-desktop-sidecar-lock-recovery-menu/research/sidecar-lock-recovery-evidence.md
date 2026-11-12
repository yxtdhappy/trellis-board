# Sidecar 残留锁与恢复链路调研

## 现场证据

- 桌面日志在 `2026-11-12T06:23:41.873Z` 至 `06:24:14.746Z` 连续记录 6 次
  `AgentError:LOCKED:已有 Trellis Agent 实例在运行`，随后记录“连续崩溃，已停止自动重启”。
- 重新打开客户端后，`06:39:32.518Z` 至 `06:40:04.892Z` 再次连续失败 6 次。
- 旧 `agent.lock` 记录 PID `14592`、hostname `local`，对应进程已不存在；当前机器名为
  `Z0198-YHJ-E`。
- 移走旧锁后，Agent 以 PID `27680` 启动；新锁 hostname 为 `Z0198-YHJ-E`。
- 托盘在 Agent 未运行时仍只有“暂停同步”；通过两次点击同一项后日志依次出现
  “已暂停后台同步”和“已恢复后台同步”，随后 Agent 成功启动。

## 代码证据

- `agent/lock.js:56` 使用 `process.env.COMPUTERNAME || 'local'` 写入 hostname。
- `agent/lock.js:85-93` 在 hostname 不一致时不检查 PID，锁年龄小于 24 小时就拒绝接管。
- `desktop/src-tauri/src/sidecar.rs:562-594` 先 kill 旧 child，随后立即 start 新 child，
  没有等待旧进程和锁释放。
- `desktop/src-tauri/src/sidecar.rs:524-559` 对全部退出原因统一执行最多 5 次退避重启。
- `desktop/src-tauri/src/main.rs:712` 的托盘项文字固定为“暂停同步”。
- `desktop/src-tauri/src/sidecar.rs:575-586` 只翻转 `paused`，没有根据 `running` 判断用户意图。
- `agent/cli.js:429-446` 的 CLI 状态已用 PID 校验 `runtime.json`，因此不扩展为运行时文件迁移。
- `desktop/src-tauri/Cargo.toml` 已依赖 `tauri-plugin-dialog`，`main.rs` 已注册 dialog 插件。
- Tauri v2 `AppHandle` 提供原生 `restart()`；`MenuItem::set_text()` 支持动态更新托盘文案。

## 方案取舍

### 锁回收

- 仅修 hostname 判断不够：仍应优先依据 PID 是否存活判断锁所有者。
- 锁位于每用户本地 Agent 目录，跨机器锁不是本产品场景；不能继续用 24 小时远程锁语义阻塞本地恢复。
- 活 PID 或 `EPERM` 必须按仍存活处理，避免两个 Agent 同时写同步状态。
- 删除前重新读取锁并校验 token/mtime，避免与另一进程刚创建的新锁竞争。

### 重试

- 无限重试不能解决确定性死锁，只会持续产生失败日志。
- 短时退避只用于旧 child 被杀后尚未完成退出和锁释放的竞态。
- 超过 5 次后进入明确失败状态，不再自动拉起，等待用户确认强制重启。

### 强制重启

- 用户点击后终止当前 Agent 进程组，并用同名进程清理兜底处理历史孤儿。
- 所有 Agent 进程确认退出后，将本地锁改名备份再启动新 Agent；不删除配置、凭证、任务和游标。
- 启动后必须验证进程和新的锁状态，不能仅以 `spawn()` 成功作为成功。
- Agent 级恢复仍失败时使用 Tauri `AppHandle::restart()` 重启整个客户端。

### 用户入口

- 使用已注册的 `tauri-plugin-dialog` 显示系统模态框，按钮文案为“强制重启同步”。
- 托盘菜单按状态动态显示“暂停同步”或“恢复同步”；未运行时点击一次即启动。
- 强制重启必须单飞，避免重复弹窗和并发 kill/start。

## 不在本次验证范围

- 不验证服务端本身宕机时的同步成功；该场景属于外部不可用，只能保留明确错误。
- 不以修改 `runtime.json` 代替进程状态校验。
- 不引入新的系统服务或跨机器锁实现。
