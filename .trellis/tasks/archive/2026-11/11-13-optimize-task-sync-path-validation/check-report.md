# 检查报告

## 结论

通过。合法团队任务目录不再因 Windows `canonicalize` 路径形态差异被误判越界；同步错误控制窗口显示项目、分支和相对任务目录，不泄露本机 `repoPath`。

## 本地验证

- `npm test`：437 个测试，436 通过、1 跳过、0 失败。
- `npm run build`：通过。
- `npm run build:desktop`：通过。
- `node --test apps/desktop/test/desktop-ui-build.test.js`：6/6 通过。
- `git diff --check`：通过。
- 前端 lint：通过，保留仓库既有警告。
- 本机没有 Rust/Cargo 与 MSVC 构建工具，Rust 验证交由 GitHub Actions。

## GitHub Actions

- Run：[windows #43399402220](https://github.com/yxtdhappy/trellis-board/actions/runs/43399402220)
- Commit：`b01727f5f121c60230522c6c142ccec3cc759ca9`
- `node tests (windows)`：通过。
- `desktop build (windows)`：通过。
- Rust unit tests：通过。
- Tauri desktop bundle：通过。
- Portable package：通过。
- Portable package smoke test：通过。
- Launch smoke test：通过。
- Artifact upload：通过。

## 覆盖点

- 普通 Windows 根和 `\\?\` 扩展根。
- 活动任务与归档任务相对目录。
- 根目录、`.`、`..`、空段、反斜杠、NUL、盘符、ADS、尾部空格/句点。
- 非法删除保留原目录。
- 非法备份不创建 live backup。
- 事件含 `projectName/branchName/taskDir` 且不含 `repoPath`。
- 旧事件缺可读字段时回退 `taskSpaceId`。

## 已知风险

- 符号链接检查与实际文件操作之间仍存在理论 TOCTOU 窗口；当前本地桌面 Agent 信任模型接受该边界。
- 本任务只让路径逻辑跨平台中立，不代表客户端已支持 macOS/Linux 打包与运行。
