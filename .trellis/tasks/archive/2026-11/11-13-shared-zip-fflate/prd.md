# PRD: shared zip 解析换 fflate

## 目标

`packages/shared/zip.js` 现有 278 行手写 ZIP 解析（EOCD 定位、本地文件头、inflate、CRC-32 表）。用 `fflate` 替换解压与目录解析，保留路径安全校验与条目限额，删除仓库内无调用者的死代码。

## 需求

- R1 `readZipEntries(buffer, limits)` 导出签名与默认限额不变：`maxEntries=10_000`、`maxEntryBytes=64 MiB`、`maxTotalBytes=256 MiB`；非 Buffer 输入仍抛 `ZIP 输入必须是 Buffer`。
- R2 返回结构保持 `{ name, isDirectory, data }`；`mode` 字段删除（仓库内无消费者，见 design.md 核对结果）。
- R3 `validateArchivePath(rawName, { directory })` 的规则与错误文案逐条保持（空名、空字符、反斜杠、绝对路径、盘符、控制字符、空段、`.`/`..`、ADS 冒号、点/空格结尾、Windows 保留名）。
- R4 `ZipError` 保持导出（`name='ZipError'`，`code` 默认 `ZIP_INVALID`，支持 `cause`）。
- R5 删除 `extractZipEntries`、`crc32`、`CRC_TABLE`、`decodeName`、`findEndOfCentralDirectory`、`readLocalHeader`、`inflateEntry`。
- R6 加密条目、不支持的压缩方法、损坏归档必须抛 `ZipError`，不得返回数据。
- R7 `fflate@^0.8.3` 声明在根 `package.json`（`packages/shared` 是 workspace，按项目约定共享依赖提升到根）。
- R8 新增 `packages/shared/test/zip.test.js`（该目录当前没有 zip 测试）。

## 非目标

- 不做 ZIP 写入/打包能力。
- 不改 `apps/server/team/workspace-templates.js` 的错误文案与清单校验逻辑。
- 不支持分卷归档。

## 约束

- 限额必须在解压前判定，用 fflate filter 暴露的 `originalSize`。
- 重复条目（大小写不敏感）必须拒绝。
- 不再校验 CRC-32：fflate 不暴露中央目录里的期望 CRC，消费方 `workspace-templates.js` 用清单 sha256 校验完整性；该取舍写入 design.md。

## 验收

- A1 `packages/shared/zip.js` 行数 ≤ 140（当前 278）。
- A2 `node --test packages/shared/test/zip.test.js apps/server/test/team-workspace-template.test.js` 全绿。
- A3 `npm test` 全绿（当前 474 用例）。
- A4 `grep -rn extractZipEntries apps packages plugins scripts` 无结果。
- A5 新测试覆盖 R1–R6 的每个拒绝分支（相对路径、绝对路径、盘符、反斜杠、保留名、重复条目、条目数超限、单条超限、总量超限、非 Buffer、损坏归档）。
