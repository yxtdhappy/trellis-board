# Journal - yhj (Part 2)

> Continuation from `journal-1.md` (archived at ~2000 lines)
> Started: 2026-11-26

---



## Session 81: 公司开发规范初始化与生命周期
<!-- trellis-session: v=2 fp=f9f8e9619273c564 -->

**Date**: 2026-11-26
**Task**: 公司开发规范初始化与生命周期
**Package**: desktop
**Branch**: `main`

### Summary

将公司开发规范做成 trellis-kit 可选 feature：首次初始化按项目类型套用，已有项目可补套、更新、换模板；发布 v0.5.12。

### Main Changes

- trellis-kit 新增 company-spec feature、apply.mjs 与 apply.py --feature；registry 提供 9 个模板。
- 桌面端新增项目类型识别、首次初始化下拉、生命周期 inspect/plan/apply 命令与权限。
- Web 新增初始化下拉、公司开发规范对话框与项目栏入口。
- 修复 headless trellis-agent 对 agent_service 的编译依赖，CI 发布 v0.5.12 成功。

### Git Commits

| Hash | Message |
|------|---------|
| `51c55a0` | feat(company-spec): 支持初始化与随时套用公司开发规范 |
| `f7d0d73` | fix(test): 修复 CI 环境下的两处环境依赖 |
| `44dd7ca` | fix(desktop): 解除 headless agent 对 agent_service 的依赖 |

### Testing

- [OK] yarn test --scope=core：784 tests，782 pass，2 skipped。
- [OK] company-spec 8/8、trellis-kit 7/7；Web tsc 通过；真实 registry helper plan/apply 通过。
- [OK] GitHub Actions run 45652078094 全绿，Release v0.5.12 已发布。

### Status

[OK] **Completed**

### Next Steps

- 将 registry 从临时组 prod-mdp 迁移到中性组后同步 feature.json 与已初始化项目配置。


## Session 82: check 报告绑定改用 LF 规范化哈希
<!-- trellis-session: v=2 fp=93bf5c5122656810 -->

**Date**: 2026-11-26
**Task**: check 报告绑定改用 LF 规范化哈希
**Package**: server
**Branch**: `main`

### Summary

check-report 绑定哈希改为 LF 规范化字节，兼容旧原始哈希；stamp-check 写 LF；同步 trellis-kit overlay；新增 CRLF/BOM/旧绑定测试。

### Git Commits

| Hash | Message |
|------|---------|
| `8d183b8` | fix(trellis): check 报告绑定改用 LF 规范化哈希 |

### Status

[OK] **Completed**


## Session 83: 项目栏已关联分支重新绑定
<!-- trellis-session: v=2 fp=594bd031bcc569e5 -->

**Date**: 2026-11-26
**Task**: 项目栏已关联分支重新绑定
**Package**: server
**Branch**: `main`

### Summary

已关联状态的分支图标改为可点击，新增 Board-only 本地分支读取 IPC 与分支弹窗；非当前分支需手动切换，重绑复用既有接入流程。前置拆分 git 模块。Web/desktop 测试与构建通过；Rust 编译待 CI。

### Git Commits

| Hash | Message |
|------|---------|
| `2fb4907` | refactor(desktop): 拆分 git 模块并补充分支列表操作 |
| `2fd7b57` | feat(project-rail): 支持重新绑定当前检出的其他分支 |

### Status

[OK] **Completed**


## Session 84: stamp-check 写回时剥离报告 BOM
<!-- trellis-session: v=2 fp=4804fabb40e98bd3 -->

**Date**: 2026-11-26
**Task**: stamp-check 写回时剥离报告 BOM
**Package**: server
**Branch**: `main`

### Summary

Session summary was not supplied.

### Git Commits

| Hash | Message |
|------|---------|
| `f12b651` | fix(trellis): stamp-check 写回前剥离报告 BOM |

### Status

[OK] **Completed**


## Session 85: 修复归档 SSH 用户名并完成生产验收
<!-- trellis-session: v=2 fp=f18ab47df7bf1dc3 -->

**Date**: 2026-11-26
**Task**: 修复归档 SSH 用户名并完成生产验收
**Package**: server
**Branch**: `main`

### Summary

归档 SSH 用户名持久化到 SQLite，管理页默认 git，兼容存量空用户名并用于 SSH 认证；Jenkins #9-6008968a 发布成功，生产凭据测试返回 200，三个 SSH 归档项目同步成功；严格证据门禁通过并归档任务。

### Git Commits

| Hash | Message |
|------|---------|
| `de6b536` | fix(server): 持久化归档 SSH 用户名 |
| `6008968` | Merge remote-tracking branch 'origin/main' |

### Status

[OK] **Completed**


## Session 86: 切换服务器地址时备份并清理客户端数据
<!-- trellis-session: v=2 fp=aacdc12337c7d910 -->

**Date**: 2026-11-26
**Task**: 切换服务器地址时备份并清理客户端数据
**Package**: server
**Branch**: `main`

### Summary

桌面客户端换服务器时先确认，备份并清理旧服务器的登录/绑定数据，失败自动回滚；已发版 v0.5.14。

