import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
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
