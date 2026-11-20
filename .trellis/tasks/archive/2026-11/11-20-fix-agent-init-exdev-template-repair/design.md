# 技术设计

## 1. 目标与边界

在 `packages/desktop/src-tauri/src/agent/` 内为 Pi / OMP 增加一条受控的 EXDEV 恢复路径：

- 完整 `trellis init` 与 Agent-only 配置共用同一套「识别 → 直接补齐 → 单次重试」逻辑。
- 补齐只创建缺失模板，不覆盖已有文件，不使用 `.tmp` + rename。
- 补齐/重试成功后，只把本次确实由 Trellis 写入的模板并入 `.template-hashes.json`。
- 不修改 npm 包、不引入 sidecar/resources、不改变 Agent 完成状态检测。

## 2. 根因与现有缺口

### 2.1 上游写入链

```text
configurePlatform(platform, repo)
  → writeTemplateMap(repo, collect*Templates())
    → writeFile(absPath, content)
      → writeFileAtomic(absPath, content)
        → writeFileSync(`.${basename}.${pid}.tmp`)
        → renameSync(tmp, absPath)          // DLP 在这里返回 EXDEV
```

相关位置：

- `node_modules/@mindfoldhq/trellis/dist/utils/atomic-write.js:13`
- `node_modules/@mindfoldhq/trellis/dist/configurators/shared.js:399`
- `node_modules/@mindfoldhq/trellis/dist/configurators/pi.js:34`（`.pi/extensions/trellis/index.ts`）
- `node_modules/@mindfoldhq/trellis/dist/configurators/omp.js:25`（`.omp/extensions/trellis/index.ts`）

### 2.2 本机实测

| 操作（同一目录） | 结果 |
| --- | --- |
| Node `.tmp` → `.ts` / `.txt` | EXDEV |
| Node 直接写 `.ts` | 成功 |
| Node `.tmp` → `.md` / `.json` / `.js` / `.mjs` / `.py` / `.yml` / `.sh` | 成功 |
| PowerShell 把 Node 创建的 `.tmp` → `.ts` | 成功 |
| Node 把 PowerShell 创建的 `.tmp` → `.ts` | EXDEV |

结论：失败条件是「Node 进程 + `.tmp` 源文件 + `.ts`/`.txt` 目标」；直接写目标文件可用，
因此恢复路径不需要依赖 PowerShell，也不需要在产品层关闭 DLP。

### 2.3 现有客户端缺口

- `trellis_cli.rs:373` 注释承认 Rust 运行环境没有 `trellis-pi-repair.mjs`。
- `trellis_failure()` 仍把 Pi EXDEV 映射为“Pi 模板补齐失败”，但 `initialize_trellis` /
  `initialize_agents` 失败后直接返回，没有补齐和重试。
- 旧实现 `b2a9575` 的 `desktop/sidecar/trellis-pi-repair.mjs` 已在 `fbe97e3` 删除。
- `trellis_agent_tool_flags()` 在 Rust 重写中给 Pi 追加了 `--pi-presence all`；0.6.17 的 CLI 没有
  该选项，完整 init 会先报 `unknown option '--pi-presence'`。旧 JS 的 `trellisAgentToolFlags()`
  只返回 `flag`，`presenceMode: "all"` 一直只用于客户端检测。本次一并删除该参数。

### 2.4 盘符根路径

