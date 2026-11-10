# 实时同步阻塞与误弹窗实施报告

## 实施结果

- 分支：`codex/live-sync-main-thread-stall`
- Worktree：`D:\wit\worktrees\live-sync-main-thread-stall\trellis-board`
- Base：`3b21f38b9f6b1c2d0daf5a6cc9a9ab08fba66409`
- Agent watcher 按项目计算一次 Git dirty 路径，只读取仍相对 HEAD 有差异的文件；
  Git merge/checkout 等最终与 HEAD 一致的写回不再 preflight 或上传。
- 已收敛的旧 decision/upload pending 会在展示或重试前清理；Git 状态检查失败时保留 pending。
- Agent 请求超时改用独立 `TimeoutError`，用户可区分“Agent 服务请求超时”和显式取消。
- 团队扫描 Worker 新增 `live-materialize`：在系统临时目录复制 `.trellis` 基线、应用实时覆盖行，
  执行 `scanRepository()`、计算任务版本并清理临时目录。
- 实时重投影改为项目级异步队列：HTTP 提交 revision 后快速返回；同项目单飞，合并更新 revision，
  丢弃旧 worker 结果；成功后统一更新索引、Board/详情并发送 `live.changed`。
- 重投影失败保留已提交 revision 和上一份一致 Board，按 1/2/4 秒、最大 30 秒退避重试；
  runtime 关闭时停止重试并终止 worker。
- 桌面控制窗口增加进程级首次自动聚焦、关闭后焦点抑制和稳定 key 去重。系统 X 与
  “稍后处理”只隐藏窗口，不删除 pending；托盘新增“处理实时确认”主动恢复入口。
- 确认窗口的关闭动作不再受 busy 锁限制；请求超时期间仍可隐藏窗口并继续当前工作。

## 主要文件

- `agent/api.js`
- `agent/live-sync.js`
- `server/team/scan-worker.js`
- `server/team/task-index.js`
- `server/team/live-sync.js`
- `server/team/http.js`
- `desktop/src-tauri/src/sidecar.rs`
- `desktop/src-tauri/src/main.rs`
- `desktop/ui/control.js`
- `tests/desktop-realtime-apply.test.js`
- `tests/team-realtime-sync.test.js`
- `tests/desktop-package.test.js`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/desktop-realtime-sync.md`
- `desktop/README.md`

## 验证

- `npm test`：475 项，470 通过、5 项按平台跳过、0 失败。
- 最终全量测试中的 320 任务真实 Worker 投影：总耗时 13643ms，期间 `/api/health`
  最大 33ms。
- 最终全量测试中的两个真实 Agent HTTP/SSE/watcher 连续同步 20 次：
  P95=2928ms、max=3018ms。
- 本次修改的 10 个 JS 文件通过 `oxfmt --check`；`git diff --check` 和 `node --check` 通过。

## 未验证

- 本机 PATH 中没有 `cargo`、`rustc` 或 `rustup`，`cargo test --manifest-path
  desktop/src-tauri/Cargo.toml` 在启动阶段即失败，未执行 Rust 编译、Rust 单测或 Tauri 构建。
- 未执行 Windows WebView2 真机控制窗口 E2E；首次聚焦、系统 X、托盘恢复和离线关闭仍需在具备
  Rust/MSVC/Windows SDK 的客户端构建环境验证。
- 全局 `npm run format:check` 仍报告 9 个与本任务无关的既有文件；本次修改文件单独检查通过。
