# 实施计划

## 1. 路径解析

- [ ] 在 `apps/desktop/src-tauri/src/agent/protocol.rs` 增加 `.trellis/tasks` 相对路径安全解析函数。
- [ ] 删除 `task_sync.rs` 中只规范根目录的 `dunce_canonical` 用法。
- [ ] 让目录写入、删除和备份复用同一解析函数，路径无效时失败关闭。
- [ ] 让 `task_command.rs` 复用同一解析规则，保留原有调用方错误码和文案。

## 2. 控制事件与界面

- [ ] `task_sync_error` 增加 `projectName`、`branchName` 增量字段。
- [ ] 从 binding 补全事件信息，不把本机 `repoPath` 写入事件或日志。
- [ ] `ControlApp.tsx` 优先显示 `项目 / 分支`，字段缺失时回退到 `taskSpaceId`。
- [ ] 路径错误使用具体文案，裸 UUID 仅作为次级诊断。

## 3. 测试

- [ ] Rust 单测覆盖普通路径根、`\\?\` 扩展路径根、活动任务、归档任务和任务根本身。
- [ ] Rust 单测覆盖 `..`、`.`、空段、绝对路径、反斜杠、NUL 和盘符替换。
- [ ] Rust 回归测试覆盖服务端目录写入；无效路径不改变本地目录、不推进 cursor。
- [ ] 更新桌面静态契约或前端测试，验证控制事件包含项目/分支且 UI 有回退逻辑。

## 4. 验证

- [ ] 开发阶段只运行与改动直接相关的 Rust/Node 测试，不执行构建。
- [ ] 所有开发完成后统一执行一次相关检查：
  - `cargo fmt --check`
  - `cargo clippy --all-targets -- -D warnings`
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `npm test`
  - `npm run build:desktop`
  - `npm run build`
- [ ] 在桌面控制窗口确认错误主信息显示 `mdp-backend-web / dev`，不读取或展示本机仓库绝对路径。

## 5. 风险与回滚点

- 高风险文件：`agent/protocol.rs`、`agent/task_sync.rs`、`agent/task_command.rs`、`ControlApp.tsx`。
- 路径解析改动必须先通过安全边界测试，再接入写、删、备份三个调用方。
- 不存在数据迁移；若出现回归，整体回滚本次代码即可，cursor 与服务端数据无需修改。
