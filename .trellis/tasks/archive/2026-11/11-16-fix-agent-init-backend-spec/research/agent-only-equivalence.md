# Agent-only 配置等价性验证

## 环境

- Trellis CLI：`@mindfoldhq/trellis@0.6.17`
- Node：本机 PATH 中的 Node.js
- 临时目录：Node `fs.mkdtempSync()` 创建的隔离目录

## 方法

分别创建两个临时项目：

1. 完整路径执行：

   ```text
   trellis init -y --skip-existing -u probe-user --cursor --claude --codex
   ```

2. Agent-only 路径直接调用 Trellis 包导出的 `configurePlatform`，设置
   `skip` 写入模式，调用相同平台，并用 `initializeHashes` 维护 manifest。

对 `.cursor`、`.claude`、`.codex` 和共享 `.agents` 下全部文件计算 SHA-256，
再比较 `.template-hashes.json` 中平台相关键。

## 结果

- 平台文件差异：`0`
- 文件内容不一致：`0`
- 平台相关 manifest 键：完整路径 `112` 个，Agent-only 路径 `112` 个，完全一致
- Agent-only 临时目录：没有 `.trellis/spec/`
- 全平台一次性配置时 `pi` 触发已知 `EXDEV`，需要保留现有错误语义

## 结论

对已覆盖的三个代表平台，Agent-only 路径不会少写 Agent 文件，也不会破坏模板
哈希；它只跳过完整的项目初始化副作用。该结论用于支持客户端方案一，不替代对
全部 22 个平台的最终自动化回归。
