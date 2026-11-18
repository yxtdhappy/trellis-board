# PRD：Rust 内联测试统一拆分 + env.rs 模块拆分 + 行数守卫规则

## 背景

`11-18-refactor-task-sync-module-split` 已把 `agent/task_sync.rs` 的 4688 行内联测试拆到 `task_sync/tests/`，但那是一次单文件处理，规则没有沉淀：

- 仓库里还有 23 个 Rust 文件把测试内联在业务文件尾部，业务体量被测试代码掩盖（`agent/env.rs` 1640 行里 227 行是测试；`agent/task_command.rs` 1378 行里 452 行是测试）。
- 代码文件没有行数约束，`task_sync.rs` 涨到 15798 行才被发现；不写规则就会重演。
- `agent/env.rs` 是现存最臃肿的模块：拆掉测试后仍有 1413 行，混合了常量/路径、运行时模型、探测解析、下载安装四类职责。

## 目标

1. 把 `packages/desktop/src-tauri/src` 下**全部 23 个**内联 `mod tests` 迁出到相邻测试文件，业务文件只保留声明。
2. 拆分 `agent/env.rs`（1413 行业务代码）为职责子模块。
3. 把"测试与业务代码必须分文件""文件行数上限""改动导致超限必须当场拆分"写成 desktop 层规格。

## 范围

### A. 内联测试外移（23 个文件）

| 文件（`src/` 下） | 现行数 | 测试块行数 | 拆分后 |
| --- | ---: | ---: | ---: |
| `agent/association.rs` | 570 | 179 | 391 |
| `agent/control.rs` | 257 | 91 | 166 |
| `agent/credential.rs` | 201 | 16 | 185 |
| `agent/detach.rs` | 316 | 88 | 228 |
| `agent/device.rs` | 1406 | 323 | 1083 |
| `agent/env.rs` | 1640 | 227 | 1413 → 见 B |
| `agent/git.rs` | 1160 | 203 | 957 |
| `agent/http.rs` | 446 | 85 | 361 |
| `agent/onboarding.rs` | 1330 | 332 | 998 |
| `agent/process.rs` | 257 | 42 | 215 |
| `agent/protocol.rs` | 812 | 124 | 688 |
| `agent/runtime.rs` | 877 | 154 | 723 |
| `agent/state_events.rs` | 89 | 24 | 65 |
| `agent/store.rs` | 895 | 99 | 796 |
| `agent/task_command.rs` | 1378 | 452 | 926 |
| `agent/task_control.rs` | 893 | 230 | 663 |
| `agent/trellis_cli.rs` | 476 | 133 | 343 |
| `appearance.rs` | 107 | 33 | 74 |
| `config.rs` | 161 | 44 | 117 |
| `logging.rs` | 130 | 35 | 95 |
| `main.rs` | 1147 | 78 | 1069 |
| `navigation.rs` | 106 | 39 | 67 |
| `runtime_commands.rs` | 78 | 9 | 69 |

合计 14600 行源码中 2908 行（约 20%）是测试。

### B. `agent/env.rs` 模块拆分

| 目标文件 | 内容 | 预估行数 |
| --- | --- | ---: |
| `agent/env.rs`（根） | 版本/URL/错误码常量、`runtime_dir`/`node_exe_path`/`npm_global_dir`/`trellis_cli_path`/`download_dir`、`RuntimeState` 与各 Status/Flag 模型、`ClientConfigLike`、`parse_version`/`parse_python_version`/`is_version_at_least`/`verify_hash`/`hex` | ≈300 |
| `agent/env/probe.rs` | 路径发现（`path_dirs`/`fallback_dirs`/`probe_dirs`/`find_in_path`/`shell_exe`/`read_package_version`）、node/trellis/python 探测与解析（`node_version_at`/`trellis_cli_in`/`trellis_from_cmd`/`resolve_node`/`resolve_trellis`/`py_launcher_target`/`resolve_python`）、`check` | ≈470 |
| `agent/env/install.rs` | `install`/`install_node`/`download_file`/`download_node`/`install_python`/`install_trellis`/`run_with_heartbeat`/`extract_node`/`node_entry_allowed`/`cleanup_partial`/`installed_python`/`write_runtime_flags` | ≈640 |
| `agent/env/tests.rs` | 原内联测试块 | ≈227 |

## 需求

**R1 测试布局**：业务文件 `foo.rs` 的测试搬到 `foo/tests.rs`（与 `foo.rs` 同目录的 `foo/` 子目录）；测试模块超过 1200 行时改为 `foo/tests/` 目录 + 按主题拆分文件（沿用 `task_sync/tests/` 的方式）。本轮所有测试块都 ≤ 452 行，因此全部落到单个 `foo/tests.rs`。

