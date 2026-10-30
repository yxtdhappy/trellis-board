# 规范初始化实施记录

## 实施步骤

- [x] 阅读 `package.json`、`server/`、`public/`、`tests/` 和现有 `.trellis/spec/`。
- [x] 删除 React、Hooks、TypeScript 等不适用于当前项目的模板内容。
- [x] 重建 backend、frontend 和 guides 规范及索引。
- [x] 补充 SQLite 持久化后的当前技术事实，避免继续把 JSON 写成运行时状态来源。
- [x] 检查所有索引和相对 Markdown 链接。
- [x] 运行自动测试、JS 语法检查和上下文发现验证。

## 验证命令

```powershell
npm test
Get-ChildItem -Path server,public -Filter '*.js' -File -Recurse |
  ForEach-Object { node --check $_.FullName }
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/task.py validate 00-bootstrap-guidelines
node .audit/bootstrap-spec-check.mjs
```

## 验证结果

- `npm test`：55 项通过，0 失败。
- `server/`、`public/`：全部 JavaScript 文件通过 `node --check`。
- 上下文发现：backend、frontend 两层均可见。
- 任务上下文：implement 3 条、check 3 条，格式校验通过。
- 规范链接：12 个 Markdown 文件、90 个相对链接，缺失链接 0、未入索引文件 0。
- 实时看板：`/api/task` 返回 `derivedStage: "commit"`。
