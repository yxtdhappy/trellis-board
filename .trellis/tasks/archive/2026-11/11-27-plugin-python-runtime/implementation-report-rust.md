# STEP 2 实施报告：Rust 自检 flag 与插件宿主注入

日期：2026-11-27
范围：`packages/desktop/src-tauri`（Web / server JS / `plugins/` 未改动）

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/desktop/src-tauri/src/agent/env/probe.rs` | `resolve_python` 的 flag 预检抽成 `probe_recorded_python`；新增纯函数 `classify_recorded_python` + `RecordedPythonProbe`；flag 文件可用但跑不出版本时 `set_python_runtime(None)`；`is_usable_file` 可见性 `pub(super)` → `pub(crate)` |
| `packages/desktop/src-tauri/src/agent/task_command.rs` | `recorded_python()` 改为 `recorded_python_from(&data_dir/client.json)`；新增 `recorded_python_from(document_path)`，用 `is_usable_file` 拒绝目录/0 字节文件 |
| `packages/desktop/src-tauri/src/plugin_host.rs` | 新增纯函数 `python_env_for_host(parent, recorded)`；`ensure_running` 启动宿主时按需注入 `TRELLIS_PYTHON` |
| `packages/desktop/src-tauri/src/agent/env/tests.rs` | 新增 3 个用例（决策分类 / 0 字节 flag 清空 / 执行失败 flag 清空） |
| `packages/desktop/src-tauri/src/agent/task_command/tests.rs` | 新增 1 个用例（`recorded_python_from` 拒绝 0 字节与目录，接受非空文件） |
| `packages/desktop/src-tauri/src/plugin_host/tests.rs` | 新增 2 个用例（父进程值优先 / 注入值来自 `client.json` 的绝对路径） |

## 2. 实现要点

### 2.1 启动自检 flag（`probe.rs`）

`classify_recorded_python(usable, version)` 是纯决策函数：

- `usable == false` → `Stale`（文件被删/0 字节）；
- `usable == true` 且 `version == None` → `Stale`（spawn/exec 失败，例如无执行权限、App Execution Alias 被绕过）；
- 版本 < 3.9 → `Outdated`（保留 flag，仅用于 `found_version` 文案）；
- 版本 ≥ 3.9 → `Ready`。

`probe_recorded_python(config)` 读取 flag、`is_usable_file` 预检、跑一次 `python -V`，`Stale` 时
`config.set_python_runtime(None)` 并返回 `None`；`Ready` / `Outdated` 返回对应的 `PythonStatus`。
`resolve_python` 对返回值只做「`ok` 立即返回，否则作为 `outdated` 继续探测」，与改动前语义一致，
唯一行为变化是「flag 可执行但执行失败」不再保留坏路径。

`is_usable_file` 从 `pub(super)` 放宽到 `pub(crate)`，让 `recorded_python_from` 复用同一套
「非空普通文件」规则（`agent/env.rs` 的 `pub use probe::*` 会以 `pub(crate)` 重导出），避免两处重复判定。

### 2.2 `recorded_python`（`task_command.rs`）

```rust
pub(crate) fn recorded_python() -> Option<String> {
    recorded_python_from(&crate::config::data_dir().join("client.json"))
}
```

`recorded_python_from(document_path)` 保留原有 BOM 处理与 `python_runtime` 解析，末行由
`Path::new(&flag.path).is_file()` 改为 `is_usable_file(...)`（文件、非目录、`len > 0`）。
`onboarding.rs:563` 与 `run_task_python` 的调用点不变。

### 2.3 宿主注入（`plugin_host.rs`）

`ensure_running` 在宿主命令参数装配完成后：

```rust
if let Some(python) = python_env_for_host(
    std::env::var_os("TRELLIS_PYTHON"),
    crate::agent::task_command::recorded_python(),
) {
    command.env("TRELLIS_PYTHON", python);
}
```

`python_env_for_host` 只在父进程没有 `TRELLIS_PYTHON`（`var_os` 为 `None`）时返回记录值；
父进程已设置时返回 `None`，不覆盖用户显式设置。注入值是 `recorded_python()` 原样返回的绝对路径
（`client.json` 里 `python_runtime.path` 由环境门写回 `executable.display().to_string()`）。

## 3. 与 design.md §6 的偏差

1. design §6.1 只要求「执行失败清空 flag」；实现额外把 flag 预检抽成 `probe_recorded_python`，
   以便对「清空」行为做真实文件单测（只测纯决策函数无法覆盖 `set_python_runtime(None)`）。
   对外行为与 design 一致。
2. design §6.2 的示例内联在 `ensure_running` 中，并建议辅助函数名 `recorded_python_env()`；
   实际命名为 `python_env_for_host(parent, recorded)`，返回 `Option<String>`，由调用方决定写哪个键。
   验收标准（父进程优先、注入记录值）不变。
3. `recorded_python_from(document_path)` 是新提取的 `pub(crate)` 辅助函数（任务书要求），
   `recorded_python()` 行为不变。
4. `is_usable_file` 可见性放宽为 `pub(crate)`：为复用 0 字节规则，属于最小必要改动，无行为变化。
   未新增依赖，未改 `client.json` 结构。

## 4. 验证命令与结果

环境说明：本机为 Linux，仓库默认构建桌面壳需要 GTK/WebKit 开发包。首次 `cargo test` 因缺少
`pkg-config` / `glib-2.0` / `gtk+-3.0` / `webkit2gtk-4.1` 失败（`glib-sys`/`gobject-sys`/`gio-sys`
自定义构建脚本报错）。用 `sudo apt-get install pkg-config libglib2.0-dev libgtk-3-dev
libwebkit2gtk-4.1-dev libdbus-1-dev` 补齐系统依赖后继续；仓库文件未因此改动。

```bash
# 1) 定向新用例（crate 目录）
cd packages/desktop/src-tauri && cargo test recorded_python
# → running 6 tests
#   agent::env::tests::recorded_python_probe_classifies_flag_state ... ok
#   agent::env::tests::recorded_python_flag_with_empty_file_is_cleared ... ok
#   agent::env::tests::recorded_python_flag_that_fails_to_run_is_cleared ... ok
#   agent::task_command::tests::recorded_python_requires_non_empty_file ... ok
#   plugin_host::tests::parent_trellis_python_wins_over_recorded_python ... ok
#   plugin_host::tests::recorded_python_path_is_injected_into_host ... ok
#   test result: ok. 6 passed; 0 failed; 450 filtered out

