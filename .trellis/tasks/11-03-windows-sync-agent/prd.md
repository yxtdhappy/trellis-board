# 实现 Windows 同步 Agent

## Goal

为每台参与开发的 Windows 机器提供用户级同步 Agent，使被委派人接受任务后，将项目共享分支安全地 fast-forward 到本地仓库。

## Dependencies

- 依赖父任务 `11-03-team-board` 的设计。
- 实现依赖 `11-03-team-core-service` 已冻结并提供的 Agent API、协议版本和错误码。

## In Scope

- Windows 10/11 用户级后台进程、登录启动和异常恢复入口。
- 一次性配对码注册、设备身份、协议版本和可撤销 Bearer 凭证。
- DPAPI CurrentUser 加密凭证；服务端只保存哈希。
- 本地项目绑定、远端归一化校验、分支和 dirty 状态报告。
- 心跳、长轮询、白名单 `sync_branch`/`refresh_status` 命令和结果上报。
- 每个 Agent 对同一项目只绑定一个本地仓库根；更换目录需要重新选择。
- 首版只支持名为 `origin` 且远端与项目配置一致的本地仓库；其他 remote 名称明确拒绝。
- 受控 `git fetch` + `git merge --ff-only --no-overwrite-ignore FETCH_HEAD`，不覆盖 ignored 本地文件，也不自动修改工作区。
- 分支不匹配、dirty、远端不可达、无法 fast-forward、版本过旧和凭证撤销的可操作错误。

## Out of Scope

- macOS/Linux Agent。
- 任务创建、负责人修改、任意 Shell、任意路径、自动冲突解决、stash/reset/checkout。
- Web 管理页面和安装包发布流程。

## Acceptance Criteria

- [ ] 配对码只能使用一次，凭证过期/撤销后下一次请求失败。
- [ ] 凭证文件经 DPAPI 加密，明文不出现在命令行、配置、日志或测试快照。
- [ ] Agent 只接受白名单命令，所有 Git 参数使用固定数组且 `shell:false`。
- [ ] 远端分支校验拒绝 `HEAD`、`@{-1}`、前导 `-` 和 refspec 字符，不执行 reflog 表达式展开。
- [ ] 干净、分支匹配且没有未推送提交时完成 ff-only 同步并上报新 HEAD；本地领先或分叉时拒绝。
- [ ] dirty、分支不匹配、无 fast-forward 时拒绝同步，本地文件和提交不丢失。
- [ ] sparse checkout 或缺失 `.trellis` 工作区时拒绝绑定/同步，不静默只更新 Git 索引。
- [ ] 远端新增文件与本地 ignored 文件同路径时，`--no-overwrite-ignore` 拒绝覆盖并提示处理。
- [ ] Agent 不创建任务分支或 worktree，不执行 checkout/stash/reset/rebase。
- [ ] 服务端不接收本地绝对路径，只接收稳定哈希和展示名。
- [ ] Windows 真实临时仓库测试覆盖成功、dirty、错分支、远端不可达和凭证撤销。
