# Journal - kanyifei (Part 1)

> AI development session journal
> Started: 2026-11-20

---



## Session 1: Team 服务端集成 Tauri 客户端自动更新
<!-- trellis-session: v=2 fp=9dfeec96f30814de -->

**Date**: 2026-11-24
**Task**: Team 服务端集成 Tauri 客户端自动更新
**Package**: server
**Branch**: `main`

### Summary

服务端新增 /client-updates/ 免登录托管与 TRELLIS_CLIENT_UPDATES_DIR 配置，Tauri 客户端支持 TRELLIS_UPDATE_SERVER 优先与 Team 服务端地址自动回退，补充 docs/client-auto-update.md、单元测试与 Spec 更新

### Git Commits

| Hash | Message |
|------|---------|
| `dc16f0a` | feat(update): host client updates on team server and fallback desktop updater to server URL |
| `9f65f18` | docs(update): document team-hosted client auto-update, jenkins pipeline, and tauri spec |

### Status

[OK] **Completed**


## Session 2: Retire desktop plugins.json and expose trellis.user core capability
<!-- trellis-session: v=2 fp=6a2f7adeb151cefe -->

**Date**: 2026-11-24
**Task**: Retire desktop plugins.json and expose trellis.user core capability
**Package**: server
**Branch**: `main`

### Summary

Added trellis.user.current and trellis.projects.developers core capabilities, replaced desktop plugins/plugins.json with minimal plugin-state.json + one-time migration, and upgraded witops-core with zero-config 5-level assignee auto-association and dialog binding UI.

### Git Commits

| Hash | Message |
|------|---------|
| `4353a483` | feat(plugins): expose trellis.user.current and trellis.projects.developers core capabilities |
| `b64c51d5` | refactor(desktop): retire plugins.json in favor of plugin-state.json and user injection |
| `9eb94487` | feat(witops-core): auto-associate assignee from logged-in user and add dialog binding UI |

### Status

[OK] **Completed**


## Session 3: 修复 witops-core 项目下拉与 PRD 占位流程绑定
<!-- trellis-session: v=2 fp=4510a9b25c6ea3ca -->

**Date**: 2026-11-26
**Task**: 修复 witops-core 项目下拉与 PRD 占位流程绑定
**Package**: server
**Branch**: `main`

### Summary

团队插件宿主的项目快照能被 trellis.projects/trellis.repositories 读到；witops-core 的 prd.md 改为一句事实占位，不再写死 trellis-brainstorm 或步骤清单。

### Main Changes

- core capabilities 通过 repositoriesProvider 读取实时快照，修复 Team 插件项目下拉不全（core-capabilities.js、supervisor.js）
- 新增 team host 回归测试：provider 快照变化后可被 projects/repositories capability 读到
- witops-core mapper 的 prd.md 占位改为「平台原文在 task.md；prd.md 尚未生成，本文件为占位。」，删除 checklist 与 skill 名
- 同步 dispatch.js 注释、README 产物契约、task-service 占位注释

### Git Commits

| Hash | Message |
|------|---------|
| `f04013f1` | fix(witops-core): read latest project snapshot and drop hardcoded PRD steps |

### Testing

- [OK] node --test packages/server/test/team-plugin-host.test.js（7 pass）
- [OK] node --test packages/server/test/plugin-core-capabilities.test.js（6 pass）
- [OK] node --test plugins/witops-core/test/index.test.js（38 pass）
- [OK] TRELLIS_PYTHON=python3 PYTHON=python3 yarn test --scope=core（783 pass / 0 fail）
- [OK] TRELLIS_PYTHON=python3 PYTHON=python3 yarn test --scope=plugins（140 pass / 0 fail）

### Status

[OK] **Completed**

### Next Steps

- 若要让插件完全不写 prd.md，需另开任务改三处占位检测（方案 B）


## Session 4: 修复插件宿主 Python 解析与 spawn EACCES 回退
<!-- trellis-session: v=2 fp=5d76bc22799ca242 -->

**Date**: 2026-11-27
**Task**: 修复插件宿主 Python 解析与 spawn EACCES 回退
**Package**: server
**Branch**: `main`

### Summary

插件宿主不再裸 spawn python：解析 client.json 记录/PATH/Windows 安装目录，跳过 0 字节别名，spawn 失败继续候选并返回 1011；Rust 自愈 flag、注入 TRELLIS_PYTHON，新增 runtime_open_gate；witops-core 保留错误码。

### Main Changes

- server: 统一 Python 候选解析与 ENOENT/EACCES/EPERM/EFTYPE 回退，createTask 透传 env
- desktop: flag 自愈、宿主注入、runtime_open_gate 与 Board capability 白名单
- witops-core: failureResult 保留数值业务错误码

### Git Commits

| Hash | Message |
|------|---------|
| `20a5c21c` | fix(runtime): resolve a runnable Python for plugin task creation |
| `74d97475` | chore(task): archive 11-27-plugin-python-runtime |

### Testing

- [OK] Linux yarn test --scope=all：963 pass / 0 fail / 3 skip；Windows 单测与 cargo 461 pass；Windows 构建与启动通过

### Status

[OK] **Completed**

### Next Steps

- 0.5.18 已安装 runtime 需随新版客户端更新后生效
