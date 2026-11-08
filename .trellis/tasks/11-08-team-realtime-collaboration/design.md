# 团队模式客户端实时双向同步总体设计

## 1. 目标

把桌面登录、项目关联和团队实时任务同步串成一条完整链路：

```text
账号密码登录
  -> 服务端 Session + 设备凭据
  -> Board 项目栏展示团队项目
  -> 关联本地 Git 仓库
  -> Team Member + Git 强校验自动生效
  -> sidecar 监听项目 .trellis
  -> 未提交任务内容上报
  -> 服务端文件级权威版本
  -> 其他客户端更新 Board 和本地 .trellis
```

## 2. 子任务边界

### `11-08-desktop-account-login`

负责：

- 本地登录页；
- WebView Session Cookie；
- 设备凭据和 sidecar 启动；
- Board 项目栏本地关联入口；
- 本地 Git 根目录、分支、origin 强校验；
- Team Member 自动关联；
- `read_only` 关联；
- 项目停用、团队移除和设备撤销后的失效。

不负责：

- 未提交文件变化监听；
- 文件上传、广播、备份和实时冲突。

### `11-08-team-realtime-task-sync`

负责：

- 共享 watcher；
- sidecar 变化上报；
- 服务端实时版本和任务投影；
- SSE/Board 快速刷新；
- 本地文件应用、备份和复原；
- 责任人预警和接管；
- Git 收敛。

## 3. 跨子任务契约

### 登录与设备

- 登录只验证账号密码，不选团队。
- Session Cookie 只写 WebView Cookie Store。
- 密码不持久化。
- 设备凭据只存 Windows DPAPI。

### 项目关联

- 项目由服务端从远端 Git 创建，客户端不能新增项目。
- 客户端只在 Board 项目栏提供本地关联入口。
- 远程 Board 只获得 `associate_local_project` 和 `list_local_associations` 两个 Tauri 命令。
- 本地目录选择器由 Rust 命令内部调用，不开放通用 dialog 权限。
- active team member 可关联该团队全部 active 项目。
- Git 根目录、同步分支和规范化远端身份必须匹配。
- 新绑定直接有效，不再人工审批。
- 显式 `project_member.role=read_only` 只接收服务端内容，不上传本地修改。

### 实时同步

- 仅有效关联项目启动 watcher。
- `read_only` 项目只启动接收流程。
- 服务端文件级版本是权威状态。
- 同一文件后到覆盖，不同文件合并。
- 冲突方先备份再覆盖。
- 一键复原形成新版本。
- 责任人警告阻断上传，但不阻塞原责任人在线确认。

## 4. 实施顺序

1. 完成 `11-08-desktop-account-login`。
2. 在真实 Windows 客户端验证登录、Session Cookie、项目关联和自动绑定。
3. 开始 `11-08-team-realtime-task-sync`。
4. 验证 sidecar watcher、服务端实时版本、文件落盘和冲突提示。
5. 父任务执行两个子任务的组合 E2E。

父任务不拥有直接产品代码，不单独执行 `task.py start`。

## 5. 组合验收

- Windows 客户端全新登录后进入 Board。
- Board 项目栏可选择本地同一 Git 项目并立即关联。
- 本地修改未提交任务状态后，另一客户端在 3 秒内同时看到 Board 和本地 `.trellis` 变化。
- `read_only` 成员接收变化但不能上传。
- 同一文件冲突后本地有备份且可一键恢复。
- 非责任人修改时有警告，继续与接管行为符合约定。

## 6. 风险

- 远程 Tauri capability 必须尽量窄，并以动态 Board origin 做 Rust 二次校验。
- WebView2 Cookie 和远程 IPC 都必须在安装包中实测。
- 自动写回本地 `.trellis` 会影响开发者工作区，备份和复原是必需能力。
- 实时文件与 Git 长期分叉时必须显式显示，不能静默清理。

