# 实施报告

## 修改

- `.github/workflows/windows.yml`
  - 将根 `package-lock.json` 加入 npm 缓存键。
  - 在 Node 测试 Job 中先执行根目录 `npm ci`，确保真实 Trellis CLI 测试有固定版本依赖。
- `tests/witops-plugins.test.js`
  - 移至被忽略的 `plugins/witops-core/test/witops-plugins.test.js`。
  - 修正 helper 相对导入。
  - 私有插件缺失时显式跳过，保留有插件环境的本地执行能力。
- `tests/team-sparse-onboarding.test.js`
  - 清理克隆测试显式使用 `core.autocrlf=false`，与服务端 Git 命令保持一致。
- `.trellis/spec/backend/quality-guidelines.md`
  - 记录 CI 根依赖安装要求。
- `.trellis/spec/backend/plugin-testing.md`
  - 记录私有插件测试目录和缺失插件时跳过规则。

## 验证

- `npm ci --dry-run`：通过。
- `node --test plugins/witops-core/test/witops-plugins.test.js`：7 项按预期跳过。
- 模拟 `core.autocrlf=true` 后运行稀疏检出用例：通过。
- `npx oxfmt --check plugins/witops-core/test/witops-plugins.test.js`：通过。
- `git diff --check`：无新增空白错误。

## 未闭环

全量 `npm test` 共 422 项，406 通过、12 跳过、4 失败。失败位于并行进行中的 Agent 目录功能，涉及 `team-core`、`team-release` 和两个新增稀疏接入用例；不属于本任务修改范围。
