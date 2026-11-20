# EXDEV 复现证据（2026-11-20）

## 环境

- Windows 11 Pro 10.0.26300
- Node `v24.21.0`（`C:\Program Files\nodejs\node.exe`）
- `@mindfoldhq/trellis@0.6.17`
- 仓库：`D:\wit\trellis-board`
- 企业 DLP/加密客户端启用（截图中带水印）

## 同目录 rename 矩阵

探针目录：`D:\wit\trellis-board\.pi\extensions\trellis`，测完已清理。

| 操作 | 结果 |
| --- | --- |
| Node `.tmp` → `.ts` | EXDEV |
| Node `.tmp` → `.txt` | EXDEV |
| Node `.tmp` → `.md` / `.json` / `.js` / `.mjs` / `.py` / `.yml` / `.yaml` / `.toml` / `.sh` / `.ps1` | 成功 |
| Node 直接写 `.ts`（无 rename） | 成功 |
| PowerShell 把 Node 创建的 `.tmp` → `.ts` | 成功 |
| Node 把 PowerShell 创建的 `.tmp` → `.ts` | EXDEV |

结论：触发条件是「Node 进程 + `.tmp` 源文件 + `.ts`/`.txt` 目标」；不是文件本身不可改名，
也不是所有 Node 写入都被拦截。

## 真实 Agent-only 初始化复现

临时 Git 仓库：`D:\wit\trellis-exdev-e2e-1795156576`（已建 `.trellis/tasks`）。

```bash
cd /d/wit/trellis-exdev-e2e-1795156576
node --input-type=module - \
  /d/wit/trellis-board/node_modules/@mindfoldhq/trellis/bin/trellis.js \
  /d/wit/trellis-exdev-e2e-1795156576 pi \
  < /d/wit/trellis-board/packages/desktop/src-tauri/src/agent/agent_only_init.mjs
```

退出码 1，stderr：

```text
Error: EXDEV: cross-device link not permitted, rename
  '...\.pi\extensions\trellis\.index.ts.29776.tmp'
  -> '...\.pi\extensions\trellis\index.ts'
    at Object.renameSync (node:fs:1073:11)
    at writeFileAtomic (.../@mindfoldhq/trellis/dist/utils/atomic-write.js:18:12)
    at writeFile (.../@mindfoldhq/trellis/dist/utils/file-writer.js:95:9)
    at writeTemplateMap (.../@mindfoldhq/trellis/dist/configurators/shared.js:403:15)
```

失败后仓库状态：

- 已写入：`.pi/prompts/trellis-*.md`（3 个）、`.pi/agents/trellis-*.md`（3 个）
- `.pi/extensions/trellis/`：空
- `.pi/settings.json`：不存在

与桌面端“初始化 1 个 Agent”弹窗报错和当前工作区 `.pi` 半成品状态一致。

## 对修复的含义

- 直接写目标文件可用，因此补齐 helper 必须使用排他直写，不能产生 `.tmp`/rename。
- Pi 与 OMP 都在模板 map 中写入 `.ts` 扩展，必须同时覆盖。
- 失败发生在 `initializeHashes()` 之前，第一次失败时已写入的 `.md` 文件不会进入
  `.template-hashes.json`；补齐重试后需要 snapshot/hash 补偿。
- 本机可稳定复现，可作为真实 E2E 验收环境，不需要只靠故障注入。