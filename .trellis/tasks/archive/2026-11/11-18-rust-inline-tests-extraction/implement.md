# 实施记录：Rust 内联测试外移 + env.rs 拆分

## 变更范围

| 类别 | 文件 |
| --- | --- |
| 测试外移（23） | `src/{appearance,config,logging,main,navigation,runtime_commands}.rs`、`src/agent/{association,control,credential,detach,device,env,git,http,onboarding,process,protocol,runtime,state_events,store,task_command,task_control,trellis_cli}.rs` → 同名 `foo/tests.rs`，业务文件尾只留 `#[cfg(test)] mod tests;` |
| env 拆分 | `src/agent/env.rs`（1414 → 312）+ `src/agent/env/probe.rs` 469 + `src/agent/env/install.rs` 643 + `src/agent/env/tests.rs` 225 |
| 规格 | `.trellis/spec/desktop/tauri-commands/index.md`：场景改名「Rust 模块的目录化拆分与测试外移」，§1 扩到全 `src/**`，§2 新增 `foo/tests.rs` 默认布局，新增 §6 增量守卫 |

## 关键决策

- 用列 0 的 `}` 定位测试块结束（文件末项），不用括号计数——字符串感知计数器在 raw string 上会误判。
- `src/main.rs` 无同名目录可用，改用 `#[cfg(test)] #[path = "main/tests.rs"] mod tests;`。
- `src/agent/credential.rs` 的属性是 `#[cfg(all(test, windows))]`，原样保留。
- env 拆分的子模块用 `use super::*;`，根文件 `pub use install::*; pub use probe::*;` 重导出；搬移的私有 fn/struct 加 `pub(super)`，外部 `crate::agent::env::X` 路径零改动。
- 测试外移只做 4 空格缩进回退，测试体零改动。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| `cargo test --all-targets` | 232 passed / 0 failed（与基线一致） |
| `cargo check --all-targets` | 6 条 warning，与基线逐条相同（`handoff` 未读赋值 ×3、`as_str` 未使用、多余 `mut` ×2） |
| `rg -n '^mod tests \{' packages/desktop/src-tauri/src` | 无输出 |
| 内容等价 A | 23 个业务文件 = HEAD 前缀（逐行相同）+ 属性/声明行 |
| 内容等价 B | 23 个 `foo/tests.rs` = HEAD 中 `mod tests {` body 回退 4 空格（逐行相同） |
| 内容等价 C | env 四文件多重集 vs HEAD：缺失仅 `}` 与 `mod tests {`，多出仅 `mod tests;` |
| 最大文件 | `agent/task_sync/handoff.rs` 1122、`agent/task_sync/tests/cursor_state.rs` 1104、`agent/device.rs` 1084、`src/main.rs` 1071（均 ≤1200） |

## 未做

- 未跑 `cargo fmt`（仓库无 rustfmt 配置）。
- 未改动任何业务逻辑、未新增依赖、未改 Cargo.toml。
