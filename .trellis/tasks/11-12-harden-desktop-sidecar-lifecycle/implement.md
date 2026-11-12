# 实施计划

## 1. 前置

- [x] 确认工作区其他并行改动，只修改本任务拥有的文件。
- [x] 保留已完成的 NSIS hook 草稿并纳入本任务。

## 2. Sidecar 父进程看门狗

- [x] 新增 `desktop/sidecar/parent-watchdog.js`。
- [x] 在 `runSidecarMain()` 生命周期内启动和停止 watchdog。
- [x] 增加单元测试及真实父子进程退出测试。

验证：

```powershell
node --test tests/desktop-sidecar-lifecycle.test.js
```

## 3. Rust 子进程生命周期

- [x] 长驻和一次性 sidecar 命令统一启用 `set_process_group(true)` 与 `kill_on_drop(true)`。
- [x] `run_json_command()` 增加显式 timeout。
- [x] 超时、stdin 写入失败和命令错误路径主动终止进程组。
- [x] 按操作类型配置短、中、长三类超时。

验证：

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

本机没有 Rust 工具链时，以 GitHub Windows `desktop build` 为编译验证。

## 4. 项目栏轮询

- [x] 在 `ProjectRail` 中增加 `associationRequestInFlight` 防重入。
- [x] 保持 3 秒轮询、卸载清理和现有状态渲染不变。

验证：

- 浏览器/Tauri 项目栏连续刷新时，不出现并发 `list_local_associations`。
- 现有前端构建和项目栏纯逻辑测试通过。

## 5. NSIS 升级兜底

- [x] 核对 `tauri.conf.json` 的 `installerHooks`。
- [x] 核对 `hooks.nsh` 的 PREINSTALL/PREUNINSTALL。
- [x] 在 Windows workflow 增加“文件被运行中 sidecar 锁定后升级”测试。

验证：

```powershell
node --test tests/desktop-package.test.js
```

GitHub Windows `desktop build` 必须完成 bundle、running-upgrade smoke 和 uninstall。

## 6. 检查与收尾

- [x] `npx oxfmt --check` 检查改动的 JS/TS 文件。
- [x] `git diff --check`。
- [x] `npm test`。
- [ ] GitHub Windows `node tests` 与 `desktop build` 成功。
- [ ] 真实本机强制结束客户端后无残留 `trellis-agent.exe`。
- [x] 更新 `.trellis/spec/backend/desktop-sidecar-packaging.md`。
- [ ] 按用户授权提交、推送并触发 GitHub 构建。

## 当前验证结果

- 2026-11-12 本机完整 `npm test`：515 个用例，510 通过、0 失败、5 个平台跳过。
- `npm --prefix web run build`：TypeScript 与 Vite 构建通过。
- `npm --prefix web run lint`：退出码 0，仅保留仓库既有警告。
- `npx oxfmt --check` 与 `git diff --check`：通过。
- Rust、真实 NSIS 安装/升级/卸载仍以 GitHub Windows CI 为准。

## 风险点与回滚

- Rust 进程组设置依赖 `tauri-plugin-shell` v2 API；若 CI 版本不支持，固定兼容版本并停止实施。
- 前端 polling guard 与并行项目接入改动可能重叠，合并时只保留行为等价的防重入逻辑。
- 回滚不涉及数据迁移；删除 hook 或 watchdog 后恢复旧行为。
