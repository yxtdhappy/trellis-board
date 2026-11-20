# 实施计划

> 状态：实现、Node 测试、Windows 真机 E2E 与 CI 构建均已完成。CI run
> `44694310603`（tag `v0.4.51`）通过 `cargo test`、打包与冒烟测试；本机无 Rust 工具链，
> `cargo fmt --check` / `cargo clippy` 仍未执行（CI 也未配置这两步）。任务尚未归档。

## 1. 新增内嵌补齐 helper

- [x] 新增 `packages/desktop/src-tauri/src/agent/agent_template_repair.mjs`。
- [x] 支持 `snapshot` / `repair` / `hash` 三种模式，参数与输出契约按 `design.md` 第 5 节。
- [x] 复用 Trellis 包的 `collectPlatformTemplates`、`resolveSupportedPython`、`initializeHashes`，
  不复制模板内容。
- [x] repair 只创建缺失文件，使用 `openSync(..., "wx")` 直写，不出现 `.tmp`/rename；路径必须
  位于 repoRoot 内；失败回滚本次创建文件。
- [x] `openSync` 成功后立即把目标纳入回滚列表，保证写入或 close 失败也不会留下半成品。
- [x] hash 只登记「本次缺失、现已存在且内容与模板一致」的路径。
- [x] 多个平台命中同一路径且内容不一致时 fail-closed，不静默覆盖。
- [x] 在 `trellis_cli.rs` 用 `include_str!("agent_template_repair.mjs")` 引入。

## 2. Rust 识别与执行层

- [x] 在 `packages/desktop/src-tauri/src/agent/trellis_cli.rs` 增加：
  - `REPAIR_PLATFORMS = ["pi", "omp"]`、`REPAIR_TIMEOUT = 30s`；
  - `selected_repair_platforms()`；
  - `repair_platforms_for_failure()`（EXDEV + 扩展路径签名，多选时返回全部所选 Pi/OMP）；
  - `repair_helper_args()`、`hash_helper_args()`；
  - `repair_failure()`、`retry_failure()`、通用 `trellis_failure()`；
  - `initialize_with_repair()`，覆盖 snapshot、首次 init、repair、单次 retry、hash 补偿。
- [x] `initialize_trellis()` 与 `initialize_agents()` 改为构造 `InitMode` 并调用共享函数；
  公开签名不变。
- [x] 移除 `trellis_agent_tool_flags()` 中 CLI 不支持的 `--pi-presence all`，只保留 `--pi`；
  更新 `maps_tool_ids_to_init_flags` 期望。`presenceMode: "all"` 只保留在客户端检测。
- [x] 保持 `finish_init()` 与 `cleanup_template_hashes()` 的现有语义；hash 补偿在 `finish_init()`
  之前执行。
- [x] 不修改 `node_modules`、`tauri.conf.json`、打包脚本或 UI。

## 3. 自动化测试

- [x] `trellis_cli/tests.rs`：
  - 平台识别：Pi、OMP、双选、非 EXDEV、无签名、目录存在但输出无路径；
  - helper 参数与模式；
  - 补齐失败与重试失败文案/details；
  - 内嵌 helper 包含 `openSync`/`"wx"`/`collectPlatformTemplates`，不含 `fs.renameSync`；
  - 现有 `finish_init` / hash 清理测试保持通过。
- [x] 新增 `packages/desktop/test/agent-template-repair.test.js`：
  - 用 fake Trellis 包执行 snapshot / repair / hash；
  - 已有文件内容不被覆盖；
  - 路径越界、绝对路径、盘符、ADS、NUL、空段/`.` 段、junction 越界均拒绝且不落盘；
  - repair 中途失败回滚本次创建文件；
  - hash 只登记内容与模板一致的缺失文件，非字符串条目跳过；
  - 多平台同路径不同内容 fail-closed。
- [x] 开发过程中只跑 Node 测试；Rust 编译/测试留到第 5 步统一执行。

## 4. Windows 真机 E2E（不构建 Rust）

- [x] 在 `D:\wit` 下创建临时 Git 仓库，先做一次 `.tmp` → `.ts` rename 探针，确认本机 DLP 行为仍可复现。
- [x] Agent-only：
  - 建 `.trellis/tasks/`；
  - 用真实 `node` + `node_modules/@mindfoldhq/trellis/bin/trellis.js` 执行内嵌
    `agent_only_init.mjs`（`pi`），确认首次失败于 `.pi/extensions/trellis/index.ts`；
  - 执行 helper `repair pi`，再次执行 Agent-only，确认成功；
  - 校验 `.pi/extensions/trellis/index.ts`、`.pi/settings.json`、无 `.tmp` 残留；
  - 对 `omp` 重复一次。
