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