另一台机器项目位于 `D:\` 根时，修复 helper 的 `realpath/lstat` 报
`EISDIR: illegal operation on a directory, lstat 'D:'`。Windows 上 `D:` 是驱动器相对路径
（取决于进程在 D: 上的当前目录），DLP/网络盘会把它重定向成不可 lstat 的对象。

处理：

- Rust `normalize_repo_root()`：仅当路径正好是两个字符且第二个是 `:` 时补 `\`；
  `initialize_with_repair()` 在 snapshot / init / repair / hash / finish_init 之前统一使用规范化路径。
- helper `normalizeRepoPath()`：`/^[A-Za-z]:$/` 同样补 `path.sep`，再 `path.resolve()` 后
  `realpathSync`；正常绝对路径保持不变。
- 该规范化只影响裸盘符，不改变普通项目路径、盘符子目录或 UNC 路径。

### 2.5 v0.4.53 仍失败：JS realpath 与扩展路径

另一机器日志（v0.4.53）：

```text
node --input-type=module - <cli.js> \\?\D:\codeSpace\WIT\mdp-backend-service snapshot pi
stderr: EISDIR: illegal operation on a directory, lstat 'D:'
```

- Rust 传入的是 canonicalize 后的 `\\?\D:\...` 扩展路径，不是裸盘符，因此 2.4 的规范化不命中。
- Node 的 JS 版 `fs.realpathSync` 实现会先执行 `binding.lstat(getRealpathRootLstatPath(base))`；
  Windows 上该调用落在 `D:`，被该机器的 DLP/网络盘以 EISDIR 拒绝。`fs.realpathSync.native`
  走操作系统 realpath，不经过这个 lstat。
- 触发点有两个：helper 自身的 `realpathSync(realRoot)` / 父目录校验，以及 Node ESM resolver
  在 `import()` Trellis 模块时的 `finalizeResolution → realpathSync`。后者发生在 helper 读仓库
  路径之前，所以只改 helper 的调用点不够。
- 处理：
  1. helper 模块顶层（任何 `import()` 之前）执行
     `fs.realpathSync = fs.realpathSync.native`（native 不存在时保留原函数）；
  2. helper 内部的 realpath 统一走 native；
  3. 保留 2.4 的裸盘符规范化与盘符根 realpath/stat 跳过，作为附加防御。

## 3. 总体结构

```text
initialize_trellis / initialize_agents
  → initialize_with_repair(mode = FullInit | AgentsOnly)
      ├─ AgentsOnly? → helper "developer" <developerId>     // 必须先于平台配置
      ├─ selected = selected_repair_platforms(tools)            // pi / omp
      ├─ snapshot = run helper "snapshot" selected              // 可失败降级
      ├─ output   = run init
      ├─ success? → finish_init
      ├─ repair   = repair_platforms_for_failure(repo, tools, output)
      ├─ empty?   → Err(trellis_failure)
      ├─ repair   = run helper "repair" repair                  // 直写缺失文件
      ├─ failed?  → Err(repair_failure)
      ├─ retry    = run init（完全相同参数，仅一次）
      ├─ failed?  → Err(retry_failure)
      ├─ run helper "hash"（best effort，失败不影响成功）
      └─ finish_init
```

新增内嵌 helper：

- `packages/desktop/src-tauri/src/agent/agent_template_repair.mjs`
- `const AGENT_TEMPLATE_REPAIR_HELPER: &str = include_str!("agent_template_repair.mjs");`
- 与 `agent_only_init.mjs` 一样，通过 `node --input-type=module -` 从 stdin 执行，不落任何 helper
  临时文件到用户项目或安装目录。

## 4. 失败识别

### 4.1 受影响平台

```text
PI  = "pi"  → ".pi/extensions/trellis"
OMP = "omp" → ".omp/extensions/trellis"
```

`selected_repair_platforms(tools)`：按 `["pi", "omp"]` 固定顺序返回所选平台。

`repair_platforms_for_failure(repo, tools, output)`：

1. `stderr + stdout` 不包含 `EXDEV` → 返回空。
2. 所选平台为空 → 返回空。
3. 已知签名成立：`combined.contains(extensionDir)` 或 `repo.join(extensionDir).exists()`。
4. 签名成立时返回**所有所选的 Pi/OMP 平台**，而不是只返回当前报错的那个。这样同时选择 Pi + OMP
   时，一次补齐即可覆盖两者，避免“修好 Pi、重试又卡在 OMP”。
5. 其他 `EXDEV`（无法匹配扩展路径）不触发补齐，沿用原错误。

### 4.2 错误语义

| 场景 | 错误文案 | details |
| --- | --- | --- |
| 非目标错误 / 非 EXDEV | 原 `fallback_prefix：<tail>` | `repairPlatforms: []` |
| 补齐 helper 失败 | `Pi 模板补齐失败：<tail>` / `OMP ...` / `Pi/OMP ...` | `repairFailed: true` |
| 补齐成功但重试失败 | `<fallback_prefix>（模板已补齐，重试仍失败）：<tail>` | `retryFailed: true` |
| 补齐/重试成功 | 不返回错误 | — |

错误统一使用现有 `code::GIT_FAILED`，保持前端错误处理不变。`error_tail()` 继续截取末尾 2 KiB。

## 5. 补齐 helper 契约

文件：`agent_template_repair.mjs`

### 5.1 调用方式

```text
node --input-type=module - <cliPath> <repoPath> <mode> <args...>

