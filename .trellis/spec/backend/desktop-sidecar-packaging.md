# 桌面 sidecar 与 SEA 打包

## 1. Scope / Trigger

- 修改 `agent/`、`desktop/sidecar/`、Node SEA bundle、DPAPI helper 路径或 Windows 桌面安装构建时必须阅读。
- SEA 是单个可执行文件，不保留源码模块目录；业务模块不得通过 `import.meta.url` 推断源码文件位置。
- 源码入口与 SEA 入口必须分离，运行时依赖由入口显式注入。

## 2. Signatures

```js
runSidecarMain(argv?: string[], options?: {
  fallbackDpapiScript?: string
}): Promise<number>

new DpapiCredentialStore(store, {
  scriptFile: string,      // 必需，非空
  powerShellPath?: string
})

runAgentProcess({
  credentialStore,         // 必需
  store,
  logger,
  signal
}): Promise<{ exitCode: number, error?: Error }>

loginDesktop({
  serverUrl,
  username,
  password,                // 只来自 stdin
  deviceName,
  credentialStore,
  forceNew
}): Promise<LoginResult>

associateDesktopProject({
  projectId,
  repoPath,
  branchName,
  credentialStore,
  inspectRepository
}): Promise<AssociationResult>

desktop_sidecar_status(): Promise<{
  running: boolean,
  paused: boolean
}>

AgentLiveSync.start(): Promise<void>
AgentLiveSync.pullProject(teamId, projectId): Promise<LiveFilesPayload|null>
decidePendingLiveChange({ store, credentialStore, pendingId, action }): Promise<Result>
restoreLiveBackup({ store, credentialStore, backupId }): Promise<Result>
```

- 源码入口：`desktop/sidecar/cli.js`
- SEA 入口：`desktop/sidecar/sea-entry.js`
- 业务库：`desktop/sidecar/main.js`
- Agent CLI 入口：`agent/cli.js`

## 3. Contracts

- `desktop/sidecar/cli.js` 可以使用 `fileURLToPath(import.meta.url)` 解析真实
  `agent/windows/dpapi.ps1`，并通过 `fallbackDpapiScript` 传入。
- `desktop/sidecar/sea-entry.js` 必须保持无路径推断，只调用 `runSidecarMain()`。
- `desktop/sidecar/main.js` 导入时不得启动命令、写文件或读取模块路径。
- SEA 内优先通过 `sea.getAsset("dpapi.ps1")` 提取 DPAPI helper；asset 缺失且没有源码回退路径时返回
  `CONFIG_INVALID`。
- `DpapiCredentialStore` 不得自行推导默认脚本路径；Agent CLI 和 sidecar 入口必须显式传入。
- esbuild 不得定义或替换 `import.meta.url`，不得使用 `file:///...` 伪模块 URL。
- 设备令牌继续只通过 stdin 传递，路径注入值不得来自用户请求或远端输入。
- 账号密码只通过 sidecar stdin 的 JSON 对象传入；Session Cookie、设备和设备凭证不落盘。
- 桌面登录服务地址支持 HTTP/HTTPS 根地址；HTTP 不提供传输加密，只适用于可信内网或测试环境。
- `desktop/sidecar/workspace-init.js` 不属于桌面产品路径；workspace 能力只保留给 Agent CLI。
- 本地项目关联复用 `agent/git-sync.js` 的 `inspectRepository()`，不另写 Git 身份校验。
- 本地关联 DTO 必须透传 `liveSyncStatus`（`pending|syncing|ready|error`）和
  `liveSyncError`；旧 sidecar 缺少字段时 Tauri/前端按 `pending + null` 兼容。
- `AgentTaskSnapshotSync.start()` / `_setBindings()` 恢复 approved binding 时必须保留各 binding 已持久化
  的 `liveSyncStatus`，不得在启动时统一改写为 `syncing`；同时仍要为每个 binding 触发后台
  `pullTaskSpace` 增量追赶。
- Tauri 关联命令在服务端批准并持久化本地 binding 后重启一次 sidecar，触发首次 full pull；
  用户取消目录选择时返回空结果且不得重启或显示失败。
