# 修复 Windows CI 测试失败

## Goal

让 `windows` GitHub Actions 工作流的 Node 测试在干净检出环境中稳定通过，同时保持私有插件测试只在拥有对应插件的本地环境执行。

## 背景

失败运行 `42730285109` 的桌面构建成功，`node tests (windows)` 中 `npm test` 失败，共涉及三个独立问题：

- 工作流只安装 `web/` 依赖，根目录 `@mindfoldhq/trellis` 未安装，真实 CLI 测试返回 `GIT_UNAVAILABLE`。
- 公开测试 `tests/witops-plugins.test.js` 引用被 `.gitignore` 排除的私有插件目录，干净 CI 检出后无法运行。
- 稀疏检出测试使用系统默认 Git 配置克隆，而服务端固定使用 `core.autocrlf=false`，Windows CRLF 检出被误判为未提交变更。

## Scope

- 在 Node 测试 Job 中安装根目录依赖，并缓存根 `package-lock.json`。
- 将私有 `witops` 集成测试移到被忽略的插件测试目录，修正相对导入。
- 让稀疏检出测试克隆显式使用 `core.autocrlf=false`。
- 更新相关质量规范，避免同类 CI 配置回退。

## Non-goals

- 不修改 `ensureSparseTrellis()` 的产品逻辑。
- 不删除或提交任何私有插件实现。
- 不提交、推送或触发 GitHub Actions。
- 不修改当前工作区中“项目 Agent 目录保护”的并行改动。

## Acceptance Criteria

- [x] 干净检出后，`npm ci && npm ci --prefix web && npm test` 不再因缺少 Trellis CLI 失败。
- [x] 公开仓库的 `npm test` 不再加载不存在的 `plugins/witops-core` 或 `plugins/witops-workbench`。
- [x] 私有插件测试文件仍保留在本地忽略目录，存在插件时可被 `plugins/*/test/*.test.js` 收集。
- [x] `core.autocrlf=true` 环境下，稀疏检出用例不再把行尾差异误判为未提交变更。
- [x] 与本任务无关的现有未提交改动保持原状。