- [x] 完整 init：
  - 临时仓库不带 `.trellis`，执行
    `node <cli.js> init -y --skip-existing -u e2e --pi`，确认首次失败且没有
    `unknown option '--pi-presence'`；
  - 执行 helper `repair pi` 后重试，确认成功；hash 补偿补回两个 Pi 键。
- [x] 清理临时仓库；未触碰当前工作区的 `.pi` 半成品。
- [x] 证据记录：`research/exdev-reproduction.md`、`e2e-report.md`。

## 5. 最终检查（全部开发完成后一次编译）

- [ ] `cargo fmt --check`（在 `packages/desktop/src-tauri`）。—— **本机无 Rust 工具链，未执行；
  CI `windows.yml` 也未配置该步骤**。
- [ ] `cargo clippy --all-targets -- -D warnings`（同一目录）。—— **本机无 Rust 工具链，未执行；
  CI `windows.yml` 也未配置该步骤**。
- [x] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`。—— **CI run
  [`44694310603`](https://github.com/yxtdhappy/trellis-board/actions/runs/44694310603) 的
  `Rust unit tests` 通过**（tag `v0.4.51`）。
- [x] `node --test packages/desktop/test/agent-template-repair.test.js`：10/10 通过。
- [x] `yarn test`：660/662 通过、1 跳过、1 个无关服务端并行 flake；失败项单独复跑通过。
- [x] `rg -n '^mod tests \{' packages/desktop/src-tauri/src`：仅 5 个既有文件；本任务未新增内联测试。
- [x] `trellis_cli.rs` 667 行、`tests.rs` 410 行，均低于 1200 行上限。
- [x] `git diff --check`；特性提交 `b3089f2`、版本提交 `eb69d06` 与 tag `v0.4.51` 已推送到
  `origin/main`。任务元数据提交为 `3266ae0`。

### CI 构建与发布

- [x] CI run [`44694310603`](https://github.com/yxtdhappy/trellis-board/actions/runs/44694310603)
  （tag `v0.4.51`，7m7s）成功：Node/Server tests、`Rust unit tests`、desktop build、
  便携包与启动冒烟测试、Release 资产发布全部通过。
- [x] Release：[`v0.4.51`](https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.51)，
  资产 `TrellisBoard_0.4.51_x64-portable.zip`（4,322,722 bytes，sha256
  `22550735744a87bbb69d76d88e98b99ae92998c838dff537a7719a65e116c553`）。
- [ ] `cargo fmt --check` / `cargo clippy` 仍待补跑（本机无工具链，CI 未配置）。

## 6. 规格更新与收尾

- [x] 更新 `.trellis/spec/backend/desktop-agent-runtime.md`：记录 Pi/OMP EXDEV 补齐、直写例外、
  单次重试、snapshot/hash 补偿契约、30s helper 超时预算。
- [x] 核对 `tauri-commands` 场景索引：契约已写入 `desktop-agent-runtime.md`，无需新增独立场景。
- [x] 更新本任务 `implement.md` 勾选、写检查报告/E2E 证据。
- [ ] 走 `trellis:finish-work` 归档；提交前确认未混入无关脏改动（`11-20-test1/` 保持原状）。
  —— **待用户确认是否提交/归档；Rust 编译仍待补跑**。

## 风险与回滚点

- 风险：DLP 策略变化，直写 `.ts` 也被拒绝 → repair 失败返回明确错误，不重试；E2E 会暴露。
- 风险：Trellis 升级后 `collectPlatformTemplates`/`initializeHashes` 导出变化 → helper 显式校验
  模块存在，失败关闭；Node 测试固定 fake 包契约，真实 E2E 覆盖 0.6.17。
- 风险：snapshot 或 hash helper 失败 → 已成功的初始化不受影响，只是少登记部分模板哈希。
- 风险：同时选 Pi + OMP 时 repair 写入两者 → 只创建缺失文件，OMP 为纯模板平台，无自定义写入逻辑；
  同路径不同内容已 fail-closed。
- 回滚点 1：删除 helper 与 `initialize_with_repair`，恢复两个公开函数直接返回 `trellis_failure`。
- 回滚点 2：保留识别/重试但关闭 hash 补偿（snapshot 调用可删除）。
- 回滚点 3：只对 Pi 生效、去掉 OMP（不推荐；OMP 仍会复现同类失败）。