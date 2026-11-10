# Agent 目录识别与增量初始化实施计划

## Step 1：共享探测契约

- 扩展 `shared/trellis-agent-tools.js` 和类型声明。
- 添加 `detectTrellisAgentTools(paths)`。
- 更新 `tests/trellis-agent-tools.test.js`，验证路径映射、共享目录排除和输入边界。

验证：Node 内置测试通过，前端 TypeScript 可导入新字段。

## Step 2：分支级 Git tree 探测

- 在 `server/team/git-manager.js` 增加临时 partial clone 探测。
- 扩展 `probeRemote()` 返回 `branch`、`existingAgentTools`、`hasTrellis`。
- 远端探测合并 `git show HEAD:.trellis/.template-hashes.json` 中记录的模板路径。
- 清单缺失、损坏或不可读时安全回退为空，不影响 tree 探测。
- 在 `server/team/projects.js` 和 HTTP 路由传递可选 `branch`。
- 更新 `web/src/api/admin.ts` 类型和解析。

验证：本地临时远端不同分支返回不同 Agent；tree 无 ignored `.codex` 但清单记录时仍识别 Codex；认证失败和临时目录清理正常。

## Step 3：增量初始化

- `cloneForTeam()` 重新探测远端 Agent。
- 增加初始化前临时稀疏模式和根文件检出。
- 已有 `.trellis/` 时只初始化缺失 Agent；没有缺失项时跳过。
- 缺少 `.trellis/` 时初始化基础结构并保护已有 Agent 文件。
- 工作副本校验合并模板清单路径，识别被 `.gitignore` 排除但由初始化生成的 Agent 文件。
- 初始化提交后只清理临时克隆中的已知 Agent 路径，再收敛为 `.trellis`。
- connect 持久化 Agent 并集，审计记录现有与本次初始化 Agent。

验证：真实本地 Git 远端覆盖“仅新增 Agent”“全部已存在”“缺少 .trellis”“ignored Agent 文件”“push 失败”。

## Step 4：前端崩溃与成员加载

- 将 `DropdownMenuLabel` 放入 `DropdownMenuGroup`。
- `MultiSelectField` 增加 `lockedValues`，锁定项禁用并显示“已接入”。
- `OnboardingTab` 增加 `existingAgentTools` 状态和分支重新探测。
- 在具体团队且用户列表为空时加载 active 团队成员。
- 为“全部团队”范围添加明确提示。

验证：类型检查、构建、浏览器控制台无 Base UI 错误。

## Step 5：自动化质量门

- 运行目标后端测试。
- 运行前端 lint、类型检查和构建。
- 运行 `git diff --check`。
- 检查新增字段在 probe、connect、数据库和列表响应中的一致性。

## Step 6：真实浏览器 E2E

- 选择“大数据”团队。
- 使用 `yhj_trellis` 凭据探测目标 SSH 仓库。
- 只选择并验证 `dev` 分支，不关注其他分支。
- 验证已有 Agent 自动锁定，仅缺失 Agent 可选。
- 完成接入和工具链批准。
- 检查服务端工作副本最终只保留 `.trellis/`。

## Step 7：提交与归档

- 只暂存本任务文件。
- 创建本地提交。
- 更新 Trellis 检查和 E2E 报告。
- 完成会话记录并归档任务。