**R2 声明**：业务文件末尾只保留 `#[cfg(test)] mod tests;`。原测试模块的属性必须原样保留——`agent/credential.rs` 是 `#[cfg(all(test, windows))]`，不能简化成 `#[cfg(test)]`。

**R3 crate 根特例**：`src/main.rs` 是 crate 根，`mod tests;` 会解析到 `src/tests.rs`，与"测试文件归属其所有者"规则冲突。改用 `#[cfg(test)] #[path = "main/tests.rs"] mod tests;`，测试落在 `src/main/tests.rs`。

**R4 零语义改动**：测试代码逐字节搬移，只做两处形式调整：整块缩进回退 4 空格（模块体变成文件顶层）、保留原有内联 `use`（`foo::tests` 的 `super` 仍是 `foo`）。不改测试名、断言、条件编译、`#[ignore]`、fixture。

**R5 env.rs 拆分契约**：子模块 item 统一 `pub(super)`，根文件用 `pub use` 重导出 `check`/`install`/`RuntimeStatus`/`RuntimeInstallResult`/`ClientConfigLike`/`RuntimeState` 等既有公开符号。外部调用方零改动——`main.rs:360,369`、`runtime_commands.rs:4,39,51`、`agent_service.rs:19`、`task_command.rs:760` 的路径与名称全部保持。跨子模块互相调用的私有项同样放宽为 `pub(super)`；子模块首行 `use super::*;`。

**R6 规格（含增量守卫）**：在 `.trellis/spec/desktop/tauri-commands/index.md` 写入可执行规则：

- 测试禁止内联在业务文件，一律 `foo/tests.rs` / `foo/tests/`。
- 行数上限：业务文件与测试文件均 ≤1200 行，模块根文件 ≤500 行。
- **增量守卫**：任何后续改动（新功能、修 bug、补测试）如果使某个 Rust 文件超过上限，必须在**同一次改动内**完成拆分并提交；不允许"先超着，下次再说"。超限文件不得新增行，除非同一提交把它拆到限内。
- 验证矩阵：`cargo test` 全绿、测试名集合与基线一致、`cargo check --all-targets` 告警数不增。

## 验收标准

1. `rg -n "^\s*mod tests \{" packages/desktop/src-tauri/src` 无命中（全部为 `mod tests;`）；`agent/credential.rs` 保留 `all(test, windows)` 条件。
2. `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 232 passed / 0 failed。
3. 测试名集合与基线 `research/baseline-tests.txt` 逐项比对，差集为空（含 DPAPI 那 1 个条件测试）。
4. `cargo check --all-targets` 告警数与基线一致（6 条），无新增 unused import / dead code。
5. 行内容多重集等价：新测试文件行（回退 4 空格后）与原测试块行相同；业务文件只少了测试块，新增只有 `mod tests;` 声明与 `#[path]` 属性。
6. `agent/env.rs` ≤500 行，`agent/env/probe.rs`、`agent/env/install.rs`、`agent/env/tests.rs` 均 ≤1200 行；`git diff` 只涉及 `agent/env.rs` 与 `agent/env/`，外部调用方文件零改动。
7. spec 含 R6 全部四条，且"增量守卫"用一句话能判定（超限即拆，不可延后）。
8. 不跑 `cargo fmt`（仓库无 rustfmt 配置），不改 Cargo.toml，不新增依赖，不改业务逻辑。

## 非目标

- `packages/web`、`packages/server`、`packages/shared`：非 Rust，不在范围。
- `build.rs`、`agent_service.rs`、已拆完的 `agent/task_sync/*`：无内联测试、未超限，不动。
- 不为"未来可能超限"的文件提前拆分（YAGNI）；守卫规则只对**已超限**生效。

## 风险

| 风险 | 处置 |
| --- | --- |
| 测试模块引用业务文件私有 item | `foo/tests.rs` 是 `foo::tests`，`use super::*;` 仍可见 `foo` 私有项；缺 `use super::*;` 的文件保留其现有 import |
| 测试模块内 `#[cfg(test)]` 辅助 fn 被业务代码引用 | 只搬 `mod tests` 块；块外的 `#[cfg(test)]` item（`credential.rs:93` 的 `self_test`、`task_sync/ownership.rs` 的 helper）留在业务文件 |
| env 拆分后跨子模块私有项不可见 | 逐项放宽为 `pub(super)`；编译器报错即定位，不做大范围可见性放开 |
| 23 个文件同时改动难以 review | 机械 codemod + 多重集等价校验；按 `src/` 分组顺序提交 |
| 行数表与实际差 1–2 行 | 以脚本实测为准，表内数字只用于评估收益 |