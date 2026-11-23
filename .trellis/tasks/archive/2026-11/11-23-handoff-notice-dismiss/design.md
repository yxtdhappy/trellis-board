# 设计：任务认领状态面板手动关闭

## 1. 边界与数据流

```
StoredTaskHandoff.materialized_at
  └─ HandoffNotice { ..., materialized_at }        (Rust DTO, camelCase)
       └─ Tauri command handoff_notice_pending     (main.rs:878-884)
            └─ invoke('handoff_notice_pending')
                 └─ normalizeHandoffNotices()      (web/src/lib/handoff-notice.js)
                      ├─ handoffNoticeKey()        (~ toast 去重键)
                      ├─ visibleHandoffNotices()   (过滤 dismissed + cleaned)
                      └─ HandoffNotice.tsx 渲染 + 关闭按钮
                           └─ localStorage: trellis.handoff-notice-dismissed.v1
```

关闭不经过 Rust 与 server，不触发任何 ACK。

## 2. 契约

### 2.1 Rust DTO

`packages/desktop/src-tauri/src/agent/task_control.rs:340-351`：

```rust
pub struct HandoffNotice {
    pub execution_task_key: String,
    pub task_id: String,
    pub relative_dir: String,
    pub handoff_state: String,
    pub ack_state: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub backup_id: Option<String>,
    pub materialized_at: Option<String>, // 新增；serde camelCase -> materializedAt
}
```

- `notice()`（`task_control.rs:321-337`）从 `self.materialized_at.clone()` 取值。
- 缺失时序列化为 `"materializedAt": null`；旧前端忽略该字段。
- 不改 `handoff_notice_pending` 命令签名与 capability。

### 2.2 Web 归一化

`normalizeHandoffNotices(value)` 沿用现有字段必填校验；`materializedAt` 允许缺失/非字符串，统一为 `null`。

### 2.3 通知键

```
noticeKey(n) = `${executionTaskKey}:${handoffState}:${outcome || 'checking'}:${materializedAt || '-'}`
```

- 同时用于 toast 去重与面板关闭，保证「新轮次 = 新键」。
- 兼容迁移：升级前写入的旧键不含轮次后缀。toast 判定时额外检查旧键
  `${executionTaskKey}:${handoffState}:${outcome || 'checking'}`，命中则视为已提示，并写入新键，
  避免升级后对现存 4 条冲突重复弹 toast。
- 关闭存储没有历史数据，不需要迁移。

### 2.4 关闭存储

- Key：`trellis.handoff-notice-dismissed.v1`
- Value：`string[]`，去重、保留最近 200 条（`slice(-200)`，与现有 notified 存储一致）。
- 读取失败/内容非法 → 空集合；写入失败 → 仅内存生效。
- 不做「按当前通知裁剪」：通知短时消失不应撤销用户的关闭决定；上限 200 足够约束增长。

## 3. 组件行为

`HandoffNotice.tsx`：

1. `load()` 返回并 `setNotices`，同时读取 dismissed 集合。
2. `persistentNotices = visibleHandoffNotices(notices, dismissed)`，内部过滤：
   - `outcome === 'cleaned'` 永不进入固定面板；
   - `dismissed.has(noticeKey(notice))` 不显示。
3. 标题行改为 flex 容器，右侧 `<button aria-label="关闭任务认领状态提示" title="关闭">` +
   `<X className="size-3.5" />`（lucide）。
4. `dismissAll()`：
   - 对当前 `persistentNotices` 的每个键写入 dismissed 集合（包括未展示的第 4 条及以后）；
   - 同步把键写入 `trellis.handoff-notice-notified.v1`；
   - `setDismissed(next)` 立即隐藏。
5. 面板渲染条件仍为 `invoke && persistentNotices.length > 0`。
6. toast 逻辑（`notifyVisible`）保持原有节流/可见性判断；键改为新 `noticeKey`，并做旧键兼容判定。

## 4. 兼容性与取舍

- **旧客户端 + 新前端**：`materializedAt` 缺失 → 键后缀为 `-`，关闭行为仍生效；同一记录稳定。
- **新客户端 + 旧前端**：多出的 JSON 字段被忽略。
- **升级后重复 toast**：通过旧键兼容判定避免一次性重复提示；升级后第一次进入 Board 不会因键变化重弹。
- **同任务新轮次**：`materializedAt` 变化（服务端再次委派时清空并重新物化，见
  `.trellis/spec/backend/desktop-realtime-sync.md:448-453`）→ 新键未被关闭 → 重新显示。
- **为什么不按条关闭**：需求是消除常驻噪声，面板级一键关闭足够；逐条关闭增加交互与存储复杂度，收益低。
- **为什么不改服务端**：冲突本身无法通过客户端 ACK 收敛，服务端也没有「接受保留」状态；本次只解决展示不可关闭的问题。

## 5. 规范更新

- `.trellis/spec/backend/desktop-realtime-sync.md:437-441`：通知键加入 `materializedAt`；冲突提示
  由「持续显示」改为「持续可见但可按轮次关闭，新轮次重新显示」。
- `.trellis/spec/backend/desktop-agent-runtime.md:316-317`：补充关闭与持久化语义（如该段描述页内提示）。

## 6. 测试与验证

- `packages/web/test/handoff-notice.test.js`（新增，`node --test`）：
  - 归一化：完整字段、缺失 `materializedAt`、非数组/脏数据；
  - `handoffNoticeKey`：同任务不同轮次不同键；缺失轮次稳定；
  - `visibleHandoffNotices`：过滤 `cleaned`、过滤 dismissed、保留新轮次；
  - `readDismissed`/`writeDismissed`：损坏 JSON、空值、去重、200 条上限。
- `packages/desktop/src-tauri/src/agent/task_control/tests.rs`：
  - `notice()` 返回 `materialized_at`；
  - serde JSON 含 `materializedAt`；
  - 无轮次记录返回 `null`。
- 命令级验证（全部开发完成后执行一次）：
  - `yarn test`
  - `yarn build`
  - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`

## 7. 回滚

- 回滚 Web 组件与 lib 即可恢复原常驻提示；Rust 新增字段是附加字段，保留也不影响旧行为。
- 已写入的 `trellis.handoff-notice-dismissed.v1` 在旧版本中被忽略，无需清理。