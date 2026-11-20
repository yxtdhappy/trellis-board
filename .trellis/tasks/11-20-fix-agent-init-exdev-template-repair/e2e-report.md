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

## 7. CI 构建与发布

- 特性提交：`b3089f2 fix(desktop): recover Pi/OMP init from EXDEV template writes`。
- 版本提交：`eb69d06 chore(release): 0.4.51`；tag `v0.4.51` 已推送。
- CI run [`44694310603`](https://github.com/yxtdhappy/trellis-board/actions/runs/44694310603)：
  `conclusion=success`，7m7s；`Rust unit tests`、desktop build、便携包、启动冒烟测试和
  Release 资产发布全部通过。
- Release：[`v0.4.51`](https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.51)。
  资产 `TrellisBoard_0.4.51_x64-portable.zip`（4,322,722 bytes，sha256
  `22550735744a87bbb69d76d88e98b99ae92998c838dff537a7719a65e116c553`）。
- CI 未配置 `cargo fmt --check` / `cargo clippy`，这两项仍待补跑。

## 8. 未完成项

- `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` 未执行：本机无 Rust 工具链，
  CI 也没有这两个步骤。`cargo test` 已由 CI `v0.4.51` / `v0.4.53` 通过。
- 临时 E2E 仓库已在归档前删除；证据保留在本报告与 `check-report.md`。
- 盘符根 `D:` 的追加修复仍需在另一台机器用 `v0.4.53` 实测确认。

## 9. 盘符根 EISDIR 追加修复（v0.4.53）

- 其他机器反馈：`Pi 模板补齐失败：EISDIR: illegal operation on a directory, lstat 'D:'`。
- 原因：`D:` 是 Windows 驱动器相对路径；v0.4.51 的补齐 helper 在 `realpath/lstat` 时直接使用
  裸盘符，DLP/加密或网络盘环境把它重定向后返回 EISDIR。
- 修复：Rust `normalize_repo_root()` 与 helper `normalizeRepoPath()` 在 snapshot / init / repair /
  hash / `finish_init` 前把 `X:` 规范为 `X:\`；普通路径不变。
- 提交：`fb1df4e fix(desktop): normalize drive-root repo paths for agent init`。
- CI：run [`44699199899`](https://github.com/yxtdhappy/trellis-board/actions/runs/44699199899)
  （tag `v0.4.53`，desktop job 5m59s）成功；`Rust unit tests`、打包、便携包/启动冒烟、Release 资产
  全部通过。
- Release：[`v0.4.53`](https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.53)。
- 待验证：另一台机器安装 `v0.4.53` 后在盘符根项目重试 Pi 初始化；若仍报 EISDIR，需要完整
  `error_tail` / 客户端日志。

## 10. JS realpath EISDIR 追加修复（v0.4.54）

另一台机器 v0.4.53 日志：

```text
node --input-type=module - <cli.js> \\?\D:\codeSpace\WIT\mdp-backend-service snapshot pi
stderr: EISDIR: illegal operation on a directory, lstat 'D:'
```

- 路径是 `\\?\D:\...` 扩展路径，不是裸盘符；v0.4.53 的规范化不命中。
- Node JS 版 `fs.realpathSync` 会先 `binding.lstat` 盘符根 `D:`；该机器 DLP 返回 EISDIR。
  ESM resolver 在 `import()` Trellis 模块时同样调用它，因此只改 helper 自身调用点不够。
- 本机故障注入复现：preload 用抛 `EISDIR lstat 'D:'` 的函数替换 `fs.realpathSync`，并以
  `\\?\` 扩展路径执行 helper。修复前 helper 在模块解析阶段失败，修复后 `repair pi` 成功写出
  `.pi/extensions/trellis/index.ts`。
- 修复：helper 顶层在加载 Trellis 模块前切换 `fs.realpathSync.native`；helper 内部 realpath
  全部走 native；保留裸盘符规范化与盘符根 realpath/stat 跳过。
- `node --test packages/desktop/test/agent-template-repair.test.js` 12/12 通过。
- 提交 `e9aae35`，发布 `v0.4.54`；CI run
  [`44701951487`](https://github.com/yxtdhappy/trellis-board/actions/runs/44701951487) 成功，
  `TrellisBoard_0.4.54_x64-portable.zip`（4,959,654 bytes，sha256
  `85d3b522d0014dd889e32a823bd9698f5149832f4a6ebbfcd95fa5d369e442de`）。
- 待用户机器安装 v0.4.54 实测确认。

## 11. Agent-only developer 身份与日志降噪（v0.4.55）

本机真实 `@mindfoldhq/trellis@0.6.17` 临时仓库 E2E：

| 步骤 | 结果 |
| --- | --- |
| helper `developer nzhou` | 生成 `.trellis/.developer`（`name=nzhou`）、`workspace/nzhou/journal-1.md`、`index.md` |
| Agent-only 首次 `pi` | 仍命中 `.pi/extensions/trellis/index.ts` EXDEV（预期） |
| helper `repair pi` | `created` 2 项，`skipped=49` |
| Agent-only 重试 | 退出码 0；`.pi/extensions/trellis/index.ts`、`.pi/settings.json` 存在 |
| developer 保留 | 第二次 developer helper 不覆盖已有身份 |
| 名称/越界防护 | 路径分隔符、盘符、ADS、控制字符、`.`/`..`、junction 越界均拒绝 |

- developer 文件模板与上游 `init_developer.py` 对齐（Node 写 LF，Python 在 Windows 写 CRLF；
  内容与结构一致，Trellis 按 `name=` 行读取）。
- 日志：首次预期 EXDEV 由 WARN 降为 INFO；`core.sparseCheckout` 未配置的 exit 1 不再写 WARN。
- 发布：提交 `23a7a01`，tag `v0.4.55`；CI run
  [`44707239133`](https://github.com/yxtdhappy/trellis-board/actions/runs/44707239133) 成功；
  `TrellisBoard_0.4.55_x64-portable.zip`（4,962,355 bytes，sha256
  `8de5a5dda2c8cdc06a015e27d4cd1699668c84d73208b1a061593695f1135949`）。
- 用户已确认 v0.4.55 在目标机器全部成功（Agent 初始化、`.developer`、workspace、日志均符合预期）。
  已知限制：所有 Agent 已初始化时弹窗无可提交工具，可用
  `python .trellis/scripts/init_developer.py <id>` 或选择任意仍缺失的 Agent。