- 新绑定的 immediate heartbeat 直接使用服务端结果；绝不把 pending 状态当作桌面审批流程。
- 已存在的绑定再次心跳时，分支或远端身份校验失败必须转为 `rejected` 并停止命令投递；
  修正本地分支或远端后的合法心跳可恢复为 `approved`。
- `readOnly` 按实际任务写能力投影：项目 `lead`/`member`，以及没有显式项目角色的系统管理员
  为可写；显式 `read_only`，或普通团队成员/团队管理员仅靠团队身份建立关联时必须返回 `true`。
- “可关联项目”与“可读取任务项目”是两个集合。`/api/team/status` 的 `associationProjects`
  允许 active team member 看到团队内全部 active 项目；`projects` 仍只包含当前账号能读取任务的
  项目。不得为了填充关联下拉而放宽 `/api/team/projects` 或任务查询权限。
- 远程 Board 只额外开放只读 `desktop_sidecar_status`；项目栏用它显示后台同步“运行中 / 已暂停 /
  未运行”，不能把 Board 自身刷新状态误当成 sidecar 状态。
- 远程 capability 的 URL pattern 必须显式通配端口，使用 `http://*:*` 和 `https://*:*`；
  `http://*` 只匹配默认 80 端口，会拒绝局域网地址加自定义端口的 Board origin。
- sidecar `run` 的标准输出可发送单行 `{"control":{"type":"...", ...}}` 控制事件；Tauri 只接受
  顶层 `control` 对象且该对象必须有非空字符串 `type`，随后打开本地 `live-control` 窗口。
  不得再输出顶层 `{"type":"trellis-control", ...}`。控制事件只携带展示和操作所需摘要，
  不得包含文件正文、密码、Cookie 或设备凭证；`initial_sync_review` 的 `differences`
  只传 `type/taskId/taskDir/local/server` 元数据。
- `live-decide` 与 `live-restore` 使用独立 sidecar 命令，不依赖运行进程内存；待确认批次和备份
  manifest 必须原子落盘。完成本地写回后写入短时摘要抑制文件，防止 watcher 把刚应用的版本再次上传。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `DpapiCredentialStore` 缺少 `scriptFile` | 抛 `TypeError` |
| 源码 sidecar 缺少真实 DPAPI helper | `DPAPI_FAILED` |
| SEA 缺少 `dpapi.ps1` asset 且无回退路径 | `CONFIG_INVALID` |
| `runAgentProcess` 缺少 credential store | `CONFIG_INVALID` |
| sidecar 未注册设备执行 `status/associations` | `CONFIG_MISSING`，退出码 3 |
| sidecar 未注册设备执行 `login` | 登录成功后创建新设备，不依赖旧配置 |
| sidecar `login` 未从 stdin 收到单个 JSON 对象 | `CONFIG_INVALID` |
| `associate` 的 Git 分支、origin、远端或 `.trellis` 校验失败 | 不写绑定，返回对应 Git 错误 |
| 服务端拒绝关联 | sidecar 删除刚写入的本地绑定并返回 `REMOTE_MISMATCH` 等服务端错误 |
| 普通团队成员无 `project_member` | 可出现在 `associationProjects`，但不出现在可读 `projects` |
| Board 远程页面调用 `desktop_sidecar_status` | Rust 复核 Origin 后仅返回布尔运行状态 |
| sidecar 控制事件 | Tauri 只复用本地 `live-control` 窗口，不授予远程 Board 控制命令 |
| 实时同步账号切换 | 清理 live cursor、pending、suppression 和 backup，不跨账号继承 |
| SEA 顶层启动成功执行 `version` | 输出协议版本并以 0 退出 |

## 5. Good / Base / Bad Cases

- Good：源码 CLI 传入真实 DPAPI 路径；SEA 入口从 asset 提取脚本。
- Base：只执行 `version` 或 `status`，不读取 DPAPI 脚本时也应正常启动。
- Bad：bundled 模块仍调用 `fileURLToPath(import.meta.url)`；Windows 会因伪 URL 无盘符而崩溃。

## 6. Tests Required

- `agent/test/windows-dpapi.test.js`：缺少 `scriptFile` 必须失败；DPAPI 加解密不写明文。
- `tests/desktop-package.test.js`：SEA 入口不得包含 `import.meta`；bundle 不得包含伪模块 URL；源码 CLI
  `version/status` 正常。
