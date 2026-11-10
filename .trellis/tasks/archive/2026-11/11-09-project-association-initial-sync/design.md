# 首次项目关联自动同步与状态反馈技术设计

## 1. 目标与边界

首次产生有效项目绑定时，sidecar 先拉取服务端最新实时覆盖层，再识别本地相对 Git 基线或服务端实时内容尚未收敛的 `.trellis` 变化并上传。冲突按已确认的服务端优先策略处理：本地文件先备份，再由服务端内容覆盖，并复用现有 `remote_overwrite` 控制窗口提供一键复原。

本次不新增服务端 API 或数据库表：

- 全量拉取复用 `GET /api/agent/live-files?afterRevision=0`。
- 本地变化上报复用 `POST /api/agent/live-changes/preflight` 和 `POST /api/agent/live-changes`。
- 冲突备份、写回和复原复用现有 `_applyRemoteFiles()`、`remote_overwrite` 和 `restoreLiveBackup()`。

## 2. 触发边界

[AgentLiveSync.updateBindings()](../../../agent/live-sync.js:264) 当前只把 approved、可写绑定放进 watcher，既不在新绑定生效时补扫，也无法区分本次进程刚新增的绑定。

调整后：

1. 分别保存全部 approved 绑定和可上传绑定。
2. 以 `projectId + localRepoKey + repoPath + serverBindingId` 作为绑定签名。
3. 新的 approved 绑定只触发一次初始化；watcher 仍只包含非只读绑定。
4. sidecar 每次启动都会重新初始化现有 approved 绑定，用于补传离线期间产生的本地变化。
5. 绑定撤销、路径或仓库身份变化时，旧签名失效并清理对应内存状态。

## 3. 初始化数据流

```text
approved binding
  -> liveSyncStatus=syncing
  -> GET live-files(afterRevision=0)
  -> 逐文件比较本地内容
       -> 不同：备份本地后应用服务端版本，发出 remote_overwrite
       -> 相同：只推进 cursor
  -> git diff HEAD + git ls-files --others 得到本地脏路径
  -> 读取允许的文本文件或删除状态
  -> 与刚拉取的服务端摘要比较
       -> 已一致：跳过
       -> 仅本地存在：复用现有批次上报
  -> liveSyncStatus=ready
```

初始化拉取必须发生在本地补传之前，保证冲突不会由旧本地内容覆盖服务端版本。

## 4. 本地变化发现

不以整仓遍历作为基线来源，避免把大量未变化文件送入实时覆盖层。

使用两条 Git 查询合并待检查路径：

```text
git diff --name-only -z HEAD -- .trellis
git ls-files --others --exclude-standard -z -- .trellis
```

处理规则：

- 结果去重并统一为 `.trellis/...` POSIX 路径。
- `.trellis/.developer` 被仓库自身 `.gitignore` 忽略，必须单独检查文件是否存在并加入候选；其摘要与远端一致时跳过。
- 复用 `isLivePath()`，只保留 `.developer`、`tasks/**`、`workspace/**` 和白名单扩展名。
- 复用 `_fileDescriptor()` 读取 upsert/delete、计算摘要并应用现有自触发抑制。
- 删除文件由 `_fileDescriptor()` 生成 delete 描述，不直接信任 Git 输出中的状态字母。
- Git 命令失败、输出超限、路径读取失败或文件超过现有上限时，初始化进入 error 状态，不静默标记成功。

## 5. 服务端优先冲突

初始化使用 full pull：`pullProject(teamId, projectId, { full: true })` 从 revision `0` 获取每个路径的最新值。

本地与服务端同路径内容不同时，继续使用 [_applyRemoteFiles()](../../../agent/live-sync.js:713)：

1. 在 Agent 数据目录生成备份 manifest 和原文件。
2. 原子写入服务端版本或执行删除。
3. 写入摘要抑制，避免 watcher 回传服务端内容。
4. 发出 `remote_overwrite` 控制事件。

随后补传阶段再次比较本地摘要与服务端摘要；已被覆盖的文件视为一致并跳过。用户可在现有 [control.js](../../../desktop/ui/control.js:75) 的“一键复原”入口把本地备份作为新版本重新上传。

## 6. 重复与乱序防护

- 新增绑定只调度一次初始化。
- sidecar 重启后的初始化会先 full pull，再比较摘要；已同步内容不会重复上传。
- `_fileDescriptor()` 继续使用 `(absolutePath, sha256)` 抑制刚应用的远端写入。
- 所有本地补传仍经过 `_enqueueProject()` 串行队列、`splitLiveBatches()`、preflight 和服务端 `clientSequence` 校验。
- 初始化期间到达的 watcher 事件等待当前初始化结束后再处理，避免事件抢在服务端优先拉取之前上传。
- 同一项目从 error 状态自动重试时，已有初始化任务不得并发重复启动。

## 7. 绑定同步状态