# 2) 全 rust scope（与 scripts/test.mjs 的 rust 命令一致）
yarn test --scope=rust
# → test result: FAILED. 448 passed; 8 failed; 0 ignored

# 3) 基线对照（git stash 暂存本步骤 6 个文件后重跑同一命令，随后 pop）
cd packages/desktop/src-tauri && cargo test --bin trellis-board-client
# → test result: FAILED. 442 passed; 8 failed; 0 ignored
```

结论：本步骤新增 6 个用例全部通过，总通过数 442 → 448；失败项与基线完全一致，均为
Windows-only 断言在 Linux 上不成立（`Path::new("C:\\...")` 的父目录/拼接语义、Windows 路径形式的
git remote 校验），不属于本步骤改动范围：

- `agent::env::tests::fallback_dirs_cover_version_manager_prefixes`
- `agent::env::tests::python_dirs_cover_common_install_roots`
- `agent::env::tests::status_paths_live_under_data_dir`
- `agent::env::tests::where_node_output_yields_parent_dirs`
- `agent::env::tests::where_python_output_yields_parent_dirs`
- `agent::onboarding::tests::commits_and_pushes_only_initialization_paths`
- `agent::onboarding::tests::reports_initial_push_state_for_missing_remote_branch`
- `agent::onboarding::tests::untracks_manifest_before_initial_commit`

格式检查（只针对本步骤文件；`cargo fmt --check` 在基线已有大量漂移，未整体重排）：

```bash
rustfmt --edition 2021 --check src/agent/env/probe.rs src/agent/env/tests.rs src/plugin_host.rs \
  src/plugin_host/tests.rs src/agent/task_command/tests.rs
# → 本步骤文件无 Diff（`assets.rs` / `task_command.rs:366` 等为既有漂移）
```

## 5. 新增用例覆盖

| 用例 | 覆盖点 |
| --- | --- |
| `recorded_python_probe_classifies_flag_state` | 不可用 / 执行失败 / 版本过低 / 可用 四类决策 |
| `recorded_python_flag_with_empty_file_is_cleared` | 0 字节 flag → 清空 `client.json` 的 `python_runtime` |
| `recorded_python_flag_that_fails_to_run_is_cleared` | 非空但不可执行的文件（spawn 失败）→ 清空 flag |
| `recorded_python_requires_non_empty_file` | `recorded_python_from` 拒绝 0 字节文件与目录，接受非空普通文件 |
| `parent_trellis_python_wins_over_recorded_python` | 父进程值优先、未设置时用记录值、都无则为 `None` |
| `recorded_python_path_is_injected_into_host` | 注入值等于 `client.json` 里记录的绝对路径；父进程设置时不注入 |
