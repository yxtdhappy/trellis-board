# 实施计划: shared zip 解析换 fflate

## 前置

- 基线：`node --test apps/server/test/team-workspace-template.test.js` 全绿（4 个用例）。

## 步骤

1. 根目录安装依赖：`npm install fflate@^0.8.3`（写入根 `package.json` 的 `dependencies`）。
2. 重写 `packages/shared/zip.js`：
   - 保留 `ZipError`、`validateArchivePath`、三个限额常量、`RESERVED_WINDOWS_NAMES`。
   - 删除 `CRC_TABLE`、`crc32`、`decodeName`、`findEndOfCentralDirectory`、`readLocalHeader`、`inflateEntry`、`extractZipEntries` 与 `node:fs`/`node:zlib` import。
   - 实现 `readZipEntries`：filter 内完成 R1–R6 的校验，异常包装为 `ZipError`。
3. 新增 `packages/shared/test/zip.test.js`：用 `fflate` 的 `zipSync` 构造归档（`devDependencies` 不需要，fflate 已是运行时依赖），覆盖：
   - 正常归档（含目录条目）→ 名字、`isDirectory`、`data` 正确
   - `../`、绝对路径、盘符、反斜杠、Windows 保留名、ADS 冒号 → `ZipError`
   - 重名条目（构造两个同名条目）→ `ZIP 包含重复条目`
   - `maxEntries`/`maxEntryBytes`/`maxTotalBytes` 传小值 → 对应错误
   - 非 Buffer 输入、随机字节 → `ZipError`
   - 压缩方法 99（AES）→ `ZIP 不支持加密条目`
4. 确认下游无残留：`grep -rn "extractZipEntries\|zip.js" apps packages plugins scripts`。

## 验证

```bash
node --test packages/shared/test/zip.test.js
node --test apps/server/test/team-workspace-template.test.js
npm test
```

## 回滚点

单 commit：`git revert` 即恢复旧实现；`packages/shared` 无构建产物，无需清理缓存。

## 完成标准

- A1–A5 全部满足；`git diff --stat` 中 `zip.js` 为净删行。
