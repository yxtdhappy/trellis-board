# 首次项目关联自动同步与状态反馈实施计划

## 前置检查

- [ ] 记录 `git status --short --branch`，只修改本任务相关文件。
- [ ] 保留现有用户改动：`design/trellis-board-redesign.pen`、`web/src/hooks/useBoard.ts`、`data/projects/`、`design/exports/` 和无关任务文件。
- [ ] 确认当前分支为 `codex/team-board`，目标分支为 `team-board`。
- [ ] 实施前不执行构建，只在全部开发完成后构建一次。

## 1. Binding 状态字段

- [ ] 在 `agent/config-store.js` 为 binding 增加 optional：
  - `liveSyncStatus: pending | syncing | ready | error`
  - `liveSyncError: string | null`
- [ ] 缺省值归一化为 `pending + null`，保持 `schemaVersion=1`。
- [ ] `desktop/sidecar/desktop-association.js` 创建绑定和批准结果写入 `liveSyncStatus=pending`。
- [ ] `desktop/sidecar/desktop-device.js` 的 `readLocalAssociations()` 返回两个状态字段。
- [ ] Agent CLI `status` 输出同样字段，便于诊断。
- [ ] `agent/index.js` 的 heartbeat binding 更新不得覆盖这两个字段。

验证：

```powershell
node --test tests/desktop-association.test.js agent/test/runtime-cli.test.js
```

## 2. Agent 首次初始化

- [ ] `AgentLiveSync` 分别维护全部 approved binding 和可上传 binding。
- [ ] 新增 approved 绑定由绑定签名去重后触发初始化。
- [ ] sidecar 每次启动会初始化现有 approved 绑定，以补传离线变化。
- [ ] `pullProject()` 支持 `{ full: true }`，初始化时从 revision `0` 拉取。
- [ ] 初始化先完成服务端 full pull，再处理本地补传。
- [ ] 用 `git diff --name-only -z HEAD -- .trellis` 和
  `git ls-files --others --exclude-standard -z -- .trellis` 发现本地脏路径。
- [ ] 单独加入被 `.trellis/.gitignore` 忽略但已存在的 `.trellis/.developer`，再按远端摘要决定是否上传。
- [ ] 复用 `isLivePath()`、`_fileDescriptor()`、`splitLiveBatches()` 和 `_submitOrWait()`，
  不复制路径过滤、摘要或上传协议。
- [ ] 与服务端刚拉取的文件摘要一致时跳过；服务端缺失的本地新增、修改和删除变化进入补传。
- [ ] 初始化期间到达的 watcher 事件等待初始化结束，避免先于 full pull 上传。
- [ ] `read_only` 只 full pull 和落盘，不扫描/上传本地修改。
- [ ] 初始化开始写 `syncing`，成功写 `ready`，失败写 `error`。
- [ ] 后续实时批次遇到网络/服务错误时也写 `error`；pending 队列重试成功后写回 `ready`。
- [ ] 项目栏在 error 状态显示“同步异常，等待重试”，不能继续显示同步正常。
- [ ] 5 秒重试循环重新执行 error 绑定；同一绑定的重试不得并发。
- [ ] 冲突继续由 `_applyRemoteFiles()` 备份、覆盖并发送 `remote_overwrite`。
- [ ] assignment warning 控制事件增加 `expiresAtEpochMs`，Tauri `pending_control` 每次读取前剔除过期事件。
- [ ] `live_control_decide` 成功、过期或 pending 文件已不存在时清空当前控制事件，避免重复弹出。

验证：

```powershell
node --test tests/desktop-realtime-apply.test.js tests/team-realtime-sync.test.js
```

## 3. 桌面 DTO

- [ ] `desktop/src-tauri/src/sidecar.rs` 的 `LocalAssociation` 增加
  `liveSyncStatus`、`liveSyncError`。
- [ ] `AssociationSummary` 可选解析两个字段；关联命令返回 `pending` 默认值。
- [ ] `list_local_associations` 原样透传 sidecar 状态。
- [ ] 不新增 Tauri command、capability 或远程权限。

