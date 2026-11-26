# check 报告绑定改用换行规范化哈希

## Goal

把 `check-report.md` 的绑定哈希从“原始字节”改为“LF 规范化字节”，并让 `stamp-check` 始终写 LF，消除跨客户端 CRLF 工作区在同步回写后触发 `check_report_changed_after_binding` 的问题。

## Background

2026-11-26 归档任务 `11-25-project-rail-upload-status` 时首次 archive 被拒：

- `stamp-check` 在 Windows 上用 Python 默认文本模式写入，文件落盘为 CRLF，`set-commit` 按原始字节记录绑定哈希 `86fd7d…`；
- 桌面同步在上传时把 CRLF 归一化为 LF（`snapshot.rs:80-83`），服务端保存 LF；
- 下一次 pull 物化快照时把本地文件重写为 LF（`local_files.rs:481`），文件 mtime 更新；
- `archive` 仍按原始字节比对（`task_store.py:2799`），哈希失配，报 `check_report_changed_after_binding`。

复算证明：绑定哈希 `86fd7d…` 正好等于当前 LF 内容转 CRLF 后的哈希，正文没有任何改动。

这不是本机独有的问题：

- `.gitattributes` 只约束 git checkout / add，任务文件在 check 阶段通常尚未跟踪，编辑器、Python、PowerShell、其他 agent 都可直接写 CRLF；
- 同步协议把 LF 当作规范形式，服务端永远存 LF；
- 因此只要任一客户端工作区是 CRLF，绑定后的下一次回写就会让原始字节哈希失效。

重新 `set-commit` 只能手工绕过，问题会随客户端和任务重复出现。

## Requirements

- R1. 在 `.trellis/scripts/common/task_store.py` 增加与桌面端 `normalize_snapshot_text` 等价的规范化函数：去掉 UTF-8 BOM，把 `\r\n` 和单独的 `\r` 统一为 `\n`，再计算 SHA-256。
- R2. `set-commit` 写入 `meta.check_binding.report_sha256` 时使用规范化哈希（`task_store.py:2274`）。
- R3. `archive` / `verify` 校验时使用规范化哈希；为兼容本改动之前创建的任务，文件未变化时也接受旧的原始字节哈希（`task_store.py:2799`）。
- R4. `stamp-check` 写报告时显式指定 `newline="\n"`（`task_store.py:2680`），保证任何平台落盘都是 LF。
- R5. 在 `scripts/test/task-check-binding.test.js` 增加覆盖：CRLF→LF 转换通过、正文改动仍拒绝、旧原始哈希兼容、BOM/单独 CR 处理。
- R6. 如仓库内存在描述 check 绑定规则的 spec/文档，同步说明“绑定按 LF 规范化字节计算”。

## Acceptance Criteria

- [ ] AC1. 用 CRLF 写 `check-report.md`，执行 `stamp-check` + `set-commit` 后把同一文件转换为 LF，`verify --strict` 退出码为 0，不再出现 `check_report_changed_after_binding`。
- [ ] AC2. 在 AC1 基础上修改报告正文，`verify --strict` 仍以 `check_report_changed_after_binding` 拒绝，不能因为换行规范化放过真实内容变更。
- [ ] AC3. 旧绑定兼容：把 `meta.check_binding.report_sha256` 设为未改动文件的原始字节哈希，`verify --strict` 通过。
- [ ] AC4. 去掉报告开头的 UTF-8 BOM 或把 `\r\n` 改为 `\r` 后，规范化哈希不变，校验通过。
- [ ] AC5. `stamp-check` 产出的 `check-report.md` 不含 `\r\n` 字节（Windows 上同样成立）。
- [ ] AC6. `node --test scripts/test/task-check-binding.test.js` 全部通过，既有绑定/逃逸/证据门禁用例不回归。

## Out of Scope

- 不修改桌面端 pull 的并发覆盖保护（`apply_server_groups` / `write_task_directory`）；那是独立的 Rust 改动，另行建任务。
- 不改变 `meta.check_binding` 的字段结构，不新增第二个哈希字段。
- 不自动修复“旧绑定为 CRLF、且文件已经被同步重写为 LF”的历史任务；这类任务仍需一次重新 `set-commit`。
- 不调整 `.gitattributes`，不依赖任何客户端的 `core.autocrlf` 配置。

## Technical Notes

- 改动点：`task_store.py:2274`（写入绑定）、`:2799`（校验绑定）、`:2680`（stamp 写盘）。
- 规范化规则必须与 `packages/desktop/src-tauri/src/agent/task_sync/snapshot.rs:80-83` 保持一致，否则客户端与服务端仍会各算一套。
- 兼容判断顺序：先比规范化哈希，再比原始哈希；两者都不匹配才报错。
- 该任务只改 Python 脚本与 Node 测试，不涉及 Rust，本地可直接验证。

## Open Questions

- 旧原始哈希兼容是否长期保留？建议保留：成本只有一个分支，且能避免升级瞬间卡住进行中的任务。
