# 客户端 workspace 初始化实施记录

## 实施步骤

1. [x] 生成并提交 `server/templates/workspace/` 静态资产：`workspace-template.zip`、`manifest.json`（版本、默认/可选工具、SHA-256、文件哈希表）。
2. [x] 新增 `server/team/workspace-templates.js`：懒加载归档、首次读取校验清单哈希、生成 ETag/头部、团队/成员授权。
3. [x] 在 `server/team/http.js` 注册 `/api/teams/:teamId/workspace-template` 与 `/manifest`，支持会话和 Agent Bearer、HEAD、304；不改变既有 Agent 路由。
4. [x] 新增 `agent/zip.js`：中央目录解析、store/deflate、CRC-32、条目路径/类型限制、临时目录安全解包。
5. [x] 新增 `agent/workspace.js`：路径校验、下载与内容寻址缓存、哈希校验、工具选择、合并/备份、developer 初始化、回滚、脱敏结果。
6. [x] 新增 `tests/team-workspace-template.test.js` 与 `tests/workspace-bootstrap.test.js`，覆盖设计文档第 6 节场景。
7. [x] 运行 `task.py validate`、针对性测试、`npm test`、`npm run build`、`git diff --check`，修复失败。
8. [x] 显式 `git add` 提交，保持 `task.json.status = in_progress`，不 archive、不合并。

## 验证命令

```bash
python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-workspace-bootstrap
node --test tests/team-workspace-template.test.js tests/workspace-bootstrap.test.js
npm test
npm run build
git diff --check
```

## 验证记录

- `task.py validate`：通过（6 条 implement、6 条 check）。
- 针对性测试：`tests/team-workspace-template.test.js` + `tests/workspace-bootstrap.test.js` 共 20 个测试全部通过。
- 全量 `npm test`：274 个测试，273 通过，1 个既有跳过（真实 ACP agent 端到端），0 失败。
- `npm run build`：Vite 构建通过（输出到 gitignored `public/`）。
- `git diff --check`：待提交前执行。
- 未实机验证：Windows 的解包路径校验、重解析点拒绝和只读目录行为；代码按 POSIX/Windows 分支实现，Linux 全量测试通过。
- 模板来源 CLI `0.6.16`，项目版本 `0.6.17`；目标机不依赖全局 CLI，版本差异已写入 `design.md`。