在 Agent binding 中增加两个可选字段，保持 `schemaVersion=1` 兼容：

```json
{
  "liveSyncStatus": "pending | syncing | ready | error",
  "liveSyncError": "string | null"
}
```

- 旧配置缺少字段时归一化为 `pending + null`。
- [associateDesktopProject()](../../../desktop/sidecar/desktop-association.js:41) 创建绑定后写 `pending`。
- profile 启动或新绑定生效时写 `syncing`。
- full pull 和本地补传成功完成后写 `ready`。
- 任一初始化步骤或后续实时批次上传失败时写 `error`，保存脱敏后的中文错误；成功冲刷 pending 批次后写回 `ready`。
- 5 秒重试循环重新初始化 error 绑定；成功后清除错误。
- heartbeat 更新 `syncStatus`、`readOnly` 和远端错误时不能覆盖 `liveSyncStatus/liveSyncError`。

状态通过现有 `list_local_associations` DTO 暴露给 ProjectRail，不扩展远程 Board 权限。

实时确认控制事件仍由 Tauri 内存队列保存。`assignment_warning` 除 ISO `expiresAt` 外增加
`expiresAtEpochMs`；`live_control_pending` 在每次 750ms 轮询时先剔除已到期事件。动作成功后由
`live_control_decide` 清理当前事件；动作失败时控制窗口恢复按钮，下一次轮询会根据过期或
pending 文件消失自动清空残留提示。

## 8. 项目栏反馈

[ProjectRail.tsx](../../../web/src/components/layout/ProjectRail.tsx:151) 保留现有组件边界，不新增全局状态库。

状态文案：

| 状态 | 文案 |
| --- | --- |
| 无绑定 | `未关联 · 关联本地仓库` |
| 点击后等待 Tauri/sidecar | `关联中 · 正在校验本地仓库` |
| approved + pending | `已关联 · 等待后台同步` |
| approved + syncing | `已关联 · 正在同步已有任务` |
| approved + ready | `已关联 · 同步正常` |
| approved + error | `已关联 · 同步异常，等待重试`，错误通过 title/详情文本展示 |
| readOnly | `只读已关联 · 不同步本地修改` |
| 非 approved | `关联失效 · <错误>` |

交互：

- 点击关联立即设置项目级 loading，禁用全部关联按钮防止并发。
- 使用现有 Sonner：
  - loading：`正在关联本地项目…`
  - 成功：`本地项目关联成功，已有任务正在同步。`
  - 失败：展示 Tauri/sidecar 返回的中文错误。
  - 取消目录选择：关闭 loading，不显示成功或失败。
- 已关联行使用成功态图标和常驻文案；未关联行始终显示关联提示，不能只靠 hover。
- 3 秒关联轮询继续负责把 pending/syncing 更新为 ready/error。
- ProjectRail 的关联状态来自 Tauri 本地命令，不依赖 Board API；即使 Board 服务不可达，也能在页面仍可操作时显示同步异常。

控制窗口：

- 点击任一责任人动作后，消息区显示“正在提交，请稍候…”，三个按钮保持禁用。
- 成功返回后清空事件；失败返回后恢复按钮并显示中文错误。
- 事件过期后由 Tauri 队列自动剔除，窗口隐藏；不能要求用户处理一个已经无效的决策。

## 9. 错误与兼容

- 普通浏览器没有 Tauri invoke，仍不显示关联入口和 sidecar 状态。
- `read_only` 只执行 full pull、落盘和状态更新，不进入补传队列。
- 新字段均为 optional，旧配置和旧 sidecar 响应继续可读；桌面安装包必须同时更新 Tauri 与 sidecar。
- 没有服务端 schema、查询契约或 watcher 过滤变化，`SCAN_SCHEMA_VERSION` 不调整。
- 初始化失败保留已有本地文件、备份、pending 上传批次和 live cursor，不执行清理。

## 10. 测试策略

- Agent 单元测试使用临时 Git 仓库，覆盖关联前新建、修改、删除、已一致内容、`read_only`、服务端优先冲突和重启幂等。
- 关联测试覆盖 `pending -> syncing -> ready/error` 字段持久化、列表 DTO 和 heartbeat 不覆盖字段。
- Tauri contract 测试覆盖新增 DTO 字段的 serde 命名和 capability 不变。
- 前端通过类型检查、生产构建和桌面 WebView 手动验收 loading、成功失败、五类项目状态。
- 最终执行一次完整 `npm test` 和相关构建；开发过程中不反复构建。

## 11. 回滚

回滚顺序：

1. 前端恢复为当前项目名/图标展示，并保留已写入的 optional 状态字段。
2. 停止新绑定初始化调度，保留 watcher 实时同步能力。
3. 删除 `liveSyncStatus/liveSyncError` 的写入；旧配置仍可被当前归一化逻辑读取。

不涉及数据库迁移，回滚不需要修改服务端数据。
