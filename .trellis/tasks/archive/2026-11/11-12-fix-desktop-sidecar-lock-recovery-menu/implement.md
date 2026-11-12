# 实施计划

## 1. 前置

- [x] 确认当前工作区仅有本任务及其他用户改动，不修改并行项目初始化任务。
- [x] 固定本任务是单一交付，不拆子任务：锁回收、重启监督、托盘和弹窗属于同一条恢复链路。
- [x] 实施期间未执行构建；所有代码完成后再统一构建、测试和打包验证。

## 2. Agent 单实例锁

- [x] 重构 `agent/lock.js` 的锁判定：PID 明确不存在时不再受 hostname 和 24 小时窗口阻塞。
- [x] 活 PID、`EPERM` 和无法确认的损坏锁继续保持保守阻塞。
- [x] 删除死锁前重新读取 token/mtime，避免与并发创建者竞争。
- [x] hostname 继续写入以保留诊断信息，但不控制本地死锁回收。
- [x] 在 `agent/test/lock.test.js` 增加 hostname=`local`、死 PID、活 PID、`EPERM`、token 变化测试。

验证重点：

```powershell
node --test agent/test/lock.test.js
```

## 3. Sidecar 状态与正常重启

- [x] 在 `desktop/src-tauri/src/sidecar.rs` 增加明确状态：运行、暂停、重试中、待强制恢复、强制恢复中。
- [x] 项目关联或登录触发的 `restart()` 先终止旧 child，再等待进程和锁释放，最后 start。
- [x] 保持现有 5 次退避；不要新增无限重试。
- [x] 第 5 次失败后不再自动拉起，并记录清晰错误摘要。
- [x] 所有状态变化都触发统一的托盘文案更新。

验证重点：

- 构造旧 child 正在退出时立即 restart，不出现 `LOCKED`。
- 构造持续 `LOCKED`，确认第 5 次后停止自动拉起。

## 4. 系统模态框与强制重启

- [x] 使用现有 `tauri-plugin-dialog` 在第 5 次失败后弹出系统模态框。
- [x] 模态框使用单个自定义按钮“强制重启同步”，每个失败周期只弹一次。
- [x] 增加 `force_restarting` 单飞状态，阻止弹窗、托盘和菜单重复触发。
- [x] 强制恢复依次执行：终止 child 进程组、`taskkill /F /T /IM trellis-agent.exe`、
  等待同名进程退出、备份残留锁、启动新 Agent、验证新进程存活。
- [x] 验证使用新 `agent.lock` token、存活 PID、`trellis-agent.exe` 进程身份和稳定窗口，不能只相信
  spawn 返回值；不把网络心跳状态当作进程启动失败。
- [x] Agent 级恢复失败时调用 `sidecar::shutdown()` 和 Tauri `AppHandle::restart()`，
  由新客户端重新进入正常启动和重试流程。
- [x] 锁备份只移动 `agent.lock`，不得修改配置、凭证、事件/实时游标和任务文件。

验证重点：

- 强制重启分支只能执行一次，不产生并发 kill/start。
- 锁被成功回收，新 Agent 持续存活后才显示成功。
- Agent 恢复失败时客户端重启一次；普通自动重试绝不触发客户端重启。

## 5. 托盘菜单

- [x] 在 `desktop/src-tauri/src/main.rs` 保留同步菜单项 handle。
- [x] 运行中显示“暂停同步”；暂停、未运行、重试和待强制恢复显示“恢复同步”。
- [x] 强制恢复期间显示“正在强制重启”，并禁用菜单项。
- [x] 未运行时点击“恢复同步”一次就清除暂停/退避并启动 Agent。
- [x] 菜单文案通过 `MenuItem::set_text()` 动态更新，不要求重启客户端。
- [x] 未新增 Tauri command，因此没有扩大 `desktop.toml` 权限。

验证重点：

- 运行、暂停、未运行、强制恢复四种状态文案正确。
- 未运行时点击一次即可启动，不再依赖二次点击。

## 6. 测试与文档

- [x] Rust 增加状态到菜单文案、失败阈值、单飞和锁备份测试。
- [ ] 增加客户端重启兜底分支测试；抽纯逻辑避免真实重启测试进程。
- [x] 扩展 `tests/desktop-package.test.js` 校验 dialog 能力和强制恢复相关打包契约。
- [x] 在 `.trellis/spec/backend/desktop-sidecar-packaging.md` 记录锁回收、重试耗尽、强制重启和动态托盘契约。
- [ ] 更新本任务验收记录，包含真实 Windows 客户端证据。

## 7. 最终统一验证

所有开发完成后已执行本机可用的验证：

```powershell
npm test
npm run format:check
git diff --check
node --test tests/desktop-sidecar-lifecycle.test.js
node --test tests/desktop-package.test.js
cargo test --manifest-path desktop/src-tauri/Cargo.toml
npm --prefix web run build
```

### 当前验证结果

- `npm test`：483 个用例，479 通过、0 失败、4 个平台跳过。
- `node --test agent/test/*.test.js`：68 个用例全部通过。
- `agent/test/lock.test.js`、`tests/desktop-sidecar-lifecycle.test.js`、
  `tests/desktop-package.test.js`：相关 27 个用例全部通过。
- `npm --prefix web run build`：TypeScript 与 Vite 构建通过，仅保留原有大 chunk 警告。
- 改动文件 `oxfmt --check` 与 `git diff --check`：通过。
- 全仓 `npm run format:check`：失败于 9 个与本任务无关的既有文件，本任务文件未报格式问题。
- 本机没有 `cargo`/`rustc`：Rust 编译、Rust 单测、桌面安装包和真实弹窗/菜单 E2E 尚未执行。

Windows 打包与真实桌面验收：

1. 启动最新客户端，构造 hostname=`local`、PID 已死亡的锁，确认自动回收。
2. 构造持续锁失败，确认超过 5 次后出现“强制重启同步”模态框。
3. 点击一次，若 Agent 可恢复，确认进程、锁、项目栏和托盘状态一致。
4. 构造 Agent 无法恢复但外部配置有效的场景，确认客户端自动重启且没有无界快速循环。
5. 保留测试前后的日志、进程和锁文件证据，清理测试产生的备份文件。

## 8. 风险与回滚点

- `taskkill /IM trellis-agent.exe` 影响当前用户所有同名 Agent；只在用户明确点击强制重启时执行。
- 客户端重启会丢失未提交的纯界面输入，已在产品要求中确认。
- 锁回收必须优先保守处理活 PID，避免并发 Agent 破坏同步游标。
- 如果 Tauri dialog 或 restart API 与当前 `tauri` 版本不兼容，停止实施并在设计阶段调整，不引入第二套弹窗框架。