### Main Changes

- 新增 client_reset 模块：备份 client.json/agent/desktop-plugins 到 data-backup-<时间戳>（保留 3 份）、清理、恢复
- desktop_login 增加 switchServer 强制确认，新增 desktop_login_preflight 命令与本地登录页确认弹窗
- 登录或后续本地步骤失败时回滚旧数据；运行环境标记回写保持 ready；日志不输出绝对路径

### Git Commits

| Hash | Message |
|------|---------|
| `7fb97b5` | feat(desktop): 切换服务器地址前备份并清理本地数据 |
| `ef0a184` | chore(release): 0.5.14 |

### Testing

- [OK] 新增静态契约测试 4/4；desktop 43 通过/1 跳过；web 136/136
- [OK] tsc、oxlint、改动文件 oxfmt、desktop-ui 构建通过；Rust 由 CI cargo test 验证（本机无工具链）

### Status

[OK] **Completed**

### Next Steps

- 确认 v0.5.14 CI 构建与 Release 结果
- 如需真机 E2E，按 trellis-board-e2e 验证取消/确认/备份目录


## Session 87: 放行 WitOps 图片源以修复 Board 工件预览
<!-- trellis-session: v=2 fp=39ff445519095bdc -->

**Date**: 2026-11-26
**Task**: 放行 WitOps 图片源以修复 Board 工件预览
**Package**: server
**Branch**: `main`

### Summary

Board 工件预览的 CSP 增加 img-src 'self' http://witops.weintdata.cn，历史与新增 task.md 中的平台截图无需重新同步即可显示；补回归断言并更新后端 HTTP 规范。

### Main Changes

- securityHeaders() 增加 img-src 'self' http://witops.weintdata.cn，其余 CSP 指令保持不变
- team-static 测试补 CSP 断言，img-src 缺失时回归失败
- 更新 .trellis/spec/backend/http-and-filesystem.md 记录该放行边界

### Git Commits

| Hash | Message |
|------|---------|
| `6ba7575` | fix(server): 放行 WitOps 图片源以支持任务原文预览 |

### Testing

- [OK] yarn test --scope=server：541 项，540 通过，1 跳过，0 失败
- [OK] node --test packages/server/test/team-static.test.js：3 项全部通过
- [OK] oxfmt --check 改动文件：通过
- [OK] API E2E 不适用：未改 API 路由/契约，页面级由 CSP 断言覆盖

### Status

[OK] **Completed**

### Next Steps

- 部署后打开任务 11-26-B72369 的“工件查看 · WitOps 原文”，确认截图正常显示
- 如后续需支持其他 WitOps 域名，另立需求，不改为动态 CSP


## Session 88: 优化项目成员账号选择体验
<!-- trellis-session: v=2 fp=7b39a1740ee115f3 -->

**Date**: 2026-11-26
**Task**: 优化项目成员账号选择体验
**Package**: server
**Branch**: `main`

### Summary

管理员可从 active 账号中选择项目成员并提交内部 UUID；保存后刷新权威成员列表；项目负责人保留手工 UUID 路径。完成 lint、类型检查、793 项测试、隔离浏览器 E2E 和用户服务端页面人工验收。

### Git Commits

| Hash | Message |
|------|---------|
| `45966b16e43e09570d0c3bc3ce71a94175281edf` | fix(web): improve project member account selection |

### Status

[OK] **Completed**


## Session 89: 服务端项目移除功能收尾
<!-- trellis-session: v=2 fp=e9fcc8b6c90dff61 -->

**Date**: 2026-11-26
**Task**: 服务端项目移除功能收尾
**Package**: server
**Branch**: `main`

### Summary

完成系统管理员永久移除项目：服务端级联清理与最多 5 份备份保留、Web 两步确认入口；本机 API/UI E2E、生产发布及实际删除核查通过。生产日志确认旧项目删除成功并生成备份，另发现 /files 路径未鉴权暴露数据库与日志的风险。

### Git Commits

| Hash | Message |
|------|---------|
| `339678492ea6438261a7ea9ed547f3b795db08a1` | feat(server): 支持永久移除项目 |
| `74a5a4eb1b9d2b26a9ebbd50221fe044c66d864c` | feat(web): 增加系统管理员项目移除入口 |

### Status

[OK] **Completed**


## Session 90: 修复初始化Git忽略规则兼容性
<!-- trellis-session: v=2 fp=01692e75f3204978 -->

**Date**: 2026-11-26
**Task**: 修复初始化Git忽略规则兼容性
**Package**: server
**Branch**: `main`

### Summary

初始化与旧项目一键推送前自愈共享 Trellis 路径反忽略规则，保留用户规则和 CRLF，始终忽略 template hashes，并补充 Git 端到端回归测试及 CI 规则去重修复。

### Git Commits

| Hash | Message |
|------|---------|
| `23360f22f4f133251bd12a50636ca40c7184da3d` | fix-onboarding-compatible-strict-gitignore |
| `f55c819f4c66a5d2eb86e739f9f559569e3b3886` | fix-onboarding-template-hash-dedupe |

### Status

[OK] **Completed**