mode = snapshot <platform...>
       repair   <platform...>
       hash     <json>

hash 的 json = {"platforms":["pi","omp"],"missing":["相对路径", ...]}
```

- `cliPath` → `packageRoot = resolve(dirname(cliPath), "..")`。
- 必需模块：
  - `dist/configurators/index.js`（`PLATFORM_IDS`、`collectPlatformTemplates`）
  - `dist/commands/init.js`（`resolveSupportedPython`，仅 repair/hash）
  - `dist/utils/template-hash.js`（`initializeHashes`，仅 hash）
- 设置 `TRELLIS_QUIET=1`；stdout 最后一个非空行输出 JSON，便于 Rust 解析。
- 未知模式、未知平台、模块缺失、模板为空 → stderr 输出错误并以非零退出。

### 5.2 snapshot

- 不调用 `resolveSupportedPython()`（只需要路径键）。
- 对每个平台调用 `collectPlatformTemplates(platform)`，逐项 `lstatSync`。
- 输出 `{"missing":[...],"existing":[...]}`；Rust 只取 `missing`。
- 该步骤失败时 Rust 继续初始化，不阻塞主流程。

### 5.3 repair

1. 调用 `resolveSupportedPython()`，保证模板内容与 Agent-only helper / 完整 init 一致。
2. 收集所有平台模板，按 `Map` 插入顺序遍历。
3. 已存在目标（`lstatSync` 成功）直接跳过，不读内容、不覆盖。
4. 目标路径必须位于 `realpath(repoRoot)` 内；父目录逐级校验 realpath，防止 symlink/junction 越界。
5. `openSync(target, "wx")` + `writeFileSync(fd, content, "utf8")` + `closeSync`；记录创建列表。
6. 任一步失败：关闭 fd，删除本次创建的文件（尽力而为），非零退出。
7. 输出 `{"created":[...],"skipped":N}`。

明确禁止：`rename`、`.tmp`、`copyFile` 到目标后再删源。

### 5.4 hash

1. 调用 `resolveSupportedPython()`。
2. 重新收集模板，构建 `relativePath → content`。
3. 对 `missing` 中的每个路径：
   - 必须位于 repoRoot 内；
   - 必须是已存在的普通文件；
   - 读取 UTF-8 内容，必须与模板内容完全一致；
   - 满足条件的加入 `trackedPaths`，否则跳过。
4. `trackedPaths` 为空 → 不调用 `initializeHashes`，输出 `{"hashed":[]}`。
5. 否则调用 `initializeHashes(repoRoot, { trackedPaths, merge: true })`。
6. 输出 `{"hashed":[...],"skipped":[...]}`；失败非零退出，由 Rust 降级。

「内容一致」是安全闸门：初始化前已存在的用户文件即使同名也不会被登记；只有本次由 Trellis
生成/补齐、且内容与模板一致的文件才进入 manifest。

### 5.5 developer 模式

Agent-only 不执行 `trellis init`，因此弹窗里的 developer ID 必须在配置平台前落盘：

```text
node --input-type=module - <cliPath> <repoPath> developer <name>
```

- 语义对齐 Trellis 0.6.17 `.trellis/scripts/common/developer.py`：
  - `.trellis/.developer` 写入 `name=<name>\ninitialized_at=<ISO>\n`；
  - `.trellis/workspace/<name>/journal-1.md` 与 `index.md` 使用与 `init_developer.py` 相同的模板；
  - 已有含有效 `name=` 的 `.developer` → 不覆盖、不创建第二个 workspace，输出
    `{"developer":"<existing>","created":false}`。
- `.developer` 最后写：workspace/文件任一步失败时，下次仍会重新进入并补齐，不会因半成品
  `.developer` 而永久跳过。
- 名称校验：非空、≤120 字符，拒绝 `/`、`\`、`:`、`*`、`?`、`"`、`<`、`>`、`|`、控制字符、
  `.`/`..` 以及以点或空格结尾；允许空格、Unicode 等正常名称。
