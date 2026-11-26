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
