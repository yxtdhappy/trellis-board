# 运行时环境检测收口

## Goal

修复合并 `635bc46`（首次登录运行环境标记与增量安装）与 `b947b78`（Node 环境检测与手动路径）后产生的运行时检测问题：旧配置无法被 `config::load()` 读取、每次启动都无条件执行 PowerShell 探测、Node/Python 候选顺序与 npm 探测范围不一致。目标是把启动路径恢复到“flag 命中时只做轻量校验，完整探测只在 flag 缺失/失效时发生”，并让候选顺序和来源字段可预测。

## Background

- `packages/web/src/desktop/LoginApp.tsx` 每次挂载都会调用 `runtime_status`，所以客户端每次启动都会进入 `env::check`。
- `node_runtime` / `trellis_runtime` / `python_runtime` 是路径缓存，不是“已检测”开关；当前 `check` 在判断 flag 之前无条件执行 `probe_dirs_fresh().await`。
- `config.rs` 删除了 `schema_version` 的 serde alias，但 `config::load()` 直接反序列化，旧文件会在 `serde_json::from_str` 失败后返回 `Ok(None)`。
- `resolve_node` 在候选列表之前提前返回客户端私有 Node，导致旧的私有运行时压过系统新版本；`probe_dirs_fresh` 又把 `where.exe` 结果追加在静态 PATH 之后。
- `install.rs::node_has_npm` 仍使用静态 `path_dirs()`，与 `install_trellis` 的 fresh 探测不一致。
- Python 只使用静态 `path_dirs()` / `python_dirs()`，新安装并写入用户 PATH 的 Python 可能无法通过“重新检查”发现。

## Scope

### F1. 旧键直接忽略

- `config::load()` 只按 `schemaVersion` 等 canonical camelCase 键反序列化；旧 `schema_version` 不参与读取，也不做键名迁移。
- 不恢复 serde `alias`，不保留 snake/camel 双键兼容；旧键文件按现有解析失败路径处理（`Ok(None)`）。
- 删除 `runtime_commands.rs` 中只为旧键服务的 `normalize_schema_key` 及其调用，避免出现“配置层忽略、运行时层又处理”的两套规则。
- `node_runtime` / `trellis_runtime` / `python_runtime` 继续使用当前 canonical 键；本次不改这些字段名。

### F2. 延迟 fresh 目录探测

- `check` 在 flag 可用时不得执行 `probe_dirs_fresh()`；只有 Node 或 Trellis 的 flag 缺失、文件失效或版本过低时才触发一次 PowerShell 探测。
- `install` 同样不得在准备阶段无条件探测；需要安装或需要 npm 查找时才探测，并把同一份 `dirs` 传给后续步骤，避免重复执行 `where.exe`。
- 保持现有行为：flag 文件失效时清除对应 flag 并自愈；flag 版本过低时继续寻找可用候选。
- 不引入跨进程持久化缓存；可选地使用进程内缓存，但必须保证测试可隔离。首版优先由调用时机控制，不增加全局状态。

### F3. 统一 Node 候选顺序

- 候选顺序固定为：fresh PATH / 版本管理器 / 常见安装前缀 → 客户端私有 runtime。
- 删除 `resolve_node` 中“私有 runtime 提前返回”的分支；私有 runtime 只作为最后一个候选，但 flag 丢失时仍能通过候选列表自愈。
- `probe_dirs_fresh()` 中 `where.exe` 得到的目录排在静态 PATH 快照之前，保证新安装的 Node 优先于进程启动时的旧 PATH。
- flag 命中时仍走快速路径，不执行候选扫描；候选顺序只在需要探测时生效。代码注释必须与真实顺序一致，并删除“私有 runtime 优先”的描述。

### F4. npm 探测与来源字段

- `node_has_npm(node_path, dirs)` 接收调用方已探测的 `dirs`，不再内部调用 `path_dirs()`。
- `install` 把同一份 `dirs` 传给 `node_has_npm`、`install_trellis` 以及需要 npm 的回退路径，保证“判断有没有 npm”和“实际找 npm”使用同一组目录。
- `resolve_node` 在 flag 命中时返回真实的 `flag.source`（`manual` / `path` / `client` 等），不再硬编码 `client`；失效或版本过低的分支同样保留真实来源。
- 如果来源字段修正后 `reused_source` 不再需要，删除该辅助函数及其调用，避免两套来源恢复逻辑。

### F5. Python fresh 探测

- `resolve_python` 在 flag 缺失或失效时，除静态 `path_dirs()` / `python_dirs()` 外，还要探测 fresh PATH 中的 `python.exe`（`where.exe python.exe`），并让 fresh 目录优先于静态快照。
- Python flag 有效时仍校验一次版本，但不额外执行 PowerShell；只有需要重新发现 Python 时才探测。
- `py -3` 启动器回退保持现状。

## Non-goals

- 不修改环境门 UI、最低版本号、安装包下载源或 Python/Node 安装流程。
- 不新增“强制重新检查”参数；flag 有效时 `runtime_status` 仍是轻量校验，用户手动改路径或清除 flag 才会重新发现。
- 不处理与本次收口无关的 Web、Board 或更新功能。
- 不为旧配置增加兼容层：旧 `schema_version` 直接忽略。

## Acceptance Criteria

- [ ] 旧 `schema_version` 文件不再被 `config::load()` 读取；`runtime_commands` 不再包含旧键清理逻辑。
- [ ] Node/Trellis flag 均有效时，`runtime_status` 不调用 `probe_dirs_fresh()`，不启动 PowerShell；flag 缺失/失效时才探测一次。
- [ ] `install` 在无需安装且无需 npm 查找时不执行 fresh 探测；需要时只探测一次，并把同一份目录传给 npm 判断和 Trellis 安装。
- [ ] Node 候选顺序为 fresh PATH 优先、私有 runtime 最后；私有无运行时才回退到私有 runtime。
- [ ] `node_has_npm` 使用传入目录；手动路径的 `source` 在 `runtime_status` 中保持 `manual`。
- [ ] Python flag 失效后，fresh PATH 中新增的 Python 能被发现；Python flag 有效时不额外执行 PowerShell。
- [ ] `cargo test`、`cargo clippy --all-targets`、`yarn test` 通过；不引入新的格式或 lint 问题。

## Risks

- flag 有效时跳过 fresh 扫描意味着进程启动后新安装的 Node 不会自动出现；这符合“缓存优先”的取舍，但“重新检查”在 flag 有效时仍只做校验。
- `where.exe` 在受限策略或超时下返回空列表，候选会回退到静态快照与私有 runtime。
- 旧配置不再兼容：只含 `schema_version` 的文件会被当作“无配置”，用户可能需要重新登录；这是明确接受的取舍。
