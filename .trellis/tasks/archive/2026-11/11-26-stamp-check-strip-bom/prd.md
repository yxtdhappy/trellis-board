# stamp-check 写回时剥离报告 BOM

## Goal

让 `stamp-check` 在重写 `check-report.md` 前剥离开头的 UTF-8 BOM，正确识别并更新已有 front matter，而不是把它当成正文再插入一段重复的 front matter。

## Background

`task.py stamp-check` 通过 `_update_report_front_matter` 重写报告：

- 写侧 `.trellis/scripts/common/task_store.py:2663-2665` 直接 `read_text()` 后用 `lines[0].strip() == "---"` 判断 front matter；
- Python 的 `str.strip()` 不去掉 `U+FEFF`，所以带 BOM 的文件首行是 `"﻿---"`，判断失败；
- 写侧于是把整个文件当正文，在最前面插入只含 `base`/`commit`/`scope`/`diff` 的新 front matter；
- 原有 `mode`/`agent`/`session` 变成正文，后续 `_read_report_front_matter` 只读第一段，verify 报 `check_report_provenance_missing`。

读侧在上一任务中已经会剥离 BOM（`task_store.py:2574`），但写侧没有同步，形成“BOM 报告能通过 verify，却一 stamp 就坏”的组合缺陷。触发源包括 Windows 记事本、PowerShell `utf8BOM`、部分编辑器另存的报告。

## Requirements

- R1. `_update_report_front_matter` 在解析前剥离开头的 UTF-8 BOM，与读侧 `_read_report_front_matter` 的行为一致。
- R2. 重写后文件以 `---` 开头（不再保留 BOM），只包含一段 front matter；原有 `mode`/`agent`/`session` 保留，`base`/`commit`/`scope`/`diff` 正常更新。
- R3. 非 BOM 报告的现有行为不变。
- R4. 在 `scripts/test/task-check-binding.test.js` 增加用例：BOM + 已有 front matter → `stamp-check` → 只有一段 front matter、provenance 保留、`set-commit` 后 `verify --strict` 通过。
- R5. 修改 `task_store.py` 后运行 `python trellis-kit/build_overlay.py`，并把 `trellis-kit/overlay/.trellis/scripts/common/task_store.py` 纳入同一次提交。

## Acceptance Criteria

- [ ] AC1. 对带 BOM、已有 `mode: independent` / `agent` / `session` 的 `check-report.md` 执行 `stamp-check`，输出文件不再以 BOM 开头，且只有一段 front matter。
- [ ] AC2. `stamp-check` 后 `mode`/`agent`/`session` 仍可被 `_read_report_front_matter` 读到；`set-commit` 后 `verify --strict` 退出码为 0。
- [ ] AC3. 非 BOM 报告的既有用例全部通过，无行为回归。
- [ ] AC4. `node --test scripts/test/task-check-binding.test.js` 与 `yarn test --scope=scripts` 全部通过。
- [ ] AC5. `trellis-kit/overlay/.trellis/scripts/common/task_store.py` 与源文件字节一致（`scripts/test/trellis-kit.test.js` 的 overlay 断言通过）。

## Out of Scope

- 不改变 BOM 之外的编码处理（非 UTF-8、UTF-16 等）。
- 不改变绑定哈希算法与旧绑定兼容逻辑（上一任务已完成）。
- 不修改桌面同步、git attributes 或其他报告写入路径。

## Technical Notes

- 改动点：`task_store.py:2663`，建议改为 `text = path.read_text(encoding="utf-8").lstrip(chr(0xFEFF))`，与读侧 `:2574` 保持一致。
- 重写仍使用 `newline="\n"`，不保留 BOM。
- 新增测试放在 `scripts/test/task-check-binding.test.js`，沿用现有 `createTask` / `stamp-check` / `set-commit` / `verify` 子进程模式。
- 该任务只改 Python 脚本与 Node 测试，不涉及 Rust，本地可直接验证。

## Open Questions

- 无。BOM 在写回时丢弃即可，与同步层的 LF 规范化方向一致。
