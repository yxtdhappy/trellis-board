# 桌面客户端账号密码直连登录实施计划

## 实施前置

- [ ] `11-08-support-multi-team-board` 完成最终验证和提交。
- [ ] 在该任务基础上确认 `/api/auth/login`、`/api/desktop/enroll-tokens`、`/api/agent/enroll-desktop` 的多团队契约稳定。
- [ ] 记录 `git status`，只修改本任务文件；保留其他未提交设计文件和用户改动。

未满足前置条件时，不开始产品代码修改。

## 1. 新客户端配置

- [ ] `desktop/src-tauri/src/config.rs` 升级 `client.json` 到 schema 2，只保存 `serverUrl`。
- [ ] 旧 schema 读取为“无兼容配置”，不再阻止本地登录页启动。
- [ ] `app_status` 返回可预填的上次服务器地址和 sidecar 状态，不再返回团队列表。
- [ ] 保存继续使用临时文件 + rename；验证文件不含用户名、密码、Cookie 或设备凭据。

验证：

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml config
```

## 2. sidecar 登录与设备兑换

- [ ] 扩展 `desktop/sidecar/desktop-device.js` 的 HTTP helper，使其保留响应头以读取 Set-Cookie。
- [ ] 实现账号密码登录：固定 POST `/api/auth/login`，发 `Origin`，不跟随跳转。
- [ ] 严格解析 `trellis_team_session`，拒绝缺失、重复或格式错误的 Cookie。
- [ ] `mustChangePassword=true` 时返回仅可访问改密和退出接口的会话，不创建设备。
- [ ] 可复用设备先 heartbeat；认证失败后才重新兑换。
- [ ] 新建设备复用已有 `/api/desktop/enroll-tokens -> /api/agent/enroll-desktop` 调用链。
- [ ] 设备兑换失败时调用 `/api/auth/logout` 撤销刚生成的 Session。
- [ ] 账号变化或 `--force-new` 时，在新设备兑换成功后清理事件游标、事件缓存和运行状态。
- [ ] 在 `desktop/sidecar/main.js` 新增 `login` 命令；用户名和密码作为一个 JSON 对象从 stdin 读取。
- [ ] 删除桌面 sidecar 的 `workspace-init`、令牌 enroll 和配对码命令入口。
- [ ] DPAPI 保存和无明文日志路径复用现有实现，不另写凭据存储。

验证：

```powershell
node --test tests/desktop-device-auth.test.js tests/desktop-package.test.js agent/test/api.test.js agent/test/protocol.test.js
```

## 3. Tauri 登录命令

- [ ] 删除令牌、配对码、浏览器登录和 workspace 相关 Tauri 命令。
- [ ] 删除通用 dialog capability；目录选择器只由项目关联 Rust 命令内部调用。
- [ ] 新增 `desktop_login`，校验本地调用者、Board URL、用户名和密码。
- [ ] 通过 sidecar stdin 传凭据，不拼入命令行或日志。
- [ ] 解析 sidecar 结果并拒绝不完整或格式错误的数据。
- [ ] 登录成功后保存新客户端配置。
- [ ] 用 Tauri WebView Cookie API 写入 HttpOnly Session Cookie。
- [ ] Cookie 失败时调用 sidecar logout 并返回错误。
- [ ] 登录成功且 `deviceReady=true` 时启动 sidecar。

验证：

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

## 4. 动态导航与退出

- [ ] 引入共享 Board origin 状态，替换窗口创建时固定的 `Option<Url>`。
- [ ] 冷启动始终加载本地 `index.html`，不根据历史配置直接打开 Board。
- [ ] 登录成功先更新 Board origin，再在同一 WebView 内导航到 Board。
- [ ] 拦截同源 `/login.html`：停止 sidecar、删除 Cookie、清空 Board origin、返回本地登录页。
- [ ] 删除 `trellisboard://enroll` 深链处理。
- [ ] 外链仍只交给系统浏览器；远程 Board 只获得项目关联的两个窄权限命令。

