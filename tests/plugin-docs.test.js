import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const DOCS = [
  '.trellis/tasks/archive/2026-11/11-04-plugin-architecture/prd.md',
  '.trellis/tasks/archive/2026-11/11-04-plugin-architecture/implement.md',
]

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function tableBlocks(lines) {
  const blocks = []
  let current = null
  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^```/.test(line.trim())) {
      inFence = !inFence
      current = null
      continue
    }
    if (inFence) continue
    if (!line.trim().startsWith('|')) {
      current = null
      continue
    }
    if (!current) {
      current = { start: index + 1, rows: [] }
      blocks.push(current)
    }
    current.rows.push({ line: index + 1, text: line })
  }
  return blocks
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
}

test('PRD 与执行计划的表格结构完整（无表头断裂、列数一致）', () => {
  for (const doc of DOCS) {
    const blocks = tableBlocks(read(doc).split('\n'))
    for (const block of blocks) {
      assert.ok(block.rows.length >= 2, `${doc}:${block.start} 表格只有一行，缺少表头或分隔行`)
      const separator = block.rows[1].text.trim()
      assert.match(
        separator,
        /^\|?[\s:|-]+\|?$/,
        `${doc}:${block.rows[1].line} 表格缺少分隔行（可能被段落打断）`,
      )
      const width = cells(block.rows[0].text)
      for (const row of block.rows) {
        assert.equal(
          cells(row.text),
          width,
          `${doc}:${row.line} 表格列数为 ${cells(row.text)}，表头为 ${width}`,
        )
      }
    }
  }
})

test('PRD 代码索引的行号与仓库一致', () => {
  const lines = read(DOCS[0]).split('\n')
  const start = lines.findIndex((line) => line.startsWith('## 24.'))
  assert.ok(start >= 0, '找不到代码索引段落')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const section = lines.slice(start, end < 0 ? undefined : end)

  let checked = 0
  for (const line of section) {
    if (!line.trim().startsWith('|')) continue
    const locations = [...line.matchAll(/`([^`\s]+):(\d+)`/g)]
    if (locations.length === 0) continue
    const tokens = [...line.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((token) => !/^[^`\s]+:\d+$/.test(token))
      .filter((token) => !token.includes('/') || token.includes(' '))
    assert.ok(tokens.length > 0, `锚点行没有可校验的符号: ${line}`)
    for (const location of locations) {
      const relative = location[1]
      const lineNumber = Number(location[2])
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8').split('\n')
      assert.ok(
        lineNumber >= 1 && lineNumber <= source.length,
        `${relative}:${lineNumber} 超出文件行数 ${source.length}`,
      )
      const actual = source[lineNumber - 1]
      const lineMatches = tokens.some((token) => actual.includes(token))
      const symbolExists = tokens.some((token) => source.some((text) => text.includes(token)))
      assert.ok(
        lineMatches || symbolExists,
        `${relative}:${lineNumber} 不包含 ${tokens.join(' / ')}，文件中也不存在该符号；实际为: ${actual.trim()}`,
      )
      checked += 1
    }
  }
  assert.ok(checked >= 10, `只校验了 ${checked} 个锚点，索引表可能未被解析`)
})