- 路径安全：`.trellis` 必须存在；workspace 目录经 native realpath 确认留在仓库根内；
  已有 `journal-1.md` / `index.md` 不覆盖。
- 失败语义：developer helper 失败 → `Trellis developer 初始化失败：<tail>`，
  details 含 `developer`、`developerFailed`，不继续配置 Agent。

## 6. Rust 侧改动

文件：`packages/desktop/src-tauri/src/agent/trellis_cli.rs`

### 6.0 完整 init 参数修正

- `trellis_agent_tool_flags()` 只输出每个工具的 `flag`，不再给 Pi 追加 `--pi-presence all`。
- `presenceMode: "all"` 继续由 `AGENT_TOOLS` 的 `all_presence` 在 `detect_agent_tools()` 中使用，
  与 CLI 参数完全解耦。
- 更新 `maps_tool_ids_to_init_flags` 的期望值；完整 init E2E 使用修正后的参数。

### 6.1 公开函数保持不变

- `initialize_trellis(runtime, repo, developer_id, tools)`
- `initialize_agents(runtime, repo, developer_id, tools)`

两者改为构造 `InitMode` 并调用共享的 `initialize_with_repair()`；Tauri 命令与 UI 返回值不变。
`initialize_agents` 新增 `developer_id` 仅用于补齐本机 developer 身份，不影响平台参数。

### 6.2 内部结构

```rust
enum InitMode<'a> {
    Full { developer_id: &'a str },
    AgentsOnly,
}

fn normalize_repo_root(path: &Path) -> PathBuf; // 裸盘符 D: -> D:\

async fn run_init_process(runtime, repo, tools, mode) -> AgentResult<ProcessOutput>;
async fn initialize_with_repair(runtime, repo, tools, mode, developer_id, fallback_prefix)
    -> AgentResult<()>;
```

- `run_init_process` 根据 mode 组装现有 `init_args` / `agent_only_args`，使用现有
  `run_process`、`INIT_TIMEOUT`、`INIT_MAX_OUTPUT_BYTES`。
- 首次 init 使用 `ProcessOptions.suppress_failure_log = true`，避免把预期 EXDEV 记成通用 WARN；
  命中补齐时写 INFO，未命中补齐时由 `initialize_with_repair` 手动写 WARN，保留诊断能力。
  重试仍使用正常失败日志。
- `initialize_with_repair` 负责 Agent-only developer 补齐、snapshot、首次 init、识别、repair、
  单次 retry、hash 补偿、`finish_init`。
- 新增常量：`REPAIR_TIMEOUT = 30s`；helper 超时与 init 分开，避免完整 init 超时后
  “snapshot + init + repair + retry + hash” 超过 initialize-project 的 600s 预算（最坏 510s）。

### 6.3 helper 执行

```rust
fn repair_helper_args(cli, repo, mode, platforms) -> Vec<String>;
fn hash_helper_args(cli, repo, payload_json) -> Vec<String>;
```

- 参数形式见 5.1。
- `ProcessOptions { cwd: Some(repo), stdin: Some(HELPER.as_bytes().to_vec()), timeout: REPAIR_TIMEOUT, max_output_bytes: INIT_MAX_OUTPUT_BYTES }`
- 使用 `runtime.node_exe` 与 `runtime.cli_path`，不回退系统 node。
- snapshot 输出解析：取 stdout 最后一个以 `{` 开头的非空行，`serde_json` 解析
  `{"missing": [...]}`；任何失败视为空。
- hash 调用失败、输出解析失败、helper 非零退出都不影响已成功的初始化结果。

### 6.4 模板哈希补偿

- snapshot 在**第一次 init 之前**执行，只在所选平台含 Pi/OMP 时执行。
- 首次 init 成功时不使用 snapshot；正常写入路径已经记录哈希。
- 仅当发生「补齐 + 重试成功」时，调用 hash helper，把 snapshot 中缺失、且现在内容与模板一致的
  路径合并进 `.template-hashes.json`。
- hash 补偿在 `finish_init()` 之前执行，让现有 `__pycache__/*.pyc` 清理继续作用于最终 manifest。

## 7. 路径与文件安全

