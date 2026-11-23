# 实施计划：任务认领状态面板手动关闭

> 状态（2026-11-23）：步骤 1–4 已完成；步骤 5 中 `yarn test`、`yarn build` 通过，
> `cargo test` 因本机无 Rust 工具链未执行；步骤 6 未执行（按全局规则不主动提交）。

> 全程不执行构建/编译；所有验证命令在步骤 5 一次性执行。

## 步骤 1：Rust 通知载荷携带轮次

- [ ] `packages/desktop/src-tauri/src/agent/task_control.rs`
  - `HandoffNotice` 增加 `pub materialized_at: Option<String>`（`serde(rename_all = "camelCase")`
    已覆盖，无需额外 rename）。
  - `StoredTaskHandoff::notice()` 填入 `self.materialized_at.clone()`。
- [ ] `packages/desktop/src-tauri/src/agent/task_control/tests.rs`
  - 现有 notice 断言处补充 `materialized_at` 校验。
  - 新增用例：有轮次 → `Some(...)` 且 JSON 含 `"materializedAt"`；无轮次 → `null`。

验证（步骤 5 执行）：`cargo test task_control`

## 步骤 2：Web 纯逻辑模块

- [ ] 新增 `packages/web/src/lib/handoff-notice.js`
  - `HANDOFF_NOTICE_DISMISSED_STORAGE_KEY = 'trellis.handoff-notice-dismissed.v1'`
  - `normalizeMaterializedAt(value)`：字符串非空 trim，否则 `null`
  - `normalizeHandoffNotices(value)`：迁入现有归一化逻辑，新增 `materializedAt`
  - `handoffNoticeKey(notice)`：四段键
  - `legacyHandoffNoticeKey(notice)`：旧三段键（升级兼容）
  - `readDismissedNotices(storage)` / `writeDismissedNotices(storage, ids)`
    - 去重、只保留字符串、`slice(-200)`、异常吞掉
  - `visibleHandoffNotices(notices, dismissedIds)`
    - 过滤 `outcome === 'cleaned'` 与已关闭键；保持原顺序
- [ ] 新增 `packages/web/test/handoff-notice.test.js`
  - 覆盖归一化、键、轮次变化、`cleaned` 过滤、脏存储、200 条上限。

验证（步骤 5 执行）：`node --test packages/web/test/handoff-notice.test.js`

## 步骤 3：组件接入关闭入口

- [ ] `packages/web/src/desktop/HandoffNotice.tsx`
  - 删除本地重复归一化/键函数，改为从 `@/lib/handoff-notice.js` 导入。
  - 状态：`notices`、`dismissed`（初始化读取存储）。
  - `persistentNotices = visibleHandoffNotices(notices, dismissed)`。
  - `load()` 后按需清理/保持 dismissed（不裁剪，仅依赖写入上限）。
  - `dismissAll()`：把当前 `persistentNotices` 的全部键写入 dismissed 与 notified，`setDismissed`。
  - 标题行改 flex，右侧 `<button type="button" aria-label="关闭任务认领状态提示" title="关闭">`
    + lucide `X`；样式匹配现有 `text-muted-foreground hover:text-foreground`。
  - `notifyVisible`：使用新 `handoffNoticeKey`；旧键命中时补写新键并跳过 toast。
  - 保留 `aria-live="polite"`、`pointer-events-none`/`pointer-events-auto` 结构与 `slice(0, 3)` 展示。
- [ ] 交互自查（代码层）：点击关闭不得调用 `invoke` 写操作；关闭后 `persistentNotices` 为空，
  组件返回 `null`。

## 步骤 4：规范同步

- [ ] `.trellis/spec/backend/desktop-realtime-sync.md:437-441`
  - 通知去重键加入 `materializedAt`（并说明旧键兼容）。
  - 冲突提示改为「持续可见但允许按轮次手动关闭；新轮次重新显示」。
- [ ] `.trellis/spec/backend/desktop-agent-runtime.md:316-317`
  - 如该段描述页内提示，补充关闭与 `localStorage` 持久化语义。

## 步骤 5：一次性验证

- [ ] `yarn test`
- [ ] `yarn build`
- [ ] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
- [ ] `python .trellis/scripts/task.py validate .trellis/tasks/11-23-handoff-notice-dismiss`

失败处理：任一命令失败先修复再重跑该命令；不跳过。

## 步骤 6：交付

- [ ] 更新 PRD AC 勾选（仅勾选已验证项）。
- [ ] `python .trellis/scripts/add_session.py --title "..." --summary "..."`
- [ ] 按项目约定提交（提交前确认工作区无无关改动）。

## 回滚点

- 步骤 1 后：回滚 Rust 字段，前端尚未依赖，系统行为不变。
- 步骤 2 后：纯新增模块，未接入，可直接删除。
- 步骤 3 后：回滚组件即恢复原常驻提示；Rust 附加字段可保留。
- 步骤 4 后：规范回滚独立于代码。