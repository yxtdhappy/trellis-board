import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { readZipEntries, validateArchivePath } from '../zip.js'

const encoder = new TextEncoder()

function archive(files) {
  return Buffer.from(zipSync(files))
}

function patchMethod(archiveBuffer, method) {
  const buffer = Buffer.from(archiveBuffer)
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  buffer.writeUInt16LE(method, centralOffset + 10)
  buffer.writeUInt16LE(method, buffer.readUInt32LE(centralOffset + 42) + 8)
  return buffer
}

test('读取归档保留条目顺序、目录标记与内容', () => {
  const entries = readZipEntries(
    archive({
      'docs/': new Uint8Array(0),
      'docs/readme.md': encoder.encode('# 说明'),
      'task.json': encoder.encode('{}'),
    }),
  )
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.isDirectory]),
    [
      ['docs', true],
      ['docs/readme.md', false],
      ['task.json', false],
    ],
  )
  assert.equal(entries[0].data.length, 0)
  assert.equal(entries[1].data.toString('utf8'), '# 说明')
  assert.equal(Object.hasOwn(entries[1], 'mode'), false)
})

test('拒绝非 Buffer 输入与损坏归档', () => {
  assert.throws(() => readZipEntries(new Uint8Array([1, 2, 3])), {
    name: 'ZipError',
    message: 'ZIP 输入必须是 Buffer',
  })
  assert.throws(() => readZipEntries(Buffer.from([1, 2, 3])), {
    name: 'ZipError',
    message: 'ZIP 解析失败',
  })
})

test('拒绝逃逸路径与非法条目名', () => {
  const cases = [
    ['../evil.txt', 'ZIP 条目路径不能包含相对段'],
    ['/abs.txt', 'ZIP 条目名称不能是绝对路径'],
    ['dir\\file.txt', 'ZIP 条目名称包含反斜杠'],
    ['CON.txt', 'ZIP 条目路径使用了 Windows 保留名称'],
    ['file.txt:stream', 'ZIP 条目路径不能包含备用数据流'],
    ['trailing./file.txt', 'ZIP 条目路径不能以点或空格结尾'],
  ]
  for (const [name, message] of cases) {
    assert.throws(() => readZipEntries(archive({ [name]: new Uint8Array([1]) })), { message }, name)
  }
})

test('拒绝大小写重复的条目', () => {
  assert.throws(
    () => readZipEntries(archive({ 'A.txt': new Uint8Array([1]), 'a.txt': new Uint8Array([2]) })),
    {
      message: 'ZIP 包含重复条目',
    },
  )
})

test('条目数、单条大小与总量限额在解压前生效', () => {
  const payload = archive({
    'a.txt': encoder.encode('0123456789'),
    'b.txt': encoder.encode('0123456789'),
  })
  assert.throws(() => readZipEntries(payload, { maxEntries: 1 }), {
    message: 'ZIP 条目数量超过限制',
  })
  assert.throws(() => readZipEntries(payload, { maxEntryBytes: 5 }), {
    message: 'ZIP 条目解压后超过大小限制',
  })
  assert.throws(() => readZipEntries(payload, { maxTotalBytes: 15 }), {
    message: 'ZIP 解压总量超过限制',
  })
})

test('拒绝加密条目与未知压缩方法', () => {
  const payload = archive({ 'a.txt': encoder.encode('secret') })
  assert.throws(() => readZipEntries(patchMethod(payload, 99)), {
    message: 'ZIP 不支持加密条目',
  })
  assert.throws(() => readZipEntries(patchMethod(payload, 12)), {
    message: 'ZIP 使用了不支持的压缩方法',
  })
})

test('validateArchivePath 保留既有规则', () => {
  assert.equal(validateArchivePath('tasks/demo/task.json'), 'tasks/demo/task.json')
  assert.equal(validateArchivePath('docs/', { directory: true }), 'docs')
  assert.throws(() => validateArchivePath(''), { name: 'ZipError', message: 'ZIP 条目名称为空' })
  assert.throws(() => validateArchivePath('C:/x.txt'), { message: 'ZIP 条目名称不能包含盘符' })
})
