# 客户端 workspace 接入实施记录

## 实施步骤

1. [x] 设备注册响应补充 `username` / `teamId`，协议解析、本地 config 校验与写入同步。
2. [x] `agent/cli.js` 增加 `workspace init` / `workspace status`、默认用户名解析、JSON 摘要与分类退出码。
3. [x] 新增 `desktop/sidecar/workspace-init.js`，`main.js` 注册 `workspace-init` 子命令并复用 DPAPI 凭证。
4. [x] `desktop/src-tauri` 增加 dialog 插件、`pick_workspace` / `init_workspace` 命令、sidecar spawn、权限与 capability。
5. [x] `desktop/ui/index.html` / `setup.js` 增加 workspace 选择、初始化、结果与打开看板入口。
6. [x] 新增 `tests/workspace-client-flow.test.js`，更新 `tests/desktop-package.test.js`。
7. [x] 运行验证命令并修复失败。
8. [x] 显式 `git add`，英文 commit；保持 `task.json.status = in_progress`，不 archive、不合并。

## 验证命令

```bash
python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-workspace-client-flow
node --test tests/workspace-client-flow.test.js
npm test
npm run build
git diff --check
```

## 约束检查

- 初始化只调用 `initializeWorkspace()`；不执行 Python、不 `git init`、不覆盖已有文件。
- 桌面初始化在 sidecar 进程执行，远程页面无 IPC。
- 未新增根 `package.json` 依赖。
- Windows 运行时（dialog、spawn、NSIS）未实机验证，报告中明确列出。

## 验证记录

- `task.py validate`：通过（implement 5 条、check 5 条）。
- `node --test tests/workspace-client-flow.test.js`：9 个测试全部通过。
- `node --test tests/desktop-package.test.js`：10 个测试全部通过（含注册后 config 的 `username` / `teamId`）。
- `node --test tests/team-core.test.js tests/team-isolation.test.js tests/team-workspace-template.test.js tests/workspace-bootstrap.test.js`：41 个测试全部通过。
- `npm test`：318 个测试，317 通过，1 个既有跳过（真实 ACP agent 端到端），0 失败。
- `npm run build`：Vite 构建通过（输出到 gitignored `public/`）。
- `git diff --check`：通过。
- 未实机验证：Windows 目录选择器（`tauri-plugin-dialog`）、Tauri 编译、sidecar SEA 打包后的 `workspace-init`、NSIS 安装包；当前环境 `cargo` / `pwsh` 不可用。
- 未验证项的原因：Linux 容器无法运行 Windows WebView2/DPAPI；Rust 改动只做静态断言与 API 审查。
- 旧设备兼容：历史 `config.json` 没有 `username` / `teamId` 时，桌面端提示重新注册；CLI 可用 `--username` / `--team` 显式提供。
