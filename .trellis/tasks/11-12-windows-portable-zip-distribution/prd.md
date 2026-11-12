# Windows 绿色 ZIP 分发

## Goal

为受 EXE 安装器限制的 Windows 环境提供无需安装、解压后即可运行的 Trellis Board 客户端 ZIP
分发包，同时保留现有 NSIS 渠道，避免影响已经使用安装包的客户。

## Background

- 当前 `desktop/src-tauri/tauri.conf.json` 只构建 NSIS 安装包，CI 也只上传主程序和 NSIS
  安装包。
- 客户端依赖同目录的 `trellis-agent.exe`、`trellis-runtime/` 以及系统中的 WebView2
  Runtime；NSIS 当前负责自动下载 WebView2。
- Microsoft 在 Windows 11 默认预装 Evergreen WebView2；符合条件的 Windows 10 设备通常也会
  安装，但微软不保证所有设备都存在，因此发布验收仍需覆盖目标公司镜像。
- Tauri 支持 `build --no-bundle`，可由项目脚本自行组装绿色目录并压缩为 ZIP。
- 当前桌面数据目录默认是 `%LOCALAPPDATA%\TrellisBoard\data`，也支持通过
  `TRELLIS_DESKTOP_HOME` 覆盖。

## Requirements

- R1：继续生成现有 NSIS 安装包，并额外生成 Windows x64 绿色 ZIP，两类产物来自同一次构建。
- R2：绿色 ZIP 不运行安装器、不要求管理员权限、不自动创建快捷方式或开机自启项。
- R3：ZIP 内容必须包含客户端主程序、sidecar、固定 Trellis runtime、版本文件和校验文件。
- R4：绿色目录应允许解压到包含空格或中文的普通用户可写目录后直接运行。
- R5：CI 必须能够校验绿色目录完整性和 ZIP 内关键文件，并上传 ZIP 作为独立构建产物。
- R6：绿色版只依赖目标电脑已安装的 Evergreen WebView2 Runtime，不随包携带 WebView2；
  文档必须明确该前置条件、升级方式和卸载/清理方式。
- R7：如果系统策略禁止运行应用自身的 EXE，绿色分发包不承担绕过该策略的责任。
- R8：绿色版只要求程序免安装；用户数据继续保存在
  `%LOCALAPPDATA%\TrellisBoard\data`，不新增 `TRELLIS_DESKTOP_HOME` 启动器。

## Acceptance Criteria

- [ ] Windows CI 同一次构建产出 NSIS 安装包和带版本号的 Windows x64 绿色 ZIP。
- [ ] ZIP 解压后至少包含 `trellis-board-client.exe`、`trellis-agent.exe`、
  `trellis-runtime/node.exe`、`VERSION.txt` 和 `SHA256SUMS.txt`。
- [ ] 解压到包含空格或中文的目录后双击主程序，无需管理员权限即可进入登录页。
- [ ] 完成登录后 sidecar 能启动；接入缺少 Trellis 的 Git 项目时可使用绿色包内置 runtime
  完成初始化，不依赖系统 Node/npm。
- [ ] 目标电脑已安装 WebView2 时客户端可正常启动；Windows 11 和公司目标 Windows 10 镜像均
  完成一次运行验证。
- [ ] 绿色版不会创建快捷方式或开机自启项；卸载方式至少能明确说明如何删除程序和数据。
- [ ] 登录配置、设备凭证、日志和同步数据仍写入
  `%LOCALAPPDATA%\TrellisBoard\data`，移动到新的解压目录不会改变数据位置。
- [ ] 现有 NSIS 构建和安装 smoke test 不回归。

## Out of Scope

- 绕过公司 AppLocker、EDR、杀毒软件或代码签名策略。
- 自动更新器、自动创建启动器快捷方式、Windows 服务或机器级部署。
- 随绿色 ZIP 提供 WebView2 在线/离线安装器或 Fixed Version Runtime。
- 为不支持的 Windows 架构生成绿色包。
