# 运行时环境检测收口 — Implementation

## 1. 旧键直接忽略

文件：

- `packages/desktop/src-tauri/src/runtime_commands.rs`

步骤：

1. `config::load()` 不做任何旧键归一化，保持 direct serde；只含 `schema_version` 的文件继续返回 `Ok(None)`。
2. 删除 `runtime_commands.rs::normalize_schema_key` 及其调用；`runtime_status` 仍设置 `document["schemaVersion"]`。
3. 不新增旧键兼容测试，不恢复 serde alias。

验收：`runtime_commands` 中不存在 `schema_version` 处理逻辑；旧文件按现有失败路径处理。

## 2. 延迟 fresh 探测

文件：

- `packages/desktop/src-tauri/src/agent/env/probe.rs`
- `packages/desktop/src-tauri/src/agent/env/install.rs`

步骤：

1. 在 `probe.rs` 增加 `pub(super) async fn resolve_runtime(data_dir, config) -> (NodeStatus, TrellisStatus, Vec<PathBuf>, bool)`：
   - 先以空目录解析 Node/Trellis；
   - 两者都 ok 时返回空 `dirs`；
   - 否则 `probe_dirs_fresh().await` 一次，重新解析并返回 `dirs`。
2. `check` 改用 `resolve_runtime`，再调用 `resolve_python`。
3. `install` 改用 `resolve_runtime`；仅当 `plan.install_trellis && !probed` 时补一次 `probe_dirs_fresh()`。
4. 把同一份 `dirs` 传给 `node_has_npm` 和 `install_trellis`；`install_trellis` 内部删除重复探测。

验收：flag 均有效时 `runtime_status` 不调用 `probe_dirs_fresh`；需要安装时最多探测一次。

## 3. Node 候选顺序与来源

文件：`packages/desktop/src-tauri/src/agent/env/probe.rs`

步骤：

1. `probe_dirs_fresh()` 改为 `where_node_dirs_fresh()` 结果在前、静态 `probe_dirs()` 在后，统一 `dedupe_dirs`。
2. 删除 `resolve_node` 中候选列表之前的私有 runtime 提前返回块。
3. 候选列表按 `dirs` → `client_node` 构造，按路径去重；私有 runtime 仅作为最后候选。
4. flag 命中/版本过低分支的 `source` 改为真实 `flag.source`（空值回退 `client`）。
5. 更新候选顺序注释，删除“私有 runtime 优先”的描述。

验收：fresh PATH 中的新 Node 优先于私有 runtime；flag 丢失时仍可通过最后一个候选自愈。

## 4. npm 与来源字段清理

文件：

- `packages/desktop/src-tauri/src/agent/env/install.rs`
- `packages/desktop/src-tauri/src/agent/env/probe.rs`

步骤：

1. `node_has_npm(node_path, dirs)` 使用传入目录查找 `npm.cmd`。
2. `install` 调用 `node_has_npm(&node_path, &dirs)`；`install_trellis` 增加 `dirs` 参数并在 npm 回退中使用它。
3. 检查 `reused_source` 的所有调用；来源已在 `resolve_*` 保留后删除该函数，直接 `source.unwrap_or(fallback)`。
4. 确认手动路径 flag 的 `source=manual` 不再被状态层改写成 `client`。

验收：npm 判断与安装使用同一组目录；`runtime_status` 中手动路径来源为 `manual`。

## 5. Python fresh 探测

文件：`packages/desktop/src-tauri/src/agent/env/probe.rs`

步骤：

1. 新增 `WHERE_PYTHON_SCRIPT`（`where.exe python.exe`）和 `where_python_dirs_fresh()`。
2. 新增 `python_dirs_fresh()`：where 目录在前，`python_dirs()` 在后，去重。
3. `resolve_python` 保持 flag 优先；flag 缺失/失效后使用 `TRELLIS_PYTHON`、fresh where 目录、静态 PATH、常见前缀、`py -3` 的顺序。
4. 确保 flag 有效路径不调用 `where_python_dirs_fresh()`。

验收：flag 失效后新装 Python 可被发现；flag 有效时不增加 PowerShell 调用。

## 6. 文档与测试

1. 更新 `.trellis/spec/backend/desktop-agent-runtime.md` 的运行时检测说明：flag 缓存、延迟探测、候选顺序、Python fresh 探测。
2. 在 `agent/env/tests.rs` 增加：
   - fresh 目录合并顺序；
   - Node flag 来源保留；
   - `node_has_npm` 使用传入目录；
   - Python 目录合并顺序/去重。
3. 不新增旧键兼容测试；`config/tests.rs` 保持现有 camelCase 覆盖。
4. 不修改 Tauri 命令、权限、capability、前端组件。

## 7. 验证

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets
yarn test
yarn build:desktop
```

手工检查：

- 构造含 `schema_version` 的 `client.json`，确认客户端按“无配置”处理，不读取旧键。
- flag 均有效时启动客户端，确认日志不再出现 fresh 探测的额外等待。
- 删除 Node flag 或把版本改低，确认能重新发现系统 Node，且私有 runtime 只在无系统候选时使用。
- 删除 Python flag，确认新装 Python 可被 `runtime_status` 发现。

完成后仅提交本任务相关文件；不包含工作区里其他任务的改动。
