# 设计: shared zip 解析换 fflate

## 事实核对（fflate 0.8.3 实测）

| 行为 | 实测结果 | 影响 |
| --- | --- | --- |
| `unzipSync(buffer, { filter })` 的 filter 字段 | `{ name, size, originalSize, compression }`，在解压前逐个调用 | 限额可用 `originalSize` 提前判定 |
| filter 内 `throw` | 异常向上传播，中断整个解析 | 拒绝分支直接 throw `ZipError` |
| filter 返回 `false` | 静默跳过该条目（不报错） | **不能**用返回值表达拒绝 |
| 返回值 | 以名字为键的对象；重名条目静默折叠（后者覆盖前者） | 必须在 filter 内用 Set 检测重名 |
| CRC-32 | 不校验（改坏中央目录 CRC 仍返回数据） | 见下方取舍 |
| 加密 | 只置 flag 不报错；真实加密数据因压缩方法 99 或 inflate 失败而报错 | 显式拒绝 `compression === 99`，其余包装为 `ZIP 解析失败` |
| ZIP64 | 支持（`z64hs` 读 zip64 extra field） | 不再拒绝 ZIP64，放宽行为 |

## 决策

- **单遍实现**：`unzipSync(buffer, { filter })`，filter 内依次做：加密/压缩方法检查 → 条目数 → 单条 `originalSize` → 总量累计 → `validateArchivePath` → 小写去重。任何一条不满足就 `throw new ZipError(...)`。
- **错误包装**：`try { unzipSync(...) } catch (error) { if (error instanceof ZipError) throw error; throw new ZipError('ZIP 解析失败', { cause: error }) }`，保证调用方只需要识别 `ZipError`。
- **数据转换**：fflate 返回 `Uint8Array`，输出时 `Buffer.from(data)`；目录条目（名字以 `/` 结尾）保持 `data` 为空 Buffer。
- **删除 `mode`**：核对结果——`workspace-templates.js:163-166` 只用 `name`/`isDirectory`/`data`，`extractZipEntries`（唯一读 `mode` 的地方）被删除，仓库内无其他消费者。
- **不校验 CRC-32**：保留需要重新解析中央目录取期望 CRC（约 30 行），与本次「删手工解析」的目标相悖；模板归档的完整性由 `template-manifest.json` 里的 sha256 保证（`workspace-templates.js:162-167` 逐条比对）。风险：本模块若将来用于解压不可信归档，需要恢复 CRC 或改用清单校验。
- **删除 `extractZipEntries`**：`grep` 全仓库无调用者（含 `.rs`/`.mjs`），是随旧实现留下的死代码。

## 目标形状

```js
import { unzipSync } from 'fflate'

export class ZipError extends Error { /* 不变 */ }
export function validateArchivePath(rawName, { directory = false } = {}) { /* 不变，原样保留 */ }
export function readZipEntries(buffer, { maxEntries, maxEntryBytes, maxTotalBytes } = {}) {
  // filter 内做全部校验；返回值映射为 [{ name, isDirectory, data }]
}
```

## 风险

- `validateArchivePath` 的输入来自 fflate 解码后的名字；非 UTF-8 文件名 fflate 会按 latin1 回退，可能产生乱码名字而不是抛错（旧实现 `decodeName` 用 `fatal: true` 会抛）。测试用 UTF-8 归档，不覆盖该分支；若需要严格拒绝，应在 filter 内检查名字是否含替换字符。
- 体积：`fflate` 无运行时依赖，压缩后约 8 KB，服务端包体影响可忽略。
