# 实时同步换行规范化与新客户端兼容

## Goal

让团队实时同步把 `.trellis` 文本统一视为 LF 内容：服务端按 LF 存储、比较和收敛，语义相同的 CRLF/LF 差异不再制造 revision 或冲突提示；新客户端在拉取时对仅换行差异静默落盘为 LF。

## Background

- 当前服务端在 [normalizeFiles](../../../server/team/live-sync.js:350) 中只校验客户端原始内容摘要，随后原样保存 `content` 和 `sha256`。
- 当前 [applyChanges](../../../server/team/live-sync.js:641) 只按 `clientSequence` 判断旧批次，不判断规范化后的内容是否与现有实时内容相同。
- 当前 [listFiles](../../../server/team/live-sync.js:852) 返回数据库中保存的原始内容和 SHA。
- 当前 [convergeGit](../../../server/team/live-sync.js:1201) 直接比较 Git 工作区原始字节与实时 SHA，CRLF/LF 不同会被认为尚未收敛。
- 当前新客户端在 [\_backupConflicts](../../../agent/live-sync.js:924) 中直接比较本地原始 SHA 与服务端 SHA，因此仅换行差异会生成备份和冲突提示。
- Trellis Python 在 Windows 上可能把 `\n` 写成 `\r\n`，且不能要求所有客户机修改 Trellis 源码，因此规范点应放在团队同步服务和统一发布的客户端。
- 现有远端实时文本已统一为 LF；本次不处理历史数据迁移，也不保证旧客户端的行为。

## Requirements

### R1 LF 是服务端唯一规范

- 服务端接收白名单内文本 `upsert` 后，必须在确认原始内容和客户端 SHA 一致后，把 `CRLF` 规范为 `LF`。
- 服务端只转换 `\r\n` 为 `\n`，不修改单独 `\r`、空格、尾随换行、字符或 JSON 语义。
- `delete` 操作保持现有语义。
- 原始 SHA 校验继续保留，用于发现传输损坏或伪造摘要。
- 数据库 `content_text` 和 `sha256` 保存 LF 规范内容及对应 SHA。

### R2 规范化相同不产生新 revision

- 新上传内容规范化后与 `project_live_file` 现有内容完全相同时，该文件按 no-op 处理。
- 整批文件都是 no-op 时，不增加项目 revision、不重新投影、不广播 `live.changed`。
- 仅换行不同的上传可以更新来源客户端序号等顺序元数据，但不能改变规范化内容或造成版本回退。
- 有任一文件发生实质性内容变化时，整批仍按现有 revision 流程提交。
- `requestHash`、ingest 摘要和存储摘要都应基于规范化内容，保证同一语义内容不会因 CRLF/LF 产生幂等冲突。

### R3 拉取与 Git 收敛统一使用 LF

- `listFiles` 返回数据库中的 LF 规范内容和对应该内容的 SHA。
- `convergeGit` 比较 Git 工作区文本和实时内容前，双方都先规范为 LF。
- 只有换行不同的 Git 文件应视为已经收敛，不再显示“实时未入 Git”或 `needs_repair`。
- 实质内容或删除状态不同的文件仍保持现有未收敛行为。

### R4 新客户端静默处理仅换行差异

- 新客户端拉取远端文本时，本地和服务端都能按 UTF-8 解码且只在 `CRLF/LF` 上不同时，视为无内容冲突。
- 仅换行差异不创建备份、不生成 `remote_overwrite` 控制事件、不提供一键复原入口。
- 客户端仍把服务端 LF 内容原子写回本地，并设置正确的 watcher 自触发抑制摘要。
- 实质内容差异、删除/新增差异、非法 UTF-8 和本地不存在仍按现有冲突备份与提示流程处理。

### R5 范围与兼容

- 不迁移或重写已有 `project_live_file` 历史行；前提是部署前远端实时内容已经全部为 LF。
- 不兼容旧客户端的冲突提示行为；发布后以安装新客户端的环境为验收对象。
- 不修改客户机上的 Trellis Python 源码或 Git 全局配置。
- 不引入二进制规范化、Unicode 规范化、JSON 结构比较或空白字符忽略。

## Acceptance Criteria

- [ ] 客户端上传 CRLF 文本后，服务端数据库保存 LF 内容和 LF 内容的 SHA。
- [ ] 同一文本随后以 LF 上传时不增加项目 revision；以 CRLF 再上传也不增加 revision。
- [ ] 文本内容真实变化时仍增加 revision，并且只保存 LF 规范内容。
- [ ] 原始 `file.sha256` 与原始内容不一致时仍返回 400，不能因为规范化而绕过完整性校验。
- [ ] 全批次都是规范内容 no-op 时不广播 `live.changed`，审计记录能标识 skipped/no-op 路径。
- [ ] `listFiles` 对所有新写入文件返回 LF 内容和与内容匹配的 SHA。
- [ ] Git 工作区文件为 CRLF、实时内容为相同文本的 LF 时，`convergeGit` 删除对应实时覆盖行。
- [ ] 新客户端遇到本地 CRLF、远端相同文本 LF 时直接写回 LF，不创建备份、不弹覆盖提示。
- [ ] 新客户端遇到实质内容差异时仍按现有流程先备份、覆盖并提示一键复原。
- [ ] 自动化测试覆盖服务端 CRLF→LF、no-op、真实变更、Git 收敛和客户端静默收敛。

## Out of Scope

- 历史 `project_live_file` 数据迁移。
- 旧版本桌面客户端的提示和冲突行为。
- 修改 Trellis Python、Tauri 以外客户机的源码。
- 修改 Git 全局换行配置或全仓 renormalize。
- 忽略除 CRLF/LF 之外的空格、尾随换行、Unicode 或 JSON 语义差异。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
