# 桌面接入预检返回契约与接入弹窗滚动修复

## Goal

修复桌面客户端“接入本地 Git 项目”链路里两个用户可见问题：点击“检查任务差异”必然报
“没有返回有效的任务预检结果”，以及该弹窗同时出现两个纵向滚动条。同时把 Tauri 命令返回值形状写成
可回归的契约，避免同类包装错误再次出现。

## Background

用户在使用 `TrellisBoard 0.4.0` 客户端接入本地仓库 `trellis-board` 时复现：远端、Trellis 初始化状态、
Git 状态均正常读取，`Trellis developer ID` 与团队已填，但点击“检查任务差异”后只显示
“没有返回有效的任务预检结果”；弹窗右侧还有一个嵌套滚动条覆盖在 Agent 选择网格上。

只读定位结论：

- 服务端 `POST /api/agent/task-spaces/preflight` 本身成功，预检结果在 Rust 侧被多包了一层。
- `apps/desktop/src-tauri/src/agent_service.rs` 的 `preflight_project` 返回
  `{ "ok": true, "result": {...} }`，而 `apps/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`
  的 `normalizePreflight` 只读顶层 `status`，读不到即 `throw new Error('没有返回有效的任务预检结果')`。
- 同批命令 `check_pending_project_push`、`associate_pending_project`、`list_local_associations` 都返回扁平对象，
  只有 preflight 保留了旧 sidecar 的 `{ok,result}` 信封；`inspect_project` / `initialize_project` 用的是
  `{ok, project}`，由 `apps/web/src/lib/project-inspection.js` 的 `normalizeProjectInspection` 解包。
- 双滚动条来自 `apps/web/src/features/board/dialogs/AgentToolSelector.tsx` 的 Agent 网格
  `max-h-64 overflow-y-auto`；弹窗外壳 `DialogContent` 是 `overflow-hidden`，`DialogBody` 已经是
  `overflow-y-auto`，所以内层再滚动就出现了两条滚动条。
- `.trellis/tasks/archive/2026-11/11-12-branch-listener-unbind-lifecycle/e2e-report.md:65` 已经记录过同一现象，
  当时判定“不在本任务范围内，本轮未修改”，因此该缺陷从 Rust 迁移起一直存在。

## Requirements

### R1 预检结果必须按前端已约定的形状返回

- `preflight_pending_project` 必须返回扁平对象：顶层直接包含 `status`、`revision`、`differences`、`counts`、
  `inspected`，并保留既有 `ok: true` 字段。
- 不得再引入 `{ ok, result }` 中间层；前端 `normalizePreflight` 不需要为兼容旧信封增加分支。
- 服务端返回无效响应时仍需给出明确错误，不得把包装层当成校验缺失。

### R2 只允许一层滚动

- “接入本地 Git 项目”弹窗内只有 `DialogBody` 的整体滚动条；Agent 选择网格不得自带 `overflow-y-auto` 或
  `max-h-*` 截断容器。
- 同一个 `AgentToolSelector` 在 `AgentQuickInitDialog` 中复用，两处都只能是整体滚动。
- 弹窗头部、尾部仍为固定区域，长内容不挤压按钮区。

### R3 契约必须可回归

- `.trellis/spec/backend/desktop-agent-runtime.md` 必须写明：`check_pending_project_push`、
  `preflight_pending_project`、`associate_pending_project`、`list_local_associations` 返回扁平对象，
  只有 `inspect_project` / `initialize_project` 使用 `{ ok, project }`。

## Acceptance Criteria

- [ ] AC1 `preflight_project` 返回的对象顶层存在 `status`，且 `ok === true`；`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` 通过。
- [ ] AC2 真实接入弹窗点击“检查任务差异”后渲染预检卡片（`new`/`branch_new`/`existing`/`access_required`/`unavailable` 之一），不再出现“没有返回有效的任务预检结果”。
- [ ] AC3 弹窗内 `.trellis` 相关组件没有第二个纵向滚动容器；`AgentToolSelector` 网格不再有 `max-h-*`/`overflow-y-auto`。
- [ ] AC4 `npm test` 通过，`npx oxfmt --check` 对改动文件通过。
- [ ] AC5 spec 已记录 Tauri 命令返回形状契约。

## Out Of Scope

- 不改动服务端 `/api/agent/task-spaces/preflight` 的响应字段与权限逻辑。
- 不调整预检差异分类、`initialMode` 决策或接入后的首次同步行为。
- 不为 `inspect_project` / `initialize_project` 的 `{ok, project}` 形状做统一改造。
- 不处理下方“e2e 遗留清单”中的真机验收项，除非用户另行确认。

## e2e 报告遗留问题清单（核查结果）

已关闭：

- `11-11-fix-agent-startup-sync-status`：`--task-space` 参数错误已在该报告后半段用安装包复验通过。
- `11-12-branch-listener-unbind-lifecycle:65`：预检返回契约问题在本任务修复。

仍未闭环（均为“未完成真机验收”或补充验证，不是已确认的新缺陷）：

| 来源 | 遗留项 | 性质 |
| --- | --- | --- |
| `11-12-branch-listener-unbind-lifecycle` §7 | 三台真实桌面客户端同时在线切换 | 真机验收缺口 |
| 同上 | 真实 60 秒设备超时后自动离线 | 真机验收缺口 |
| 同上 | 断网解绑、`detachPending` 展示、恢复网络后自动重试 | 真机验收缺口 |
| 同上 | 真实 watcher/upload/pull 运行中停止写入（当前仅自动化测试） | 真机验收缺口 |
| 同上 | 浅色/深色、1440/1024/860px 完整响应式布局 | UI 验收缺口 |
| 同上 | 通过正常接入弹窗完成临时项目绑定（被预检缺陷阻塞） | 本任务修复后可补测 |
| `11-13-fix-agent-task-scan-file-limit` §5 | Rust 编译与真实单批边界拒绝需在有工具链环境补跑 | 验证补充；本机 `cargo check` 已覆盖编译部分 |
| `11-10-team-archive-index-query` §已知限制 | 独立模式归档未在独立实例做浏览器回归 | 验证补充 |
| `11-11-fix-project-rail-sync-status-leak` §限制 | 仅 Chrome + 最小 Tauri IPC mock，未走已安装 WebView2 | 验证方式限制 |
| `11-12-support-dsh-agent-onboarding` §限制 | E2E 用最小 IPC mock；“初始化缺失工具”按钮未真实点击 | 验证方式限制 |
| `11-12-harden-desktop-sidecar-lifecycle` §已知限制 | Rust 超时分支无真实挂起夹具；`ProjectRail` 防重入无浏览器夹具 | 验证方式限制 |

## Technical Notes

- 主要改动文件：`apps/desktop/src-tauri/src/agent_service.rs`、
  `apps/web/src/features/board/dialogs/AgentToolSelector.tsx`、
  `.trellis/spec/backend/desktop-agent-runtime.md`。
- 本机 `cargo fmt --check` 在 `agent/detach.rs`、`agent/task_sync.rs` 等未改动文件已有 diff（rustfmt 版本漂移），
  提交前不要把无关文件纳入格式化改动。
