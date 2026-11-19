# 设计：首同步复用接入后的归属范围 + 稍后处理生效 + 弹窗显示项目

## 问题边界

服务端在 `packages/server/team/task-control-service.js:795 visibleTaskIds()` 与 `:834 controlsForAgent()` 里，只把「`assignee_user_id = agent.userId` 且未归档」的任务下发给客户端；`packages/server/team/task-snapshot-service.js:289-303` 用这个集合过滤快照文件。客户端首同步（`packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs:239-262 pull_initial_sync`）拿 `local_groups(binding, None)` 全量本地活动目录与这份被裁剪的快照做 `classify_task_snapshots`，于是服务端隐藏的他人任务目录变成 `LocalOnly`。

接入后的常态同步不这样：`pull.rs:458-475` 与 `upload.rs:160-180` 在 `fetch_directory` 收到 403（`TASK_WRITE_FORBIDDEN` / `FORBIDDEN`）时调用 `mark_readonly_dir(&task_space_id, &task_dir, &readonly_reason("FOREIGN_OWNER", &assignee))`，随后目录进入 `cursor.readonly_task_dirs`，被上传/拉取全部跳过。差异是首同步少了这道归属判定。

## 采用方案：首同步前探针（客户端单边）

在 `pull_initial_sync` 内、`classify_task_snapshots` 之前插入一步：

```text
for task_dir in local_groups.map(task_dir) (排除 archive 目录):
    match fetch_directory(task_space_id, task_dir):
        Ok(_)                                  -> 保留（服务端可读，则本应在 server_groups 中出现，按原分类逻辑走）
        Err(e) if is_foreign_task_error(e)     -> mark_readonly_dir(FOREIGN_OWNER, control_assignee(task_dir))
                                                  warn("跳过他人任务目录（只读镜像）：{task_dir}")
                                                  从 local_groups 与参与分类的集合中移除
        Err(e) if is_archived_task_error(e)    -> 从 local_groups 移除（归档残留不参与首同步差异）
        Err(e) if e.status == Some(404)        -> 保留，维持 LocalOnly（真实本地新增任务）
        Err(e)                                 -> 直接返回错误（保持待确认，不吞差异）
```

复用的既有构件（不新增协议、不新增服务端接口）：
- `errors.rs:96 is_foreign_task_error`（403 / `TASK_WRITE_FORBIDDEN` / `FORBIDDEN`）
- `errors.rs:104 is_archived_task_error`（`TASK_ARCHIVED` / `ARCHIVE_SYNC_SERVER_MANAGED`）
- `ownership_inbox.rs:294 mark_readonly_dir`
- `ownership_inbox.rs:325 control_assignee`
- `pull.rs:4 fetch_snapshot` 同级的 `fetch_directory`

契约依据：`packages/server/team/task-control-service.js:808 assertReadable()` —
- 目录不存在 → 404 `NOT_FOUND`「任务不存在」
- 存在但负责人不是本人 → 403 `FORBIDDEN`「只能读取本人任务内容」
- 已归档 → 409 `TASK_ARCHIVED`「任务已归档」

## 关键决策与权衡

1. **探针判归属，而不是读 `task.json.assignee`**：`task.json` 的 assignee 是 trellis dev id，且改派后本地文件可能落后；服务端 403 是权威信号，和常态同步用的是同一个判定。
2. **只在首同步做探针**：常态同步已经有这条路径（`pull.rs`/`upload.rs`），首同步是唯一缺口。若把探针放到 `classify_task_snapshots` 之前的公共入口，会改变常态同步的请求节奏，收益不足以抵消风险。
3. **不复用 `upload_directories` 走一遍上传流程**：那会真的尝试上传、引入 `TASK_FILE_CONFLICT`/租约噪声，review 模式首同步本就不应写服务端。
4. **404 才判“本地新增”**：5xx、超时、DNS 失败一律向上抛错，保持 `pendingReview`，避免真实冲突被静默跳过。
5. **不新增服务端字段**：`visibleTaskIds` 继续裁剪；客户端不需要“隐藏目录清单”来实现正确行为，探针已足够且语义与服务端写闸门一致。

## 数据流

```
pull_initial_sync
  ├─ local_groups(binding, None)                   全量本地活动任务
  ├─ [新增] mark_invisible_local_dirs(binding, &mut local_groups)
  │     · fetch_directory 探针 → readonly/deferred 归零 / 归档剔除 / 404 保留
  ├─ retain_server_groups_for_initial_sync
  ├─ prepare_controlled_server_groups
  ├─ classify_task_snapshots(local, server)        → 只有真实分歧
  └─ review 分支：actionable 为空则不再拦截，继续走 safe/bootstrap 的收尾
```

`mark_readonly_dir` 内部已经处理「清 `deferred` 记录」，因此 R3 无需额外逻辑。

