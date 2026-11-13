# 检查报告：合并后任务归属与同步暂停

## 已修复

- `apps/server/team/gitless-board-service.js`
  - `/api/board` 在缓存任务覆盖列表任务时补回 `sourceBranchName`，避免主 Board 丢失来源分支。
  - `/api/task` 直接详情按项目稳定任务 ID 查询合入证据并返回 `sourceBranchName`，避免没有列表兜底时丢失来源分支。
- `apps/server/test/team-gitless-http.test.js`
  - 增加基线接纳来源任务后的 `/api/board` 与 `/api/task` 来源分支回归断言。
- 既有检查修复已在实现中保留：
  - 覆盖服务端冲突时传递合入证据。
  - 空分支归属补齐后继续执行基线 HEAD 判定。
  - 来源 taskSpace 收到 `TASK_OWNED_BY_BASELINE` 后清除 pending，不推进 revision/sequence/baseline。

## 未修复

- `apps/server/test/database-v10.test.js` 的 v9 升级用例在本机 Windows 上完成
  迁移断言后，`fs.rmSync` 删除临时 SQLite 目录时返回 `EPERM`。这是临时目录清理问题，
  不是迁移断言失败；未通过吞异常或修改测试断言规避，需在 Windows SQLite 句柄释放工具链
  或 CI 环境确认。
- 当前环境没有 `cargo`、`rustc` 或 `rustfmt`，因此未运行 Rust 格式化、`cargo test`、
  `cargo clippy` 和桌面客户端构建。Agent 的 HEAD 缓存、同 HEAD 多任务共享扫描和
  `TASK_OWNED_BY_BASELINE` 停止主动上传仍需要真实 Rust 工具链及客户端测试验证。
- 未执行真实 Windows 客户端、17 个历史任务和真实数据库副本的 E2E；也未提交、推送、构建
  生产包或归档任务。

## 验证

- 聚焦回归：`60/60` 通过
  （team-task-snapshot、team-task-index-v10、team-task-spaces、team-gitless-http、team-web）。
- 全仓 `npm test`：`438` 通过、`1` 跳过、`1` 失败；唯一失败为上条 Windows `EPERM`
  清理问题，迁移断言本身通过。
- `npm run lint --workspace @trellis-board/web`：通过，仅已有 warning。
- `npx tsc -b apps/web/tsconfig.json --pretty false`：通过。
- 改动 JavaScript/TypeScript 文件的 `oxfmt --check`：通过。
- `git diff --check`：通过。
- Rust/桌面编译：未执行，原因见上。

## 主代理最终复核

- `npm run build` 通过，Web 生产构建成功写入 `apps/server/public/`；只有既有的大 chunk 警告。
- 聚焦回归再次执行：
  `node --test apps/server/test/team-task-snapshot.test.js apps/server/test/team-task-index-v10.test.js apps/server/test/team-task-spaces.test.js apps/server/test/team-gitless-http.test.js apps/web/test/team-web.test.js`
  结果为 `60/60` 通过。
- 使用运行中 Team 数据库的 `VACUUM INTO` 副本执行真实 v11 -> v12 升级：schema version 为 `12`，
  `sync_task_merge_evidence` 存在，`mdp-backend-web.baseline_branch = dev`，基线 taskSpace 为 `dev`。
- `database-v10.test.js` 在本机 Node `24.21.0` / Windows 仍可单独复现 v9 用例的临时 SQLite 文件
  `EPERM` 清理失败；迁移和备份断言均先通过，失败发生在 `fs.rmSync` 清理阶段。
- 本机未安装 `cargo`、`rustc`、`rustfmt`，Rust/Tauri 编译和真实客户端 E2E 尚未验证。
