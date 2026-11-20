# EXDEV 修复 E2E 报告（2026-11-20）

## 范围

本机 Windows 11 + 企业 DLP/加密客户端，Node `v24.21.0`，真实
`@mindfoldhq/trellis@0.6.17`。使用临时 Git 仓库验证，不修改当前工作区项目文件。

> 限制：本机没有 Rust 工具链（`cargo`/`rustc`/`rustup` 均不存在），因此未构建桌面客户端，
> 也未执行 Rust 层 `initialize_with_repair` 的编译后 E2E。下面按 Rust 流程的实际顺序手工执行
> 同一组 helper / CLI 命令，覆盖 DLP 行为、补齐、重试和哈希补偿；Rust 侧由单测和 CI 覆盖。

## 1. 环境复现

- 临时仓库同目录探针：Node `.tmp` → `.ts` = `EXDEV`；Node 直接写 `.ts` = 成功。
- 已有 `.trellis/tasks` 的仓库执行 Pi Agent-only 初始化：
  - 退出码 1；
  - stderr 精确命中 `writeFileAtomic → writeFile → writeTemplateMap`，目标
    `.pi/extensions/trellis/index.ts`；
  - 失败后 `.pi/prompts/*.md`、`.pi/agents/*.md` 已存在，`.pi/extensions/trellis/` 为空，
    `.pi/settings.json` 不存在。
- 证据详见 `research/exdev-reproduction.md`。

## 2. Agent-only Pi 恢复

仓库：`D:\wit\trellis-exdev-e2e-1795156576`

| 步骤 | 结果 |
| --- | --- |
| `snapshot pi` | `missing=[".pi/extensions/trellis/index.ts",".pi/settings.json"]`，`existing` 49 项 |
| `repair pi` | `created` 2 项，`skipped=49` |
| Agent-only 重试 | 退出码 0 |
| 文件校验 | `index.ts`、`settings.json` 存在；`.pi` 下无 `*.tmp` |
| `hash` | `hashed` 2 项；`.template-hashes.json` 从 0 个 Pi 键变为两个 Pi 键均存在 |

## 3. Agent-only OMP 恢复

仓库：`D:\wit\trellis-omp-e2e-1795157503`

| 步骤 | 结果 |
| --- | --- |
| 首次 OMP 初始化 | 退出码 1，EXDEV 命中 `.omp/extensions/trellis/index.ts` |
| `snapshot omp` | `missing=[".omp/extensions/trellis/index.ts"]`，其余 48 项已存在 |
| `repair omp` | `created` 1 项，`skipped=48` |
| 重试 | 退出码 0 |
| 文件校验 | `.omp/extensions/trellis/index.ts` 存在；无 `*.tmp` |

## 4. 完整 init Pi 恢复

仓库：`D:\wit\trellis-full-e2e-1795157519`（初始无 `.trellis`）

| 步骤 | 结果 |
| --- | --- |
| `trellis init -y --skip-existing -u e2e --pi` 首次 | 退出码 1，EXDEV 命中 `.pi/extensions/trellis/index.ts` |
| `snapshot pi` | 缺失 `index.ts` + `settings.json` |
| `repair pi` | `created` 2 项，`skipped=49` |
| 相同参数重试 | 退出码 0，输出 `Created AGENTS.md`、`Tracking 33 template files for updates` |
| 重试后 manifest | 33 个键，不含两个补齐文件（符合 `skip-existing` 语义） |
| `hash` 补偿 | `hashed` 2 项；manifest 变为 41 个键，两个 Pi 键均存在 |
| `.tmp` 残留 | 无 |

> 41 个键里有 6 个 `__pycache__` 键，是手工 E2E 未走 Rust `finish_init()` 清理导致的；
> 真实 Rust 流程会在补齐/重试成功后清理这些键，不影响两个 Pi 键的补偿结果。

## 5. `--pi-presence all` 阻塞确认

仓库：`D:\wit\trellis-flag-e2e-1795157543`

```text
node node_modules/@mindfoldhq/trellis/bin/trellis.js init -y --skip-existing -u e2e --pi --pi-presence all
error: unknown option '--pi-presence'
exit=1
```

Trellis 0.6.17 的 `init --help` 也没有该选项；旧 JS `trellisAgentToolFlags()` 只返回 `flag`。
修复后 `trellis_agent_tool_flags()` 只输出 `--pi`。

## 6. 自动化测试

| 检查 | 结果 |
| --- | --- |
| `node --check agent_template_repair.mjs` | 通过 |
| `node --test packages/desktop/test/agent-template-repair.test.js` | 10/10 通过（新增冲突保护用例后） |
| `yarn test` | 660/662 通过（1 跳过），另有与本任务无关的服务端并行 flake；失败项单独复跑通过 |

## 7. 未完成项

- 未在本机编译/运行 Rust：没有 `cargo`/`rustc`/`rustup`。需在 CI 或具备 Rust stable MSVC 的机器上执行
  `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、
  `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`，并建议在打包后的客户端上点一次
  Pi/OMP 快速初始化。
- 临时 E2E 仓库已在归档前删除；证据保留在本报告与 `check-report.md`。