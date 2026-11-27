# 实施报告：插件宿主 Python 解析与 spawn 失败回退

本报告汇总 STEP 1–5 的结果；分层的细节见
[`implementation-report-server.md`](implementation-report-server.md)、
[`implementation-report-rust.md`](implementation-report-rust.md)、
[`implementation-report-web.md`](implementation-report-web.md)。

## 1. 改动清单

| 层 | 文件 | 内容 |
| --- | --- | --- |
| server | `packages/server/python.js` | `PYTHON_UNAVAILABLE=1011`、候选解析（`TRELLIS_PYTHON` → PATH → Windows 常见目录 → `py -3`）、`isUsableExecutable`、`tryPythonCandidates`、`runPythonScript` |
| server | `packages/server/actions.js` | `runTaskPython` 接入解析器，`createTask` 透传 `env` |
| server | `packages/server/team/toolchain.js`、`team/process.js` | 生命周期预检逐候选执行；删除 `spawn('python')` 专用回退 |
| Rust | `agent/env/probe.rs`、`agent/task_command.rs` | flag 自愈（版本探测失败清空）；`recorded_python_from` 用 `is_usable_file` 拒绝 0 字节 |
| Rust | `plugin_host.rs`、`main.rs` | 宿主注入 `TRELLIS_PYTHON`；新增 `runtime_open_gate` 命令 |
| Rust | `permissions/desktop.toml`、`capabilities/board-local-association.json` | 仅 Board capability 开放 `allow-runtime-open-gate` |
| web | `features/plugins/runtime-issue.ts`、`PluginPanel.tsx` | 识别 1011、toast「检查运行环境」、桌面壳调用 `runtime_open_gate` |
| plugins | `witops-core/dispatch.js` | `failureResult` 保留数值型业务错误码 |
| 测试 | `packages/server/test/python-runtime.test.js` 等 | 解析、回退、1011、真实 task.py、静态权限契约、Web 纯函数 |
| spec | `.trellis/spec/backend/{plugin-runtime,desktop-agent-runtime}.md` | 新契约与旧结论修正 |

## 2. 验证结果

### Linux（Node v22.21.1 / Python 3.12.3）

```bash
PYTHON=python3 TRELLIS_PYTHON=python3 yarn test --scope=all
# → 963 pass / 0 fail / 3 skip（首轮曾出现 1 次未复现的抖动，连续重跑通过）
yarn test --scope=rust
# → 448 pass / 8 fail（8 个为基线 Windows-only 断言；新增 6 个 Rust 用例全绿）
yarn oxfmt --check <changed files>
# → All matched files use the correct format.
```

### Windows 实机（`Z0328@192.168.137.1`，Node v24.9.0 / Yarn 3.5.0）

```bash
yarn test --scope=server --file=python-runtime      # 14 tests, 2 pass / 12 skip（POSIX 用例跳过）
yarn test --scope=server --file=actions.test        # 13 tests, 9 pass / 4 skip
yarn test --scope=web --file=plugin-runtime-issue   # 5/5
yarn test --scope=desktop --file=desktop-ui-build   # 12/12
yarn test --scope=plugins --file=index.test         # 98/98
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --bin trellis-board-client
# → 461 passed / 1 failed：agent::process::tests::decodes_system_codepage_output
#   英文 Windows 的 cmd 文案与断言的中文不一致，属既有环境断言
./tauri-dev.sh build desktop --skip-typecheck
# → UI（Vite）与 cargo debug 构建通过
```

实机回归脚本（`E:\work\mdp\_windows-dev\python-fallback.mjs`）：

1. `TRELLIS_PYTHON` 指向 0 字节 `python.exe`，PATH 前置 0 字节 `python.exe`/`python3.exe`：
   首次 `spawn EFTYPE`，加入 `EFTYPE` 到重试集合后回退到真实 `Python313\python.exe`，输出 `RUN_OK ran`。
2. PATH 只含 0 字节别名：解析器落到
   `common-prefix:C:\Users\kanyifei\AppData\Local\Programs\Python\Python313\python.exe`，`RUN_OK ran`。

## 3. 偏差与遗留

- **新增 `EFTYPE` 重试**：Windows 实机发现 0 字节文件 spawn 返回 `EFTYPE`（而非仅 `EACCES`），
  已加入 `RETRYABLE_SPAWN_CODES` 并同步 prd/design/implement/spec/测试。
- **Windows 未跑 `tsgo` 类型检查**：该机器上部分源文件的 `$DATA` 为 5400 字节而逻辑长度 1304
  （文件系统/加密过滤层），TypeScript 7 native 读取报 `TS1127`；Node 读取与 Vite 构建正常。
  Linux `tsc` 已通过，故以 `--skip-typecheck` 完成 Windows 构建。
- 隔离实例未登录 WitOps 平台，未执行真实「面板下发 → 环境门 → 自动回 Board」；该段留作
  `implement.md §8` 的人工验收。
