# 团队运行数据外移与 .trellis 稀疏项目接入检查报告

## Findings (fixed)

- File: `server/data-migration.js`
- Issue: 目标数据目录此前只留下 `.layout-v1` 标记时，后续出现旧运行数据会进入 staging，但 `installStaging()` 把仅含标记的目录当成非空目录并拒绝安装。
- Fix: 目标仅含布局标记时，先删除该标记并移除空目录，再原子重命名 staging；其他任何文件仍拒绝覆盖。

- File: `tests/data-migration.test.js`
- Issue: 上述 marker-only 目标分支没有回归测试。
- Fix: 新增“先建布局标记、后出现旧运行数据”的迁移测试，验证迁移成功、标记重建、运行文件复制及源文件清理。

- File: `web/src/features/admin/OnboardingTab.tsx`
- Issue: 用 effect 同步异步加载后的首个负责人会触发 `set-state-in-effect` 和缺失依赖警告，并增加一次级联渲染。
- Fix: 删除同步 effect，在渲染期从当前选择与 active 用户列表派生有效负责人；提交、下拉值和按钮禁用使用同一派生值。

- File: `.trellis/spec/backend/architecture-and-runtime.md`
- File: `.trellis/spec/backend/scanning-and-persistence.md`
- File: `.trellis/spec/backend/quality-guidelines.md`
- File: `.trellis/spec/guides/cross-layer-thinking-guide.md`
- Issue: 规格仍把数据库描述为源码 `data/board.sqlite`，并残留 schema v3 或 v1 -> v3 迁移说明。
- Fix: 同步为跨平台运行数据目录、schema v8 和 v6/v7 -> v8 迁移契约。

- File: `.trellis/spec/backend/plugin-runtime.md`
- File: `web/src/features/plugins/PluginsView.tsx`
- Issue: 插件配置说明和空状态仍引用源码 `data/plugins.json`。
- Fix: 改为运行数据目录中的 `plugins.json` / `plugins.secrets.json`，保留敏感文件备份告警。

- File: `docs/team-operations.md`
- Issue: Windows PowerShell 示例把 Ubuntu 路径 `/var/lib/trellis-board` 赋给 `TRELLIS_BOARD_DATA_DIR`，跨平台命令不可直接执行。
- Fix: 拆分 Windows PowerShell 与 Ubuntu Bash 启动示例。

## Findings (not fixed)

- File: `origin/codex/team-board`
- Issue: 远端可达树仍包含 `data/.gitignore`、三个示例 JSON 和 `data/standalone-backup-20261108-142014/board.sqlite`；备份文件由 `ef7eb4f39357f599834d93b6c6ceb62fcf2f73ac` 引入。
- Why not fixed: 历史重写、mirror/bundle 备份和 `--force-with-lease` 推送属于主会话最后执行的高风险发布步骤；本检查未创建备份，也没有改写或推送远端历史。

- File: `tests/witops-plugins.test.js`
- Issue: 完整 `npm test` 有 7 项失败，根因是工作区缺少未提交的 `plugins/witops-core` 与 `plugins/witops-workbench` 目录，插件加载返回 503 或空面板。
- Why not fixed: 这是本任务之外的另一组未提交插件工作，当前工作区中不存在可加载源码；按范围约束不回滚、不伪造或补写这些插件。

- File: `tests/artifacts/plugin-ui.md`
- Issue: 2026-11-05 的历史验收记录仍提到旧路径 `data/plugins.json`。
- Why not fixed: 这是过去浏览器验收的事实记录，不应当改写历史；当前规范、README 和运行代码已使用运行数据目录。

- File: IntelliJ VCS mappings
- Issue: 已自动注册的 `data/projects/*` 嵌套 Git 根可能仍保存在用户 `.idea/vcs.xml`。
- Why not fixed: 产品代码不得修改 `.idea`；新服务不会再在该路径创建工作副本，已有映射需要用户在 IDE 中手动移除。

## Verification

- Lint: pass。`npm run format:check` 通过；`npm --prefix web run lint` 退出码为 0，剩余 23 条均为既有文件警告，本轮新增的 `OnboardingTab` effect 警告已消失。
- TypeCheck: pass。在 `web/` 执行 `node node_modules/typescript/bin/tsc -b --pretty false` 无输出、退出码 0。
- Tests: partial。目标后端测试 53/53 通过；新增迁移测试在完整测试中通过。完整 `npm test` 为 404 pass、7 fail、5 skip，7 项失败全部来自缺失的上述两个 witops 插件目录。
- Format/Diff: `git diff --check` 退出码 0；仅有无关任务 `11-08-team-realtime-collaboration/task.json` 的既有 CRLF 提示。
- Dependency: `npm ls @mindfoldhq/trellis` 显示本地固定版本 `0.6.17`。
- Startup recovery order: `recoverProjects()` 完成稀疏转换后重新调用 `projectService.listAll()` 再处理 `pending_push`，不会继续使用第一轮旧对象。
- Remote audit: `git ls-tree -r --name-only origin/codex/team-board -- data` 仍输出 5 个 `data/` 路径；远端清理尚未完成。
- Real E2E: 本检查未启动真实服务、未迁移真实运行数据、未执行浏览器接入验收；这些必须由主会话在临时数据根和临时 Git 远端上完成。

未提交、未推送、未重写远端历史。
