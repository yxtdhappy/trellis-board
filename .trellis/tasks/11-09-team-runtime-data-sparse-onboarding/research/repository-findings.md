# 仓库调研：运行数据、远端历史与项目接入

## 1. 当前运行数据位置

- `server/config.js:6` 把 `dataDir` 固定为 `<appDir>/data`。
- `server/team/git-manager.js:234` 把受管项目根目录固定为 `<dataDir>/projects`。
- `server/team/projects.js:151` 重复使用相同目录。
- `server/team/git-manager.js:476` 当前使用完整 `git clone`，只限制单分支，没有 sparse checkout。
- `server/team/projects.js:353` 在项目接入时立即 clone，然后计算 `.trellis/scripts` 工具链摘要。

结论：服务端运行数据库和外部 Git 克隆都位于开发者源码工作树内。

## 2. IDEA 自动注册证据

`C:\Users\yuhaojie\AppData\Local\JetBrains\IntelliJIdea2026.1\log\idea.1.log`：

```text
2026-11-09 20:43:17 Auto-registered ... D:/wit/trellis-board/data/projects/9c772715-bc4b-42e6-8419-7dbd5f28baf3
2026-11-09 20:47:04 Auto-registered ... D:/wit/trellis-board/data/projects/92b71409-17e6-4052-8a88-923490a0d377
```

`.idea/vcs.xml` 随后包含根仓库和两个嵌套仓库映射。服务端代码没有修改 `.idea`；触发原因是受管克隆位于 IDE 工程树内。

## 3. `data/` 远端审计

当前跟踪文件：

```text
data/.gitignore
data/plugins.example.json
data/plugins.secrets.example.json
data/repos.example.json
data/standalone-backup-20261108-142014/board.sqlite
```

`git ls-tree -r --name-only HEAD -- data` 与 `origin/codex/team-board` 均包含上述文件。

误提交数据库：

- 路径：`data/standalone-backup-20261108-142014/board.sqlite`
- 引入提交：`ef7eb4f`
- 大小：5,271,552 字节
- 表数量：34
- 业务记录：`user_account=0`、`user_session=0`、`team=0`、`team_project=0`、`task_assignment=0`
- 仍有 `repositories=5`，包含本地仓库路径信息

结论：不应发布到远端，且用户已确认要清除全部 `data/` 历史。

## 4. 现有跨平台数据目录模式

- 桌面端 `desktop/src-tauri/src/config.rs:14` 默认 `%LOCALAPPDATA%/TrellisBoard/data`，支持 `TRELLIS_DESKTOP_HOME`。
- Agent `agent/config-store.js:16` 默认 `%LOCALAPPDATA%/TrellisBoardAgent`，支持 `TRELLIS_AGENT_ROOT`。
- 服务端没有等价的数据根覆盖变量。

结论：服务端应增加同类的 `TRELLIS_BOARD_DATA_DIR`，并为 Windows、macOS、Linux 提供平台默认值。

## 5. Trellis CLI 行为

- 当前全局版本：`@mindfoldhq/trellis@0.6.17`。
- `trellis init -y` 为非交互模式，已有文件默认跳过。
- `init` 至少要求一个 AI 工具；无显式工具时 `-y` 默认 Cursor + Claude。
- 支持通过多个平台 flag 一次安装多个工具。
- `-u/--user` 指定 developer；`.trellis/.developer` 被 Trellis 自己的 `.gitignore` 忽略。
- 初始化会生成 `.trellis`，并按平台生成对应顶层工具目录和 `AGENTS.md`、`.gitattributes` 等文件。

团队成员批准目前要求 `.trellis/workspace/<trellisDevId>` 存在，见 `server/team/toolchain.js:124`。因此自动初始化必须使用首个负责人的 developer ID。

## 6. 当前项目接入与批准顺序

- 接入表单只有远端、凭据、项目名、共享分支和已有仓库 ID，见 `web/src/features/admin/OnboardingTab.tsx`。
- `connectProject` 成功后立即打开批准面板，见 `web/src/hooks/useAdminProjects.ts:258`。
- 负责人和 developer ID 当前只在批准表单选择，见 `web/src/features/admin/ApproveProjectDialog.tsx:58`。
- 用户已确认把负责人选择前移到接入表单，并把 Agent 工具作为多选字段。

## 7. 稀疏检出兼容性

- 团队任务索引只读取 `.trellis/tasks`。
- 工具链摘要只读取 `.trellis/scripts`。
- 负责人校验只读取 `.trellis/workspace`。
- 团队任务写入只提交 `.trellis/tasks` 下的路径，见 `server/team/task-writes.js`。
- 实时同步只覆盖 `.trellis/.developer`、`.trellis/tasks` 和 `.trellis/workspace`。

结论：服务端工作副本长期只需要 `.trellis/`。

## 8. 测试现状

- Node 内置测试是唯一自动测试入口。
- 前端最终验证命令为 `npm --prefix web run build`。
- 当前没有 `git filter-repo`，远端历史清理需要采用 Git 内置能力或在执行阶段单独准备一次性工具。
- 现有团队测试覆盖项目接入、Git 凭据、远端探测和 schema v7；新增逻辑必须补 v8、稀疏 clone、自动初始化和迁移测试。
