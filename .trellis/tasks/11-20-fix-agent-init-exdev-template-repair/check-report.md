# 检查报告（trellis-check）

日期：2026-11-20

## 审查范围

- `packages/desktop/src-tauri/src/agent/agent_template_repair.mjs`（新增，357 行）
- `packages/desktop/src-tauri/src/agent/trellis_cli.rs`（667 行）
- `packages/desktop/src-tauri/src/agent/trellis_cli/tests.rs`（410 行）
- `packages/desktop/test/agent-template-repair.test.js`（新增）
- `.trellis/spec/backend/desktop-agent-runtime.md`
- 对照 `prd.md`、`design.md`、`implement.md`、`check.jsonl` 列出的规范、
  `research/exdev-reproduction.md`、`e2e-report.md`

影响面（L1-L5）：

- L1：helper 自身（路径校验、直写、回滚、snapshot/hash）。
- L2：`trellis_cli.rs` 编排（识别、补齐、单次重试、错误映射、超时）。
- L3：调用方 `agent/onboarding.rs` 的 `initialize_trellis` / `initialize_agents`
  签名与行为不变，未改调用方代码。
- L4：规格/测试/打包；未改 `node_modules`、`package.json`、`tauri.conf.json`、
  打包脚本、UI。
- L5：服务端、Web 前端、`shared/trellis-agent-tools.js` 均未触碰；
  既有 `.trellis/tasks/11-20-test1/` 保持原状。

## 结论

实现与设计一致：R1 识别（EXDEV + pi/omp 选择 + 正/反斜杠与目录签名）、R2 直写补齐、
R3 单次重试、R4 双路径共用、R5 多平台一次补齐、R6 哈希补偿内容闸门、R7 内嵌 helper、
R8 测试与真机 E2E、R9 移除 `--pi-presence` 均已核对。新增 details 字段
（`exitCode`/`agentTools`/`repairPlatforms`/`repairFailed`/`retryFailed`）不含本机绝对路径；
错误消息经 `agent_service::message → safe_error_message` 脱敏。

独立交叉验证 E2E 证据（只读临时仓库）：

- 全量 init 仓库 manifest 41 键，含本次补齐的 2 个 Pi 键；其中 6 个 `__pycache__` 键是
  手工 E2E 未走 Rust `finish_init()` 清理，Rust 流程会删除。
- Agent-only Pi 仓库 manifest 仅 2 个 Pi 键；`.pi` 下无 `*.tmp`。
- 真实 0.6.17 包 `collectPlatformTemplates`：pi 51 项、omp 49 项、重叠 0，与 E2E 快照计数一致。

## 本次检查发现并修复

1. 新 Node 测试文件不符合仓库 oxfmt 格式（多余换行、缺文件末尾换行）→ 已用
   `npx oxfmt` 格式化，`oxfmt --check` 通过。
2. 规格第 2 节超时预算未登记新增 helper 预算 → 补充
   `Pi/OMP 模板补齐 helper（snapshot / repair / hash）各 60s`。
3. 规格第 6 节把补齐失败文案写成固定 `Pi/OMP 模板补齐失败`，与实现按平台返回
   （`Pi` / `OMP` / `Pi/OMP`）不一致 → 已改为按平台描述。
4. 测试缺口，已补 3 个用例并扩充 1 个：
   - junction/symlink 父目录解析到仓库外时必须失败且不写出仓库（`模板路径越界`）；
   - 绝对路径、盘符、ADS、NUL、反斜杠、空段、`.` 段拒绝且不落盘；
   - 重复平台、未知平台在触碰仓库前拒绝；
   - hash 输入含非字符串条目时跳过而非崩溃。

## 未修复（原因）

- **Rust 工具链缺失**：本机无 `cargo`/`rustc`/`rustup`，未执行、也不能声称通过
  `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`。
  已逐行核对类型推导、借用、match ergonomics、rustfmt 风格（对照仓库既有 rustfmt
  结果与本地其他 Rust 工程），最终以 CI 编译为准。
- 写/关闭失败的自动注入无法在不改生产代码的前提下完成；现由「`openSync` 成功后立即
  登记、写/关闭失败即回滚」的代码顺序与 traversal 回滚测试间接覆盖。
- 仓库既有 5 个文件仍有内联 `mod tests {`（`update/package.rs`、`update/manifest.rs`、
  `worktree/{discovery,registry,mod}.rs`），非本次改动引入，按最小改动原则未处理。
- 全量 `yarn test` 偶发与本次无关的服务端并行 flake（一次
  `archive-snapshot` 临时目录 EPERM，一次 `team-release.test.js` 异步收尾
  “database is not open”；单独复跑均通过），未改服务端代码。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --check packages/desktop/src-tauri/src/agent/agent_template_repair.mjs` | 通过 |
| `npx oxfmt --check <helper + 新测试>` | 通过 |
| `node --test packages/desktop/test/agent-template-repair.test.js` | 10/10 通过（检查后新增冲突保护用例） |
| `yarn test` | 660/662 通过（1 跳过），1 个既有并行 flake（见上） |
| `git diff --check` | 通过 |
| `rg -n '^mod tests \{' packages/desktop/src-tauri/src` | 仅命中 5 个既有文件 |
| 行数上限 | `trellis_cli.rs` 667、`tests.rs` 410、helper 357，均 < 1200 |
| Rust 三项检查 | 未执行（本机无工具链） |

## 残余风险

1. Rust 代码未在本机编译/测试；CI 是首道真实编译，建议同时执行任务要求的
   Pi/OMP 快速初始化验收。
2. 最坏超时预算：原为 snapshot 60s + init 210s + repair 60s + retry 210s + hash 60s = 600s；
   主会话已将 `REPAIR_TIMEOUT` 收紧到 30s，最坏 510s，低于 initialize-project 的 600s 预算。
3. 若未来 Trellis 版本让 pi/omp 模板出现「同一路径不同内容」，原实现会静默取后一个平台内容；
   主会话已在 helper 增加 fail-closed 冲突保护（同路径不同内容直接失败），并补 Node 用例。
   0.6.17 实测两平台模板零重叠，当前不触发。

## 主会话后续处理（检查后）

- `REPAIR_TIMEOUT` 由 60s 改为 30s；`design.md`、`implement.md` 与本规格第 2 节已同步。
- helper 的 `collectPlatformTemplates` 增加多平台同路径不同内容的 fail-closed 保护；
  `node --test packages/desktop/test/agent-template-repair.test.js` 10/10 通过。
- Rust 工具链仍缺失，Rust 编译/测试未执行，需 CI 或具备 Rust stable MSVC 的环境补跑。