- 目标必须是 repoRoot 内的相对路径；拒绝空段、`..`、NUL、盘符、ADS、绝对路径。
- 父目录 realpath 必须在 repoRoot 内；Windows 普通路径与 `\\?\` 扩展路径都按同一规则处理。
- realpath 一律使用 `fs.realpathSync.native`；helper 在加载 Trellis ESM 模块前把
  `fs.realpathSync` 替换为 native，避免 Node ESM resolver 触发 DLP 的 `lstat 'D:'`。
- Agent-only developer 目录同样做路径校验：`.trellis` 必须存在，workspace 与 `.developer`
  必须留在仓库根内；已有 journal/index 不覆盖；`.developer` 最后写。
- 只创建缺失文件；已有文件不读、不写、不删。
- 失败回滚只删除本次创建的文件，且先记录再写入。
- 不修改 `.trellis` 之外的 Trellis 元数据；不写 spec、workflow、任务或根文件。

## 8. 错误矩阵

| 条件 | 行为 |
| --- | --- |
| 首次 init 成功 | 直接 `finish_init`，不补齐、不重试 |
| 非 EXDEV / 非 Pi/OMP | 原错误返回，不补齐 |
| Pi/OMP EXDEV，签名成立 | snapshot → repair → retry 一次 |
| repair helper 非零退出 | `Pi/OMP 模板补齐失败`，不重试 |
| repair helper 无法启动 | 传播 `run_process` 错误，不重试 |
| retry 仍失败 | `...（模板已补齐，重试仍失败）`，不循环 |
| snapshot/hash 失败 | 静默降级，不改变 init 成功/失败结果 |
| 已有用户文件 | repair 跳过；hash 只在内容等于模板时才登记 |
| 同时选 Pi + OMP | repair 一次覆盖两者，retry 一次 |

## 9. 兼容与回滚

- `initialize_trellis` / `initialize_agents` 的 Tauri 命令、UI 返回值不变。
- Agent-only 额外写 `.trellis/.developer` 与 developer workspace；已有有效身份不覆盖。
- 正常（非 EXDEV）初始化路径只多一次 snapshot helper 调用（仅 Pi/OMP 被选中时），不改变写入内容。
- 补齐 helper 内嵌，不改变安装包结构、`tauri.conf.json`、`package-portable.ps1`。
- 回滚：删除 helper、恢复 `initialize_trellis` / `initialize_agents` 直接返回 `trellis_failure` 的
  原实现；已生成的用户项目文件无需迁移。

## 10. 备选方案与取舍

| 方案 | 结论 |
| --- | --- |
| 修补上游 `atomic-write.js` 的 EXDEV 回退 | 最通用，但当前固定 0.6.17（npm 最新版也是 0.6.17），需要 fork/vendor；本次不选 |
| Node preload 把 `fs.renameSync` 改为 copy+unlink | 覆盖所有类型，但全局 monkey-patch 风险高、隐蔽；只作为未来备选 |
| 仅 Pi 补齐 | 改动最小，但 OMP 同样有 `.ts` 扩展，会留下同类故障；本次覆盖 Pi + OMP |
| 关闭 DLP / 排除项目目录 | 依赖企业策略，归档任务已明确 out of scope；不选 |

## 11. 验证策略

- Rust 单测：平台识别、参数拼接、错误文案/details、helper 结构约束、裸盘符规范化、现有 hash 清理回归。
- Node 测试：用 fake Trellis 包执行内嵌 helper 的 snapshot / repair / hash / developer，覆盖已有文件保护、
  路径越界、失败回滚、内容不一致不登记；故障注入覆盖「JS realpath 抛 EISDIR + `\\?\` 扩展路径」，
  验证 helper 仍能完成 repair；developer 覆盖身份创建、已有身份保留、无效身份替换、名称穿越拒绝、
  workspace junction 越界拒绝。
- 真机 E2E：本机 DLP 环境创建临时 Git 仓库，执行真实 Agent-only 与完整 init 的
  「失败 → 补齐 → 重试成功」，验证 Pi/OMP 文件与 manifest；完整 init 必须使用修正后的
  `--pi` 参数（不再出现 `unknown option`）。
- 编译与静态检查只在全部代码写完后执行一次：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、
  目标 `cargo test`。