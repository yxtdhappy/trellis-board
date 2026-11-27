import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { statusLabel } from '../src/features/admin/archive-sync-format.ts'
import { statusTone } from '../src/lib/admin-shared.ts'

test('worktree_skipped 状态映射为中性提示文案', () => {
  assert.equal(statusLabel('worktree_skipped'), 'Worktree · 免归档同步')
  assert.equal(statusTone('worktree_skipped'), 'neutral')
})

test('ArchiveSyncTaskSpaceRow 对 worktree 隐藏立即同步按钮与错误展示', () => {
  const rowSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/features/admin/ArchiveSyncTaskSpaceRow.tsx'),
    'utf8',
  )
  assert.match(rowSource, /taskSpace\.isWorktree \|\| taskSpace\.status === 'worktree_skipped'/)
  assert.match(rowSource, /\{!isWorktree \? \([\s\S]*立即同步/)
  assert.match(rowSource, /Worktree 分支一般不推送远端，归档随基线分支同步/)
})
