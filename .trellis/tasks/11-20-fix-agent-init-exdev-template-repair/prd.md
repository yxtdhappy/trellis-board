# 修复 Agent 初始化 EXDEV 模板写入失败

## Goal

在 Windows DLP/加密客户端拦截 Node 对 `.tmp` → `.ts` 的 rename 时，让桌面客户端为 Pi / Oh My Pi（OMP）
直接补齐缺失模板、单次重试初始化，并只把确实由 Trellis 写入的模板登记到
`.trellis/.template-hashes.json`，避免 Agent 初始化永久失败或被误判为已完成。

## Background

- 本机实测（2026-11-20，`D:\wit\trellis-board`）：Node 在同一目录把 `.tmp` 文件 rename 成 `.ts` 或
  `.txt` 时稳定返回 `EXDEV`；Node 直接写 `.ts` 成功；同一 `.tmp` 由 PowerShell rename 成功。
  失败条件可收窄为「Node + `.tmp` 源文件 + `.ts`/`.txt` 目标」被 DLP/文件过滤驱动拦截。
- 上游 `@mindfoldhq/trellis@0.6.17` 的 `writeFileAtomic()` 固定使用
  `.<basename>.<pid>.tmp` → `fs.renameSync()`；Pi 的 `.pi/extensions/trellis/index.ts` 和 OMP 的
  `.omp/extensions/trellis/index.ts` 都会命中。
- 失败发生前 Pi 的 `.md` 模板通常已写入，随后在第一个 `.ts` 文件中断；`.pi/extensions/trellis`
  为空、`.pi/settings.json` 缺失，正好对应桌面端“初始化 1 个 Agent”弹窗的报错。
- 当前 Rust 单 exe 版本只在 `trellis_failure()` 中把 Pi EXDEV 映射成“Pi 模板补齐失败”，
  没有执行补齐或重试；旧 sidecar 的 `trellis-pi-repair.mjs` 已在 `fbe97e3` 随 Rust 重写删除。
- 实施时确认：`trellis_agent_tool_flags()` 固定给 Pi 追加 `--pi-presence all`，但
  `@mindfoldhq/trellis@0.6.17` 的 `trellis init` 没有该参数，完整 init 会在写入前报
  `unknown option '--pi-presence'`；`presenceMode: "all"` 只是客户端检测字段，旧 JS
  `trellisAgentToolFlags()` 从未把它传给 CLI。本任务一并移除该参数。
