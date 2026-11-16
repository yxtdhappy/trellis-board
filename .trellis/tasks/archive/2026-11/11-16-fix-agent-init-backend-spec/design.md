# 技术设计

## 1. 目标与边界

在 `apps/desktop` 内把初始化拆成两条路径：

- 缺少 `.trellis` 或 `.trellis/tasks`：继续执行原有完整 `trellis init`。
- 已有 `.trellis/tasks` 且只缺所选 Agent：执行 Agent-only 配置。

本次不修改 Trellis CLI 的项目类型检测，也不修改目标项目的 `package.json` 或
`express` 依赖。现有前端/后端 spec 类型纠偏属于上游 CLI 的后续工作。

## 2. 当前根因与行为

`initialize_project` 当前把 `tools_missing` 和缺少 Trellis 任务树合并到同一个
完整初始化分支：[onboarding.rs](/D:/wit/trellis-board/apps/desktop/src-tauri/src/agent/onboarding.rs:274)。
完整初始化最终由 `trellis_cli` 执行：

```text
node <trellis.js> init -y --skip-existing -u <developer> <agent flags>
```

CLI 对 `mdp-management-web` 的 `vue` 与 `devDependencies.express` 判定为
fullstack，因此新写了 backend spec。Agent-only 路径必须跳过这一步。

## 3. 行为切换

在 `onboarding.rs` 内增加一个纯判定函数，避免把分支条件散落在异步流程中：

```text
!has_trellis || !has_tasks  -> FullInit
has_trellis && has_tasks
  && tools_missing          -> AgentsOnly
otherwise                   -> None
```

`initialize_project` 按判定结果调用：

- `FullInit`：保留 `trellis_cli::initialize_trellis`。
- `AgentsOnly`：调用新增的 `trellis_cli::initialize_agents`。
- `None`：只重新 inspect，不写文件。

这样不会改变首次初始化、缺失任务树恢复和已完整初始化项目的现有行为。

## 4. Agent-only 执行器

### 4.1 复用 Trellis 包内配置器

完整 init 的 Agent 文件也是由包内 `configurePlatform` 生成。Agent-only 执行器
复用同一个函数，不复制模板，也不手写 Agent 文件：

```text
dist/commands/init.js       -> resolveSupportedPython()
dist/configurators/index.js -> PLATFORM_IDS + configurePlatform
dist/utils/file-writer.js   -> setWriteMode("skip") + 写入记录
dist/utils/template-hash.js -> initializeHashes(trackedPaths, merge)
```

执行顺序：

1. 从 CLI 的 `bin/trellis.js` 推导 npm 包根目录。
2. 检查上述模块是否存在；不存在则失败，不回退完整 init。
3. 使用 `resolveSupportedPython()`，确保模板占位符和完整 init 一致。
4. 设置 `TRELLIS_QUIET=1`，避免 Codex hooks 提示污染客户端结果。
5. 按 `PLATFORM_IDS` 的注册顺序过滤所选 Agent，和完整 init 的显式工具顺序一致。
6. `setWriteMode("skip")`，确保已有用户文件不被覆盖。
7. 逐个调用 `configurePlatform(repo, { withStatusline: false })`。
8. 停止写入记录并用 `initializeHashes(..., { merge: true })` 更新 manifest。

### 4.2 进程调用方式

把 JS helper 作为 Rust 字符串资源通过 `include_str!` 编入单 exe，使用
`node --input-type=module -` 从 stdin 执行，不向项目或用户主目录写临时 helper。

入参：

```text
<cli.js 路径> <repo 路径> <platform-id...>
```

这样可保持现有单 exe 分发方式，不引入 sidecar、资源目录或新的 npm 依赖。

## 5. 完整性与错误契约

- Agent 文件完整性以完整 init 的同一 `configurePlatform` 函数保证。
- 已有文件遵循 `skip` 模式，不会被覆盖。
- `.template-hashes.json` 使用和完整 init 相同的 `initializeHashes` 逻辑维护。
- Agent-only 分支只写所选 Agent 文件及 manifest，不写 spec、workflow、任务或根文件。
- 包模块缺失、平台 ID 未识别、Python 检测失败或平台配置失败都返回错误；
  不静默退回完整 init。
- `pi` 的 EXDEV 继续映射为现有“Pi 模板补齐失败”文案。

## 6. 接口与兼容性

- `TrellisRuntime`、`ProjectInspection`、Tauri 命令参数和 Web 端返回结构不变。
- `initialize_trellis` 的完整 init 行为不变。
- 新增内部函数 `trellis_cli::initialize_agents`，只由 onboarding 调用。
- 远程 Board 仍不能提交本地 `repoPath`；路径来源保持 approved binding 或
  pending project。

## 7. 不在本次范围

- 修复上游 `project-detector` 对 `devDependencies.express` 的 fullstack 误判。
- 新增公开的 `trellis init --agents-only` CLI 命令。
- 修改前端 Agent 选择 UI 或远程 Board API。
- 迁移历史 `.trellis/spec/backend` 文件或修改用户手工 spec。

## 8. 验证策略

- 单元测试覆盖三种分支：完整初始化、Agent-only、无动作。
- 测试 Agent-only helper 的固定入口和参数拼接；源码中不得出现
  `.trellis/spec` 写入路径。
- 保留研究探针对照：完整 init 与 Agent-only 对 `cursor`、`claude-code`、
  `codex` 的平台文件内容和 manifest 键一致。
- 最终执行一次 Rust 编译验证、相关 Rust 测试和 Node 测试；不在开发过程中反复构建。
