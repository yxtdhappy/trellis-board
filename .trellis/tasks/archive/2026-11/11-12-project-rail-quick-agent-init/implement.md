# 实施计划

## 1. 前置

- [x] 读取 `trellis-before-dev` 并确认当前任务状态为 `in_progress`。
- [x] 复核工作区改动，只触碰本任务文件；保留其他未跟踪任务。
- [x] 检查 `implement.jsonl` 与 `check.jsonl` 中的规范入口仍然有效。

## 2. 共享预检与 Agent 列表

- [x] 新增 `web/src/lib/project-inspection.js` / `.d.ts`，从接入向导提取项目预检规范化，并补 Node 行为测试。
- [x] 更新 `ProjectOnboardingDialog` 使用共享预检规范化，行为保持不变。
- [x] 新增 `AgentToolSelector`，迁移接入向导现有 Agent 搜索、列表、已初始化置灰和勾选展示。
- [x] 将接入向导与快速弹窗统一使用该组件。

## 3. 快速初始化 UI

- [x] 新增 `AgentQuickInitDialog`，按 `taskSpaceId` 加载预检、编辑 developer ID、多选缺失 Agent、提交并处理成功/失败。
- [x] 在 `ProjectRail` 的已批准关联图标右侧增加 Agent 入口、目标状态和弹窗组合。
- [x] 代码审查确认未批准关联不进入 Agent 入口分支；只读已批准关联仍可显示入口。
- [x] 代码审查确认取消/关闭不调用初始化，成功后关闭并给出准确提示。

## 4. 桌面命令与权限

- [x] 在 `main.rs` 抽取 developer ID 和 Agent 工具校验，并新增已批准本地关联解析 helper。
- [x] 新增 `inspect_associated_project_agents` 与 `initialize_associated_project_agents`，接入现有 sidecar 函数。
- [x] 添加 Rust 纯逻辑测试：只选择 approved 关联，拒绝缺失/撤销关联，并覆盖完整 22 项 Agent 目录。
- [x] 在 permission、capability、invoke handler 和 `desktop-package.test.js` 同步新命令。
- [x] 更新 `desktop/README.md` 中快速入口、安全边界和权限清单。

## 5. 回归与静态检查

- [x] 运行相关 Node 测试：44/44 通过。
- [x] 已按用户要求中止全量 Node 回归，不再重跑。
- [ ] 运行 Rust 测试：`cargo test --manifest-path desktop/src-tauri/Cargo.toml`。
- [x] 运行格式检查与 oxlint；仅本次 9 个前端/测试文件格式通过，oxlint 无 error。
- [x] 检查 `git diff`，确认无服务端 API、数据库或本任务无关文件变化。

## 6. 最终一次构建与端到端

- [x] 所有源码完成后只执行一次 Web 构建：`npm run build`，通过。
- [ ] 构建并启动包含新 Rust 命令的桌面客户端；不得只验证远程 Web 页面。
- [ ] 在真实 Tauri 页面验证：入口位于文件夹图标旁、无目录选择、已初始化置灰、搜索、多选、成功追加、重开状态、空选择和无效输入。
- [ ] 验证现有“接入本地项目”、重新关联和同步状态展示无回归。
- [ ] 验证失败路径不会留下部分写入或错误成功提示。

## 7. 风险文件与回滚点

- 高风险：`desktop/src-tauri/src/main.rs`、`desktop/src-tauri/permissions/desktop.toml`、`desktop/src-tauri/capabilities/board-local-association.json`。
- 中风险：`ProjectRail.tsx` 的图标区域布局和 `ProjectOnboardingDialog.tsx` 的共享组件迁移。
- 每个阶段完成后仅做相关单元测试；除最终一次构建外，不运行编译命令。
- 若桌面命令权限导致旧流程失效，回滚到阶段 3 之前状态，不修改已有关联数据。

## 8. 收尾门禁

- [ ] PRD 所有验收项有事实证据；桌面编译、IPC 和真实 Tauri 页面仍待验证。
- [x] 新规则已同步到前后端规范中的真实契约位置。
- [ ] 未自动 commit、push 或归档；等待用户明确要求。
