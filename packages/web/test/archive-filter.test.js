import assert from 'node:assert/strict'
import test from 'node:test'
import {
  archiveProjectAfterTeamChange,
  resolveArchiveProjectId,
} from '../src/lib/archive-filter.js'

const projects = [
  { id: 'project-a', name: 'A', teamId: 'team-1' },
  { id: 'project-b', name: 'B', teamId: 'team-2' },
]

test('resolveArchiveProjectId 保留可访问项目，其余回落到全部', () => {
  assert.equal(resolveArchiveProjectId('project-b', projects), 'project-b')
  assert.equal(resolveArchiveProjectId('project-removed', projects), 'all')
  assert.equal(resolveArchiveProjectId('all', projects), 'all')
  assert.equal(resolveArchiveProjectId('', projects), 'all')
})

test('archiveProjectAfterTeamChange 在项目不属于新团队时写回全部', () => {
  assert.equal(archiveProjectAfterTeamChange('project-a', 'team-2', projects), 'all')
  assert.equal(archiveProjectAfterTeamChange('project-a', 'team-1', projects), 'project-a')
  assert.equal(archiveProjectAfterTeamChange('project-a', 'all', projects), 'project-a')
  assert.equal(archiveProjectAfterTeamChange('all', 'team-2', projects), 'all')
})