验证：

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml navigation
```

## 4A. Board 项目栏本地关联

- [ ] 新增 `associate_local_project` 和 `list_local_associations` Tauri 命令。
- [ ] 两个命令都校验当前 WebView origin 等于动态 Board origin。
- [ ] 新增 `board-local-association` 远程 capability，仅包含这两个命令。
- [ ] `ProjectRail` 仅在 Tauri 环境显示本地关联入口，浏览器中隐藏。
- [ ] 点击项目关联入口后打开系统目录选择器，并调用 sidecar `associate`。
- [ ] 复用 `inspectRepository()` 校验 Git 根目录、`.trellis`、当前分支和远端身份。
- [ ] sidecar 写入本地绑定后立即触发一次 heartbeat。
- [ ] 服务端把 active team member 的有效绑定直接设为 approved，不再进入 pending。
- [ ] 显式 `project_member.role=read_only` 的成员建立只读绑定，禁止上传本地修改。
- [ ] 项目栏展示未关联、已关联、只读和失效状态。
- [ ] Board 浏览器页面不能调用本地关联命令，其他远程 origin 也会被 Rust 拒绝。

验证：

```powershell
node --test tests/team-core.test.js tests/team-isolation.test.js tests/desktop-package.test.js
cargo test --manifest-path desktop/src-tauri/Cargo.toml
npm --prefix web run build
```

## 5. 登录页

- [ ] 重写 `desktop/ui/index.html`，只保留服务器地址、登录名、密码、提交按钮和错误区。
- [ ] 重写 `desktop/ui/setup.js`，调用 `desktop_login`，提交中禁用表单，失败后清空密码并聚焦。
- [ ] 服务器地址由 `app_status` 预填；不保存登录名和密码。
- [ ] 删除 workspace 面板、令牌事件监听、配对码和 `window.location.replace(boardUrl)`。
- [ ] 清理 `desktop/ui/styles.css` 中不再使用的 workspace、fallback 和 secondary 样式。
- [ ] 保持键盘提交、标签关联、错误 `role=alert` 和深色模式可用。

验证：

- 用 Chrome DevTools 直接打开本地静态页，注入最小 Tauri mock，检查空值、提交中、错误和成功路径。
- 深色模式及 960×640 最小窗口不得出现横向滚动。

## 6. 删除 workspace 与旧入口

- [ ] 删除 `desktop/sidecar/workspace-init.js` 及其测试。
- [ ] 删除 `desktop/src-tauri/capabilities/main.json` 中 workspace、通用 dialog 和旧注册权限。
- [ ] 保留项目关联命令内部使用的 dialog 插件依赖，但不开放 `dialog:allow-open`。
- [ ] 从安装器移除 `trellisboard://` 注册；卸载器可保留旧协议清理。
- [ ] 更新 `desktop/README.md` 的流程、配置、安全边界、验证矩阵和故障说明。
- [ ] 全仓搜索旧命令、旧深链、设备令牌和 workspace 初始化引用，删除仅属于桌面端的残留。

验证：

```powershell
rg -n "enroll_with_token|enroll_device|open_board_login|pick_workspace|init_workspace|workspace-init|trellisboard://enroll|设备令牌|配对码" desktop tests
```

允许保留的匹配必须属于服务端管理能力、卸载清理或明确标注的非桌面路径。

## 7. 测试补充

- [ ] sidecar：正确密码可取得 Session 并保存设备凭据。
- [ ] sidecar：错误密码不写配置、不保存 Cookie。
- [ ] sidecar：同一账号二次登录复用设备，不增加新设备。
- [ ] sidecar：不同账号登录替换本地设备身份。
- [ ] sidecar：不同账号登录不继承旧账号事件游标、事件快照和运行状态。
- [ ] sidecar：旧客户端配置在首次新登录时不被复用。
- [ ] sidecar：设备兑换失败会撤销 Session。
- [ ] sidecar：密码、Session Token、设备凭据不出现在配置文件、stdout 诊断和日志里。
- [ ] Tauri：schema 1 配置被忽略，schema 2 配置可预填服务器地址。
- [ ] Tauri：动态导航只允许登录成功的 Board origin。
- [ ] Tauri：登录页目录选择、workspace 和旧注册命令不可调用。
- [ ] 服务端集成：多团队账号登录后无需团队参数即可取得设备凭据。
- [ ] 服务端集成：active team member 的 Git 身份校验通过后绑定直接 approved。
- [ ] 服务端集成：远端不匹配和分支不匹配仍拒绝绑定。
- [ ] 服务端集成：`read_only` 成员绑定成功但不能上传任务变更。
- [ ] 前端：普通浏览器不显示本地关联入口，桌面 Board 显示项目关联状态。

## 8. 最终验证

全部代码完成后只执行一次构建：

```powershell
npm test
npm run build
node desktop/sidecar/build-sidecar.ps1
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo tauri build
```

Windows 真实 E2E：

1. 全新安装，双击后只显示本地登录页。
2. 非法 URL、错误密码、断网和 TLS 失败均不进入 Board。
3. 正确登录后 `client.json`、webview 存储和日志无密码；`credential.dpapi` 存在且不是明文。
4. 当前窗口进入 Board，系统浏览器不弹出。
5. 多团队账号无需选择团队，默认看到全部授权团队。
6. Board 退出登录后返回本地登录页。
7. 关闭并重新冷启动仍先显示登录页。
8. 同一账号再次登录复用设备；不同账号登录后不复用旧凭据。
9. 在 Board 项目栏选择本地仓库，Git 远端和分支匹配后立即关联成功。
10. 在浏览器打开 Board 不显示本地关联入口。
11. `read_only` 项目显示只读并拒绝本地修改上传。
12. 安装包中不存在 workspace 初始化页、旧目录初始化或旧令牌深链入口。

