# 规格摘录（便于注入，原文见对应 spec）

> 来源：`.trellis/spec/desktop/tauri-commands/index.md`、`.trellis/spec/frontend/rendering-and-state.md`。
> 原文均超过 context_injection 的 32 KiB 上限，本文件只摘录与本任务相关的硬约束。

## 1. `desktop-state-changed` 与关联刷新

- payload：`{ topics: ["associations", "sidecar"] }`。
- 事件只是失效通知；ProjectRail 收到后仍调用 `list_local_associations`，不得把事件 payload 当业务状态。
- 前端必须先注册监听，再执行首次读取；页面可见时保留 10 秒兜底轮询，隐藏时停止。
- Rust 只在 cursor、binding、ownership、Git 投影、sidecar 或控制队列实际变化后发射。
- 请求在途时只保留一次后续刷新；相同归一化结果必须复用原引用。
- 本任务不新增 IPC 命令，因此不涉及 `permissions/desktop.toml` 与 capability 变更。

## 2. 日志规范（tauri-commands:462）

- 日志只记录真实动作或异常，禁止在每轮同步/心跳里按“状态”重复打印。
- 状态未变化时静默；真实迁移或释放动作记 `info`，失败记 `warn`。
- 本任务收敛后，同一失效目录不得再产生“上传未产生提交”告警；收敛轮最多保留 1 条。

## 3. 项目行状态与优先级（rendering-and-state:63-82）

- Tauri 项目行必须常驻展示关联状态：未关联、关联中、等待后台同步、正在同步已有任务、等待确认任务差异、同步正常、只读已关联或关联失效。
- `liveSyncStatus=error` 时显示同步异常，并通过可见辅助文本或 `title` 展示脱敏后的 `liveSyncError`。
- `initialReviewPending=true` 显示“已关联 · 等待确认任务差异”，其聚合优先级介于 `error` 与 `syncing` 之间。
- `liveSyncStatus=ready` 且 `deferredCount>0` 必须显示“N 个本地任务未同步”，不能显示同步正常。
- 父行状态只读取该项目自身 `taskSpaces`；未展开时按“关联失效、error、syncing、deferred、pending、ready”聚合。
- 多分支项目中，`BRANCH_MISMATCH` / `BINDING_BRANCH_MISMATCH` 只在对应分支行显示“已暂停”，不得投影为整个项目暂停。

## 4. 本任务新增的状态

- `pendingUploadCount>0` 且 `pendingUploadRetrying=false` → “已关联 · 正在上传 N 个任务”（primary + 脉冲，不占 warning）。
- `pendingUploadCount>0` 且 `pendingUploadRetrying=true` → “已关联 · N 个任务等待重试上传”（warning）。
- 两者在聚合优先级中仍属 pending 档，位于 deferred 之后、ready 之前。
- 实施后需同步更新 `rendering-and-state.md` 的项目行状态清单。