## 方案二：「稍后处理」的记忆（客户端单边）

链路事实：`pull.rs:368` 每轮同步都因 `initial_sync_completed=false` 调用 `pull_initial_sync`；review 分支重新 `emit_differences`；`control_key()` 对 `initial_sync_review` 的 key 含 `revision`（`control.rs:20-25`），所以连“去重覆盖”都不会发生，每轮都是新队列项。`dismiss_with_change()` 只 pop（`control.rs:123-136`），不留任何记忆。

设计：在 `ControlHub` 增加一层“已稍后处理但可重放”的记忆，只对 `initial_sync_review` 生效。

```text
struct DismissedReview { signature: String, payload: Value }

dismiss_with_change():
    pop front
    if front.type == "initial_sync_review":
        dismissed = Some(DismissedReview {
            signature: review_signature(&front),   // 忽略 revision
            payload: front,
        })
    return ...

push_with_change(control):
    if control.type == "initial_sync_review"
       && dismissed.signature == review_signature(&control):
        return (false, false)          // 不入队、不 notify、不聚焦
    if dismissed 存在 && signature 不同: dismissed = None
    ...原逻辑...

reveal_dismissed() -> bool:            // 手动唤回
    take dismissed → 放回队列 → return true

pending(): 不变
```

`review_signature(control)`：取 `taskSpaceId` + 规范化后的 `differences` 数组（按 `taskDir` 排序，只保留 `type/taskDir/local/server` 等结构化字段），**不含 `revision`**。差异集合变化（目录增删、`kind` 变化）就换签名，弹窗重新出现。

接线：
- `agent_service.rs:369-377 dismiss_control`：现有 `dismiss_with_change` 即自动写入记忆，无需改调用方。
- `agent_service.rs:384-396 show_pending_control`：先 `reveal_dismissed()`，再走原有「focus + notify」；保证 ProjectRail `live_control_show`（`ProjectRail.tsx:689`）仍能重新打开。
- `agent_service.rs` `clear_control`（`live_control_initial` 完成后调用，`main.rs:886-888`）：清空 `dismissed`，避免压制后续真实差异。
- `agent_service.rs:311-322 publish_control`：不改逻辑；去重后 `changed=false`，不再触发 `focus_main_window`。

不选“在 `emit_differences` 里去重”的原因：那样 `live_control_show` 拿不到 pending，用户被永久锁在“未完成首同步但无任何入口”的状态。

## 方案三：弹窗显示所属项目（协议字段 + 渲染）

现状：「任务差异需要确认」只在紧凑态列出 `taskSpaceId`（`LiveSyncControlDialog.tsx:663-666`），用户无法判断是哪个项目。已有一致先例：`task_sync_error` 事件由 `errors.rs:9-24 task_sync_error_event` 从 `binding.display_name` / `binding.branch_name` 填 `projectName` / `branchName`；`binding.display_name` 在接入时取服务端 `project.name`（`onboarding.rs:562-568`，回退仓库名）。

做法：
1. 发射端：`initial_sync.rs:420-428 emit_differences` 在事件里补 `projectName: binding.display_name`、`branchName: binding.branch_name`（该函数已持有 `binding`，无需新依赖）。
2. Web 类型：`LiveSyncControlDialog.tsx:57` 的 `initial_sync_review` 分支加 `projectName?: string; branchName?: string`。
3. 渲染：放在 `DialogHeader`（`LiveSyncControlDialog.tsx:652-668`）里 `message` 之后，加一行小字「项目：<projectName> · 分支：<branchName>」，只在 `event.type === 'initial_sync_review'` 且有 `projectName` 时渲染。放 header 的原因：紧凑态与展开态共用同一 header，一处改动两种状态都可见；紧凑态 `<dl>` 里的「任务空间」UUID 原样保留，便于排障。
4. 兼容：新增字段对旧客户端是纯附加，`task_sync_error` 已证明无破坏；旧客户端仍显示 UUID。

## 方案四：用系统通知替代强制抢焦点

现状：`agent_service.rs:305-322 publish_control` 在两处调用 `crate::focus_main_window`（`main.rs:894-900`：`show` + `unminimize` + `set_focus`）：review 类型每次 `changed` 都强制聚焦（注释明写“被关闭过…也要重新露出”），其他类型每进程首次 `became_front` 聚焦一次。用户要求改为发系统通知，不再抢焦点。