- 2026-11-20 其他机器反馈：项目位于盘符根时，Pi 初始化报
  `Pi 模板补齐失败：EISDIR: illegal operation on a directory, lstat 'D:'`。Windows 上裸盘符
  `D:` 是驱动器相对路径；init/补齐/hash 前必须统一规范为 `D:\`（或项目实际绝对路径）。
- v0.4.53 只规范了裸盘符，另一台机器仍失败。完整日志显示 Rust 传入的是 `\\?\D:\codeSpace\...`
  扩展路径；Node 的 JS 版 `fs.realpathSync` 会先 `binding.lstat` 盘符根（`D:`），该机器的
  DLP/网络盘以 EISDIR 拦截。触发点不只是 helper 自身的 realpath，Node 的 ESM resolver 在
  `import()` Trellis 模块时也会调用同一个 JS realpath。v0.4.54 必须在加载模块前把
  `fs.realpathSync` 换成 `fs.realpathSync.native`，helper 自身的 realpath 也只用 native。

## Requirements

- R1 失败识别：仅当所选 Agent 包含 `pi` 或 `omp`、初始化输出包含 `EXDEV`，且输出或仓库中存在对应
  扩展路径（`.pi/extensions/trellis` / `.omp/extensions/trellis`）时触发；其他错误保持原行为。
- R2 模板补齐：从固定 runtime 的 Trellis 包读取 `collectPlatformTemplates(platform)`，只创建缺失
  文件；已有文件不比较、不覆盖；目标路径必须位于仓库根内；写入失败时删除本次新建文件；使用直接
  排他写入（`openSync(..., "wx")` + `writeFileSync`），不得产生 `.tmp` 或 rename。
- R3 单次重试：补齐成功后使用完全相同的参数重试一次完整 `trellis init` 或 Agent-only 配置；
  禁止循环重试；补齐或重试失败必须返回可定位错误，不能伪造成功。
- R4 双路径覆盖：完整 init 与已有 `.trellis/tasks` 的 Agent-only 配置共用同一套识别、补齐、重试逻辑。
- R5 多 Agent：同时选择 Pi 与 OMP 时，一次补齐覆盖两者，避免修好 Pi 后重试又卡在 OMP。
- R6 模板哈希：第一次初始化前记录受影响平台模板中缺失的相对路径；补齐并重试成功后，只把这些
  路径中「现已存在且内容与模板一致」的文件合并进 `.template-hashes.json`，不得把初始化前已存在的
  用户文件登记为 Trellis 模板。
- R7 边界与打包：补齐 helper 通过 `include_str!` 内嵌，经环境门确定的 `node.exe` + `cli.js` 从 stdin
  执行；不修改 `node_modules/@mindfoldhq/trellis`，不新增 sidecar/resources/npm 依赖。
- R8 验证：Rust 单测覆盖识别、参数、错误矩阵；Node 测试覆盖 helper 的 snapshot / repair / hash、
  路径越界、已有文件保护和失败回滚；Windows 真机在本机 DLP 环境执行 Pi 与 OMP 的实际初始化。
- R9 完整 init 参数：不得向 0.6.17 CLI 传递不存在的 `--pi-presence all`；`presenceMode: "all"` 只用于
  客户端完成状态检测。
- R10 盘符根路径：完整 init、Agent-only、snapshot/repair/hash 之前，把裸盘符（`X:`）统一规范为
  `X:\`；补齐 helper 自身也做同样规范化，避免 realpath/lstat 对 `D:` 报 EISDIR。
- R11 EISDIR realpath 规避：helper 必须在加载任何 Trellis ESM 模块之前，用
  `fs.realpathSync.native` 替换 Node 的 JS 版 `fs.realpathSync`，覆盖 ESM resolver 与 helper
  自身的 realpath 调用；不得依赖裸盘符规范化来处理 `\\?\X:\...` 扩展路径。native 不可用时
  才回退 JS 版。

## Acceptance Criteria

- [ ] 本机 DLP 环境下，已有 `.trellis/tasks` 的项目选择 Pi 执行 Agent-only 初始化成功，
  `.pi/extensions/trellis/index.ts` 与 `.pi/settings.json` 都存在且无 `.tmp` 残留。
- [ ] 同一环境选择 OMP 执行初始化成功，`.omp/extensions/trellis/index.ts` 存在。
- [ ] 缺少 `.trellis`/`.trellis/tasks` 时执行完整 `trellis init --pi` 也能在补齐后成功。
- [ ] 完整 init 不再因为 `--pi-presence all` 报 `unknown option`；参数中只保留 `--pi`。
- [ ] 项目位于盘符根（如 `D:\`）时，Pi 初始化不再报 `lstat 'D:'`，能完成补齐/重试。
- [ ] 同时选择 Pi 与 OMP 时只补齐一次、只重试一次，两个平台都完成。
- [ ] 非 Pi/OMP 的 `EXDEV`、普通初始化错误、补齐 helper 自身失败都不会进入重试循环。
- [ ] 已有 Pi/OMP 文件（包括用户修改过的共享 `.agents/skills`）内容保持不变。
- [ ] 补齐成功后 `.template-hashes.json` 包含本次由 Trellis 写入的 Pi/OMP 模板键；初始化前已存在的
  同名文件不被登记。
- [ ] `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、目标 Rust 测试与相关 Node
  测试通过；按项目规则只在全部开发完成后执行一次编译。
- [ ] 不修改 `node_modules`、不新增 sidecar/resources、不要求关闭 DLP 或加密策略。

## Out of Scope

- 修改上游 Trellis 的 `atomic-write` 实现或升级 Trellis 版本。
- 处理所有可能被 DLP 拦截的扩展名；本次只覆盖已知的 Pi/OMP `.ts` 模板路径。
- 修改 Agent 选择 UI、完成状态检测规则或 Trellis 模板内容。
- 关闭 DLP、杀毒软件或文件系统过滤驱动。