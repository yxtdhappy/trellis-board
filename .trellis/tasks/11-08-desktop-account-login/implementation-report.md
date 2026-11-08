# 桌面客户端账号密码直连登录实施报告

## 实施结果

- Windows 客户端冷启动固定进入本地登录页，只保留服务器地址、登录名和密码。
- sidecar 完成账号密码登录、HttpOnly Session Cookie 解析、同一账号设备复用和 DPAPI 设备凭据保存。
- Tauri 将 Session Cookie 写入当前 Board origin，并在同一 WebView 内导航；退出登录时停止 sidecar、
  删除 Cookie、撤销会话并返回本地登录页。
- 删除桌面设备令牌、配对码、浏览器登录、workspace 初始化和旧深链注册入口；Agent CLI workspace
  能力保持不变。
- 团队成员通过 Git 根目录、origin、同步分支和 `.trellis` 校验后直接进入 approved；项目级
  `read_only` 可以接收但不允许上传。
- Board 项目栏为团队成员合并可关联项目与服务端授权项目；关联候选集合不扩大任务读取权限。
- 远程 Board capability 只开放项目关联、本地关联列表和 sidecar 运行状态；Rust 二次校验当前
  Board origin。
- 修复 sidecar 停止后旧进程事件误重启、绑定失配后继续投递、普通团队成员只读投影、UTF-8 BOM
  配置读取和退出登录阻塞等边界问题。

## 验证

- 账号登录、设备复用、错误密码、首登改密、强制重建、Cookie、项目关联和只读权限相关测试通过。
- `npm --prefix web run lint`：通过，无 error；保留项目既有 warning。
- `npx --prefix web tsc -b web/tsconfig.json`：通过。
- `node --check`：sidecar、关联模块和登录页脚本通过。
- `npm run build`：通过。
- `desktop/sidecar/build-sidecar.ps1`：通过，生成的 x64 SEA sidecar 能输出协议 v2。
- `git diff --check`：通过。

## 未验证

- 本机没有 Rust、MSVC Build Tools 或 Windows SDK，未执行 Rust 单元测试、Tauri 和 NSIS 构建。
- 仍需在安装包中验证 Windows WebView2 Cookie 域、动态 origin、远程 IPC、真实登录/退出及
  sidecar 进程生命周期。
