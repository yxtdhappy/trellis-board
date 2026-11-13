# 桌面接入真机验收补齐

## Goal

把 `.trellis/tasks/archive/2026-11/` 各份 e2e 报告里“未验证项 / 验证边界”中属于产品行为、但只有 mock 或
自动化测试证据的条目，补成真机（真实服务 + 真实安装包 + 真实 WebView2）闭环证据，并把结论回写到对应报告，
使分支监听与解绑这条链路可以标记为完整通过。

## Background

`11-12-branch-listener-unbind-lifecycle` §7 结论明确写着：“三真实客户端切换、离线超时、断网重试和运行中写入停止
仍属于未完成真机验收，不应标记为完整通过”。同类缺口散落在其他报告中，本质都是“自动化测试通过 / 隔离 fixture
通过，但没有在真实客户端上跑过”。

既有证据基础：

- `11-12-branch-listener-unbind-lifecycle` 已用隔离 DB fixture + 真实服务聚合 + 真实桌面 UI 验证了
  `3/3 → 2/2 → 0/0` 的状态展示与权威解绑（AC2/AC3/AC4/AC8/AC10 已标 x）。
- `11-13-desktop-manual-logout-login` 已证明真实便携包 + WebView2 CDP 的验证方式可行（`TRELLIS_DESKTOP_HOME`
  隔离数据目录、独立 mock/真实服务端口、CDP 读 DOM）。
- `11-13-fix-desktop-onboarding-preflight-contract` 修复了接入弹窗预检返回契约，正常接入弹窗路径不再被阻塞。

## Requirements

### R1 三客户端在线切换必须真机验证

- 三台独立数据目录的真实客户端绑定同一 taskSpace，验证任一客户端切换分支后只把自己从在线监听集合移除，
  其余两个仍计为在线监听。
- 三台全部切换后，项目栏显示 `0/3 当前未激活，关联保留`；切回后恢复在线监听且不需要重建 taskSpace。

### R2 真实设备超时必须真机验证

- 客户端进程被杀或断网后不再上报心跳，在服务端统一阈值（当前 60s 量级）到期后自动从在线监听集合移除。
- 到期前不得抖动；approved binding 与“暂未激活”状态保留。

### R3 断网解绑与待确认重试必须真机验证

- 断网状态下执行“不再同步此分支”，客户端进入 `detachPending` 并停止该分支 watcher/上传/补同步，
  UI 显示待确认状态。
- 恢复网络后自动重试成功，服务端 binding 变为 revoked，本地 binding 与 cursor 被清理。
- 重试期间不得静默保持服务端 approved 关联，也不得重复写入审计。

### R4 运行中停止写入必须真机验证

- 在真实 watcher、上传队列、pull 运行期间解绑该分支，证明解绑后不再产生该 taskSpace 的任务写入、
  上传请求或命令投递。

### R5 响应式布局必须真实浏览器验证

- 浅色与深色主题下，1440 / 1024 / 860px 三档宽度检查项目栏监听状态、解绑确认框与接入弹窗：
  无内容截断、无横向溢出。

### R6 接入弹窗路径必须端到端验证

- 通过正常接入弹窗完成临时项目绑定（远端 + Trellis 初始化 + 开发者 ID + 团队 + 预检 + 关联），
  证明预检契约修复后整条链路可用。

### R7 其余报告验证边界补测

- `11-13-fix-agent-task-scan-file-limit`：在有 Rust 工具链环境执行真实单批边界拒绝（任务文件数超限被拒）。
- `11-10-team-archive-index-query`：独立模式归档在独立实例做浏览器回归。
- `11-11-fix-project-rail-sync-status-leak`、`11-12-support-dsh-agent-onboarding`、
  `11-12-harden-desktop-sidecar-lifecycle`：补齐真实 WebView2 路径，替换最小 IPC mock；
  侧车超时与 ProjectRail 防重入补可复现夹具。

### R8 结论必须回写

- 每项验收完成后把证据（时间、构建号、客户端版本、关键响应/日志/截图）追加到对应 e2e 报告，
  并在原报告未勾选的 AC 上更新结论；无法完成的项要写明阻塞原因，不得留空。

## Acceptance Criteria

- [ ] AC1 三客户端在线切换真机通过（对应 `11-12-branch-listener-unbind-lifecycle` AC1）。
  — 阻塞：同机第二个实例被 `tauri-plugin-single-instance`（`apps/desktop/src-tauri/Cargo.toml:15`、
  `src/main.rs:906`）转发后退出，需三台真机补测；`3/3 → 2/2 → 0/0` 聚合仍由原 fixture 证据覆盖。
- [x] AC2 真实 60s 超时自动离线真机通过（AC5）。第 63s 翻转，60s 内无抖动，binding 保持 approved。
- [x] AC3 断网解绑 → `detachPending` → 恢复网络自动重试通过（AC15、AC6 部分）。恢复后 30s 内 revoked、审计恰 1 条。
- [x] AC4 运行中解绑后停止写入真机通过（AC6 剩余部分）。解绑后新任务提交 20s 内计数零变化。
- [x] AC5 浅色/深色 × 1440/1024/860px 布局通过。无横向溢出；附带发现 TopBar 窄屏折行（另案）。
- [x] AC6 正常接入弹窗完成临时项目绑定通过。两轮预检 + 接入均成功，无预检契约报错。
- [x] AC7 R7 列出的验证边界项全部补测或明确标注不可测原因。`fix-agent-task-scan-file-limit` 已真机补测
  （1101 文件被 `单批任务文件不能超过 1024 个` 拒绝），其余三项已在报告中标注原因与后续排期建议。
- [x] AC8 对应 e2e 报告的结论与 AC 勾选状态已更新。含 `11-12-branch-listener-unbind-lifecycle` §9 与
  `11-13-fix-agent-task-scan-file-limit` 结论补充。

## Out Of Scope

- 不新增产品功能；只补验收证据。发现真实缺陷时另开修复任务，不在本任务内改代码。
- 不重跑已通过的自动化测试来“再确认一遍”。
- 不清理或修改历史报告的既有证据行。

## Technical Notes

- 桌面测试拓扑参考 `11-13-desktop-manual-logout-login/e2e-report.md`：隔离 `TRELLIS_DESKTOP_HOME`、
  独立端口服务、WebView2 CDP 读页面状态。
- 三客户端场景建议用独立 worktree + 独立 `localRepoKey`，避免 `ConfigStore` 同仓库多绑定拒写
  （`CONFIG_INVALID`）。
- 断网可用防火墙/代理规则或停服务实现；恢复后需确认客户端重试节奏与审计条数。
- 本任务以真机验证为主，不需要改代码，属于轻量任务；如需新增夹具再评估是否补齐 `design.md`。
