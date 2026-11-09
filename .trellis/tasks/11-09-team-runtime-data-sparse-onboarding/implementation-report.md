# 团队运行数据外移与 .trellis 稀疏项目接入实施报告

## 实施结果

- 运行数据根已从源码 `data/` 外移，优先级为 `TRELLIS_BOARD_DATA_DIR`、平台默认目录；Ubuntu 部署建议使用 `/var/lib/trellis-board`。
- 首次启动会把旧运行数据原子迁移到新数据根，迁移数据库、WAL、凭据密钥、插件配置、备份和项目工作副本，并重写数据库项目路径；失败时保留旧数据。
- SQLite schema 升至 v8，保存 Agent 工具和项目接入阶段的 bootstrap 负责人，批准时校验两者与接入信息一致。
- 团队项目使用 partial clone 和 non-cone sparse checkout，只检出 `.trellis/`。
- 目标分支没有 `.trellis/` 时，服务端使用项目内固定的 `@mindfoldhq/trellis@0.6.17` 自动初始化、校验产物、提交并推送；推送失败或发生不可恢复分叉时不创建可用项目。
- 管理页接入表单支持 Agent 工具多选，并把首个负责人和 Trellis developer ID 前移；批准页只读展示新项目的 bootstrap 信息，旧项目保持兼容。
- 示例配置已迁至 `config/examples/`，源码根 `.gitignore` 只保留 `/data/` 防复发规则。

## 关键文件

- `server/config.js`
- `server/data-migration.js`
- `server/database.js`
- `server/team/git-manager.js`
- `server/team/projects.js`
- `shared/trellis-agent-tools.js`
- `web/src/features/admin/OnboardingTab.tsx`
- `web/src/features/admin/ApproveProjectDialog.tsx`
- `web/src/features/admin/MultiSelectField.tsx`

## 自动化验证

- `npm run format:check`：通过。
- `npm --prefix web run lint`：退出码 0；剩余警告均为既有文件。
- `node node_modules/typescript/bin/tsc -b --pretty false`：通过。
- `npm --prefix web run build`：通过，仅有既有大 chunk 警告。
- 目标后端测试：53/53 通过。
- 数据迁移测试：7/7 通过。
- 完整 `npm test`：404 pass、7 fail、5 skip。7 项失败均为工作区缺少未提交的 `plugins/witops-core` 和 `plugins/witops-workbench` 导致，与本次改动无关。

## 未在本机自动执行的发布动作

- 真实 `data/` 尚未迁移；当前 4317 服务仍由旧代码运行。停止服务后启动新代码会执行自动迁移。
- 既有 IntelliJ VCS 映射不在产品代码中修改；旧的 `data/projects/*` 映射需要在 IDE 中手动移除。
- 远端可达历史清理在功能提交后单独执行，并保留 mirror/bundle 备份。
