# 客户端 Trellis 初始化后清理 __pycache__ 模板哈希

## Goal

Trellis CLI 的 `initializeHashes` 会递归遍历 `.trellis/`，而其 `EXCLUDE_FROM_HASH` 未排除
`__pycache__/` 与 `*.pyc`。客户端接入项目、初始化 Agent 时会调用该函数（Agent-only 与完整 init
两条路径），导致本机 Python 字节码缓存的哈希被写入受版本管理的 `.trellis/.template-hashes.json`，
污染模板清单。客户端需要在初始化完成后清理这些缓存条目，只保留真实模板文件哈希。

## Requirements

1. 完整 init（`trellis init ...`）与 Agent-only init（`agent_only_init.mjs`）完成后，
   `.trellis/.template-hashes.json` 中不得出现路径包含 `__pycache__/` 或以 `.pyc` 结尾的键。
2. 清理只删除缓存键，不得修改其他模板哈希，也不得删除或改动 `.pyc` 文件本身（其由 gitignore 管理）。
3. 清理失败不得使初始化失败；初始化结果仍以 Trellis 命令的退出码与原有错误映射为准。
4. 清理必须在 manifest 落盘之后执行，避免与 `initializeHashes` 的保存顺序竞争。
5. 不修改 Trellis 上游包；兜底逻辑放在客户端侧。上游 `EXCLUDE_FROM_HASH` 修复另行处理。

## Acceptance Criteria

- [x] 在存在 `__pycache__/*.pyc` 的仓库执行 Agent-only init 后，清单不含 pycache 键，其余键保持不变。
      （2026-11-19 真机 `v0.4.44`：原 188 个键全部保留且值不变，探针键删除，结果无 pycache/pyc 键；详见 `e2e-report.md`）
- [ ] 完整 init 路径同样生效；若某路径确认不会产生 pycache 键，需加断言防回归。
      （已有共用清理入口测试与 GitHub Rust 测试，但本轮未执行完整 init 真机路径）
- [x] 单元测试：构造含 pycache 键的 manifest，执行清理后仅删除目标键，其余键逐字节保留。
      （GitHub Actions Rust unit tests 通过，run `44420836007`）
- [x] 初始化成功/失败时行为不回归；清理错误被降级处理，不覆盖原有错误上报。
      （Rust unit tests 与真机 Agent-only init 均通过）
- [x] 在 `.trellis/spec/desktop/` 记录该兜底行为与触发路径。

## Constraints

- 只改 desktop 客户端（Rust 或内嵌 helper），不改 `.trellis/scripts` 下由 Trellis 模板管理的 Python 脚本。
- 保持现有初始化超时、输出上限、错误码与错误消息映射。
- 清单键为 POSIX 路径，兼容 Windows/Linux。
- 保留 `initialize_agents` 的 `merge: true` 语义：只清理缓存键，不重建或丢弃其他记录。

## Related

- `packages/desktop/src-tauri/src/agent/onboarding.rs`（AgentsOnly / FullInit 分支）
- `packages/desktop/src-tauri/src/agent/agent_only_init.mjs`（调用 `initializeHashes`）
- `packages/desktop/src-tauri/src/agent/trellis_cli.rs`（初始化命令与超时）
- Trellis CLI `dist/utils/template-hash.js`（`initializeHashes` / `EXCLUDE_FROM_HASH`）

## Out of Scope

- 向 `@mindfoldhq/trellis` 上游提交排除规则修复（可另建任务/issue）。
- 清理历史提交中已经存在的 pycache 键（本仓库已手工清理）。
