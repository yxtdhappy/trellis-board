# 执行计划：Python 环境门与 mine 过滤

> 顺序：先服务端过滤（可独立验证、风险低），再桌面端 Rust，最后前端与文档。

## A. 服务端「只看我的」

- [ ] A1 `apps/server/team/task-space-index.js`：mine 条件改为 `EXISTS (SELECT 1 FROM sync_project_member mine ...)`，`t.assignee_dev_id = mine.trellis_dev_id COLLATE NOCASE`（替换 `:787-790` 的 `t.assignee_user_id = ?`）。
- [ ] A2 同文件：新增 `mineMembers` 签名（仅 `filters.scope === 'mine'` 时查询 `sync_project_member`），写入 `etag` 与 `cacheKey`（`:750-771` 两份哈希对象）。
- [ ] A3 新增 `apps/server/test/team-task-mine-scope.test.js`（源自 `research/mine-scope-repro.test.js`）：4 条断言见 `design.md` §2.3。
- [ ] A4 验证：`node --test apps/server/test/team-task-mine-scope.test.js`，再跑 `node --test "apps/server/test/*.test.js"`。
- [ ] 回滚点：A1/A2 是两处独立改动，任一失败直接还原该 hunk。

## B. 桌面端 Rust（`apps/desktop/src-tauri/src/agent/env.rs`）

- [ ] B1 常量与类型：`PYTHON_MIN_VERSION`/`PYTHON_INSTALL_VERSION`/`PYTHON_INSTALLER_URL`/`PYTHON_INSTALLER_SHA256`/`PYTHON_INSTALLER_ARGS`/`PYTHON_PROBE_TIMEOUT_SECS(30)`/`PYTHON_INSTALL_TIMEOUT_SECS(600)`/`CODE_PYTHON_INVALID`、`PythonStatus`、`PythonRuntimeFlag`（无 `python_exe_path()`，路径来自 `python_runtime.path`）。
- [ ] B2 `ClientConfigLike` + `Value` 实现增加 python flag 读写；`write_runtime_flags` 增加 python 参数。
- [ ] B3 `parse_python_version(&str) -> Option<String>` + `python_version_at(&Path)`；`resolve_python(config)` 按 design §1.2 顺序探测并写回标志。
- [ ] B4 `check()`：`RuntimeStatus.python`，`state` 纳入 `python.ok`。
- [ ] B5 安装：抽 `download_file(url, sha256, file_name, stage, on_progress)` 给 node/python 共用（node 原下载逻辑改为调用它）；`install_python` = 下载官方安装包到 `<dataDir>/downloads/` → 校验 sha256 → `Command::new(exe).args(PYTHON_INSTALLER_ARGS)`（`/quiet InstallAllUsers=0 PrependPath=1 …`）→ 退出码 0/3010 视为成功 → 重新探测确定解释器路径（`%LocalAppData%\Programs\Python\Python312\python.exe` → `py -3` → `python`）→ 写 flag → 删除安装包；`install()` 串上阶段 `python:download|verify|install|validate` 并写 `RuntimeInstallResult.python_version`。
- [ ] B6 单测（`env.rs` 的 `mod tests`）：`parse_python_version` 覆盖 `Python 3.12.8`、`Python 3.12`、`Python 2.7.18`、垃圾输出。
- [ ] B7 `apps/desktop/src-tauri/src/agent/task_command.rs` `run_task_python` 候选插入 `client.json` 记录的解释器路径（`config::data_dir()` 读 `python_runtime.path`，文件存在才加入），位于 `TRELLIS_PYTHON` 之后、`python` 之前。
- [ ] B8 验证：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml env::` 与 `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`；运行期冒烟已在规划阶段完成（官方安装包静默装到项目临时 TargetDir → `python.exe --version` = 3.12.8、`python.exe .trellis/scripts/task.py --help` 退出码 0 → `/uninstall /quiet` 清理干净），实现后只需再确认 `install_python` 产出的 flag 指向的解释器可用同一条命令。
- [ ] 回滚点：B1–B5 都只在 `env.rs` 内新增，删除新增块即可回到 Node+Trellis 双项门禁。

## C. 前端与文档

- [ ] C1 `apps/web/src/desktop/LoginApp.tsx`：类型、`STEP_ORDER`、`STEP_LABELS`、`PROGRESS_STEP`、`applyRuntime`（missing/ready 文案）、`installRuntime` 成功改 `refreshRuntime()`、底部说明。
- [ ] C2 `apps/desktop/README.md`：运行环境概述、「运行环境门」流程块、验收表。
- [ ] C3 验证：`npm run build`（web 产物编译通过）；实际启动客户端或 `npm run web:dev` 打开 `/desktop` 路由，确认步骤条含 Python 项（无运行环境时展示 `needs_setup` 文案）。

## D. 收尾

- [ ] D1 `npm run format`（oxfmt）+ `npm run format:check`。
- [ ] D2 `npm test`（全量 server/web/packages 测试）。
- [ ] D3 删除 `research/mine-scope-repro.test.js` 之外的临时产物（本任务无其他临时文件）。
- [ ] D4 `trellis-update-spec`：把「mine 过滤按项目当前 trellis dev id 在查询时解析 + 哈希需带成员签名」「便携 Python 的 `._pth` 陷阱」写入 `.trellis/spec`。
- [ ] D5 提交（需用户明确同意后执行），任务目录一并提交，然后 `task.py archive`。