验证：

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml
node --test tests/desktop-package.test.js
```

## 4. ProjectRail 反馈

- [ ] 引入 `sonner` toast，并在点击关联后立即显示 loading。
- [ ] loading 期间禁用关联操作，避免同项目或其他项目并发重复关联。
- [ ] 目录选择取消时 dismiss loading，不显示失败。
- [ ] 成功 toast 提示已关联并正在同步已有任务。
- [ ] 失败 toast 展示 sidecar/Tauri 的明确中文错误，同时保留项目栏错误文本。
- [ ] 项目行常驻显示：
  - 未关联
  - 关联中
  - 等待后台同步
  - 正在同步已有任务
  - 同步正常
  - 首次同步失败
  - 只读已关联
  - 关联失效
- [ ] 同步失败文案的 `title` 或可见辅助文本展示脱敏错误。
- [ ] 控制窗口动作提交中显示“正在提交，请稍候…”，失败后恢复按钮。
- [ ] 保持 3 秒关联状态轮询、普通浏览器隐藏入口和暗色模式 token。

验证：

- 使用现有 Chrome DevTools 会话打开普通浏览器 Board，确认无 Tauri 入口回归。
- 桌面 WebView 分别验证未关联、关联中、成功、失败、只读和同步异常状态。

```powershell
npm --prefix web run build
```

构建只在全部代码修改完成后执行。

## 5. 自动化测试补充

- [ ] `tests/desktop-realtime-apply.test.js` 新增临时 Git 仓库夹具。
- [ ] 关联前新建的未跟踪任务在初始化后上传。
- [ ] 关联前修改和删除的已跟踪文件在初始化后上传。
- [ ] 未变化文件不上传。
- [ ] 服务端已有相同摘要时不重复上传。
- [ ] 同路径内容冲突时服务端优先、生成备份、发出 `remote_overwrite`，本地旧内容不上传。
- [ ] `read_only` 初始化只拉取，不产生 preflight/upload。
- [ ] sidecar 二次启动对已同步内容保持幂等。
- [ ] 初始化失败写 `error`，后续成功重试写 `ready`。
- [ ] 服务不可达时写 `error`，恢复后 pending 批次成功上传并写回 `ready`。
- [ ] assignment warning 过期和 pending 文件消失后不会重复弹出。
- [ ] 责任人确认动作成功、失败和超时都会恢复可操作状态。
- [ ] 现有实时同步、关联和心跳测试按新初始化行为调整，并明确建立 Git 基线。

验证：

```powershell
node --test tests/desktop-realtime-apply.test.js tests/desktop-association.test.js tests/desktop-package.test.js tests/team-realtime-sync.test.js agent/test/runtime-cli.test.js
```

## 6. 规范更新

- [ ] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`：
  - 首次绑定初始化顺序
  - Git 脏路径发现
  - full pull 与服务端优先冲突
  - binding live sync 状态
- [ ] 更新 `.trellis/spec/backend/desktop-sidecar-packaging.md`：
  - association DTO 新字段
  - 初始化失败重试和 SEA/Tauri 同步发布要求
- [ ] 更新 `.trellis/spec/frontend/rendering-and-state.md`：
  - ProjectRail 关联 loading、toast 和常驻状态文案。
- [ ] 不修改服务端 schema、API 或 `SCAN_SCHEMA_VERSION`。

## 7. 最终验证

全部开发完成后只执行一次完整验证：

```powershell
npm test
npm run build
node desktop/sidecar/build-sidecar.ps1
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo tauri build
```

真实 Windows E2E：

1. 在项目未关联时创建本地任务。
2. 点击关联，确认项目行立即显示关联中，按钮被禁用。
3. 绑定批准后显示“正在同步已有任务”，最终变为“同步正常”。
4. 3 秒内服务端 `project_live_revision` 增加，任务出现在看板且标为实时未入 Git。
5. 构造同路径本地/服务端冲突，确认先产生本地备份，服务端版本覆盖本地并弹出冲突窗口。
6. 点击“一键复原”，确认形成更高 revision 并广播。
7. 取消目录选择，确认只结束 loading，无错误 toast。
8. 模拟 Git/远端不匹配，确认失败 toast 和项目栏错误。
9. 重启 sidecar，确认已同步内容不产生重复 revision。
10. `read_only` 成员关联后只接收服务端内容，本地修改不上传。

## 回滚点

- 配置字段：删除 optional 字段读写，旧配置兼容。
- 初始化调度：停止新绑定初始化，保留现有 watcher。
- UI：恢复当前项目名/图标展示，不影响绑定数据。
- 无需回滚服务端数据库。
