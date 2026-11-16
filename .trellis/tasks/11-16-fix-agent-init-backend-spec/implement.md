# 实施计划

## 前置条件

- 用户已批准最终规划摘要。
- 当前任务从 `planning` 切换到 `in_progress` 后再修改产品代码。
- 保留工作区已有的 `.gitignore`、`.trellis/.template-hashes.json` 和未跟踪 spec
  目录改动，不纳入本次提交。

## 实施步骤

- [x] 在 `apps/desktop/src-tauri/src/agent/` 增加可嵌入的 Agent-only JS helper。
- [x] 在 `trellis_cli.rs` 增加 `initialize_agents`，通过 stdin 执行 helper。
- [x] 复用现有失败映射，补齐 Agent-only 文案和 Pi EXDEV 识别。
- [x] 在 `onboarding.rs` 增加纯初始化模式判定，按模式选择完整 init 或 Agent-only。
- [x] 编写 Rust 单测覆盖三种模式、helper 参数和源代码契约。
- [x] 用临时目录再次验证 Agent-only 不生成 `.trellis/spec`，并验证
  `cursor`、`claude-code`、`codex` 的文件集合。
- [x] 更新桌面 Agent 运行时 spec，记录“已有任务树补 Agent 不走完整 init”的契约。

## 验证命令

最终开发完成后只执行一次编译验证，期间先跑不改变代码的静态检查：

```powershell
node .trellis/tasks/11-16-fix-agent-init-backend-spec/research/agent-configurator-equivalence-probe.mjs <trellis.js>
cargo fmt --check
npm test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

如果项目现有命令与上述命令不一致，以仓库实际脚本为准，并在检查报告中记录。

## 风险与回滚

- 方案依赖 Trellis npm 包的内部模块路径；通过文件存在性检查和失败关闭限制影响。
- 平台配置失败时可能保留已写入的部分 Agent 文件，行为与现有完整 init 一致；
  不通过删除或回滚用户文件来掩盖失败。
- 若 Agent-only 验证失败，回滚本次新增 helper 和 onboarding 分支，保留原始完整
  初始化路径。