- `tests/desktop-device-auth.test.js`：设备注册必须注入 credential store。
- `tests/desktop-device-auth.test.js`：账号密码登录、Cookie 严格解析、同账号设备复用和退出登录。
- `tests/desktop-association.test.js`：本地关联保存服务端 approved/readOnly 状态。
- `tests/desktop-association.test.js`：关联结果和本地列表透传实时同步状态字段。
- `tests/desktop-association.test.js`：服务端拒绝关联时回滚本地绑定。
- `tests/team-isolation.test.js`：只读成员关联后任务写操作被拒绝，Git 身份失配会转为 rejected。
- `tests/team-isolation.test.js`：普通团队成员能看到关联候选项目，但任务项目列表仍为空。
- `tests/desktop-package.test.js`：远程 capability 只允许关联命令、关联列表和 sidecar 状态；
  Rust DTO 对旧 sidecar 缺省字段保持兼容，关联成功后只重启既有 sidecar。
- `agent/test/task-snapshot-sync.test.js` + Rust `sidecar` 单测：只接受带非空 `type` 的
  `{"control": event}`；旧顶层 `trellis-control`、普通 stdout JSON、`control:null` 和
  无 `type` 对象不得进入控制窗口；审查事件不得包含任务正文。
- `agent/test/task-snapshot-sync.test.js`：启动恢复多个 approved binding 时保持各自
  `liveSyncStatus`，并断言所有 binding 仍触发后台 `pullTaskSpace`。
- Windows CI：构建后执行 sidecar `version`，断言退出码 0 和 `protocolVersion === 2`。
- Windows CI 必须在 `tauri build` 前通过 GitHub CLI/API 填充 `%LOCALAPPDATA%\tauri\NSIS`，校验
  NSIS zip 与 `nsis_tauri_utils.dll` 的固定 SHA1；Tauri 使用的 GitHub Releases 直链可能返回 504。
- 最终安装包必须重新生成，旧 sidecar 不会被仓库代码自动替换。Web Board 修复后，已运行的 Tauri
  客户端也可能继续持有旧 WebView bundle；必须重建客户端或重新登录/重启完成复核，不能只以服务端
  静态资源已更新判定桌面修复生效。

## 7. Wrong vs Correct

### Wrong

```js
// bundle.mjs
define: {
  "import.meta.url": "__trellisBundleUrl"
}
banner: {
  js: 'const __trellisBundleUrl = "file:///trellis-sidecar/trellis-agent-bundle.cjs"'
}
```

Windows 的 `fileURLToPath()` 无法解析没有盘符的伪路径，sidecar 会在设备注册前退出。

### Correct

```js
// desktop/sidecar/cli.js
const dpapiScript = path.join(HERE, "..", "..", "agent", "windows", "dpapi.ps1");
await runSidecarMain(process.argv.slice(2), { fallbackDpapiScript: dpapiScript });
```

```js
// desktop/sidecar/sea-entry.js
import { runSidecarMain } from "./main.js";
process.exitCode = await runSidecarMain();
```

SEA 入口不推断模块路径；DPAPI 脚本通过 `node:sea` asset 提供。

### Wrong

```json
{"type":"trellis-control","type":"initial_sync_review","taskSpaceId":"space-1"}
```

重复 `type` 且没有顶层 `control`，Tauri 会把事件当普通日志，确认窗口不会出现。

### Correct

```json
{"control":{"type":"initial_sync_review","taskSpaceId":"space-1","revision":4,"differences":[]}}
```

### Wrong

```js
this.bindings = new Map(
  bindings.map((binding) => [binding.taskSpaceId, { ...binding, liveSyncStatus: "syncing" }]),
)
```

启动或新增项目触发 sidecar 重启时，把所有 binding 统一标成 `syncing`，会让无关项目一起显示同步中。

### Correct

```js
this.bindings = new Map(
  bindings.map((binding) => [binding.taskSpaceId, binding]),
)
for (const taskSpaceId of this.bindings.keys()) void this.pullTaskSpace(taskSpaceId)
```

保留每个 binding 已持久化的 `liveSyncStatus`，后台拉取只推进该 taskSpace 的数据和自身状态。