做法：
1. `agent_service.rs` 新增 `fn notify_control(&self, control: &Value)`：用 `tauri_plugin_notification::NotificationExt`（`update.rs:206-217` 已有同样用法）发一条 toast。文案由纯函数 `control_notification(control) -> (title, body)` 生成，便于单测：
   - `initial_sync_review` → 标题「有任务差异需要确认」，正文「{projectName}（{branchName}）：{n} 个任务存在差异，打开客户端处理」。
   - `task_file_conflict` → 标题「任务文件冲突」，正文「{projectName}：任务「{title}」与服务端冲突」。
   - `task_ownership_review` → 标题「任务归属需要确认」，正文「{projectName}：{n} 个任务无法判断属于哪个分支」。
   - `task_sync_error` → 标题「任务同步失败」，正文 `message`。
   - 其他类型 → 标题「Trellis Board 有新的同步事件」，正文 `{projectName}` 或任务空间 ID。
   - `projectName`/`branchName` 缺失时不拼该片段（兼容旧 payload）。
2. `publish_control` 去掉两处 `focus_main_window`，替换为 `self.notify_control(&control)`；触发条件不变（review 用 `changed`、其他类型用 `!became_front` 后的首次）。
3. 用户主动入口保持聚焦：`show_pending_control`（`agent_service.rs:384-396`，由 `live_control_show` 调用）不改。
4. `update.rs:133-141` 的 `on_action` 在 emit `update-open-dialog` 前加 `update_available` 判断，避免点同步通知误开更新对话框。
5. 点击通知回窗口：在 `main.rs` 的 setup 阶段无条件注册 `app.notification().on_action(...)`，只判 `action_id() == "tap"` → `focus_main_window(&app)`；不依赖更新模块是否启用（`update.rs` 只在配置了更新服务器时才注册自己的 handler，未配置时同步通知点了没反应）。
6. 同步通知三档设置：`appearance.rs` 的 `Appearance` 加 `notify_mode: String`（`#[serde(default)]`，常量 `NOTIFY_MODES = ["never","unfocused","always"]`，默认 `always`，`normalised()` 过滤非法值）；`notify_control` 开头按档位判定：`never` 直接 return，`unfocused` 且 `window_focused()` 时 return。`window_focused()` 用 `self.app.get_webview_window("main").and_then(|w| w.is_focused().ok())`，`Err`/`None` 视为未聚焦。Web 端 `appearance.js`/`appearance.d.ts`/`theme.tsx` 透传该字段，`PreferencesDialog.tsx` 用 `ToggleGroup`（与主题同一写法）渲染「从不 / 仅在未聚焦时 / 始终」。

## 兼容性与回滚（方案二、方案三）

- 纯进程内状态，不写盘；改名/重启后自动再提示一次。
- 协议只加可选字段 `projectName`/`branchName`，旧客户端忽略，旧服务端无影响。
- 回滚：移除 `DismissedReview` 与三处接线即恢复“每轮弹窗”的原行为；移除两个事件字段即恢复 UUID 展示；把 `notify_control` 换回 `focus_main_window` 即恢复抢焦点；`notifyMode` 为新增可选字段（`#[serde(default)]`，非法值归一为 `always`），旧 `appearance.json` 读出 `always`，删掉该字段即恢复“始终提示”。

## 数据流（合并）

```
sync tick (~60s) → pull_initial_sync → emit_differences
   → publish_control → hub.push_with_change
        ├─ 与已稍后处理签名相同 → 丢弃（不 notify、不发系统通知）
        └─ 否则入队 → emit live-control-changed → 发系统通知（不抢焦点）→ web 轮询 → 弹窗
用户点「稍后处理」→ live_control_dismiss → pop + 记签名/副本
用户点「查看任务差异」→ live_control_show → reveal_dismissed → notify → 弹窗
用户完成首同步 → live_control_initial → clear_control → 清签名
```

## 兼容性与回滚（方案一）

- 不改协议、不改 taskSpace 快照字段、不改服务端接口：旧服务端 + 新客户端可用，新服务端 + 旧客户端行为不变。
- 回滚方式：移除新 helper 调用即可恢复原行为；已写入的 `readonly_task_dirs` 可用「重新接入/重置 cursor」清理。
- 已有绑定若曾误标：只会影响上传范围，不影响远端数据；验证时同时覆盖“新接入”和“已有 cursor”两种起点。

## 验证策略

- 单测（Rust）：用现有 `task_sync/tests` 的 HTTP 假服务模式，构造 403/409/404 三种 `/files` 响应，断言 `readonly_task_dirs`、`differences`、`pendingReview` 三个输出；另断言 emit 的 `initial_sync_review` 事件带 `projectName`/`branchName`。
- 前端：`yarn workspace @trellis-board/web build`（tsc -b 覆盖新增字段）+ `yarn workspace @trellis-board/web lint`；手动打开弹窗确认项目名与分支在紧凑态/展开态都可见。
- 现场回归：本机 flyfly6 绑定重跑首同步，检查 `agent/live-cursors.json`、`agent/config.json` 的 `initialSyncCompleted`/`lastSyncedAt` 与 UI 不再弹窗。
