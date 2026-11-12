import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { taskIndexInsertArgs, taskIndexSearchText } from '../team/task-index.js'

const COLUMNS = [
  'project_id',
  'task_key',
  'execution_task_key',
  'relative_dir',
  'title',
  'search_text',
  'archived',
  'archived_at',
  'priority',
  'derived_stage',
  'assignee_dev_id',
  'assignee_user_id',
  'due_date',
  'last_activity_at',
  'is_blocked',
  'is_unblocked_ready',
  'attention_flags_json',
  'group_key',
  'group_role',
  'task_version',
  'board_version',
  'updated_at',
]

function createTable() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE team_task_index (
      project_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      execution_task_key TEXT NOT NULL,
      relative_dir TEXT NOT NULL,
      title TEXT NOT NULL,
      search_text TEXT NOT NULL,
      archived INTEGER NOT NULL,
      archived_at TEXT,
      priority TEXT NOT NULL,
      derived_stage TEXT NOT NULL,
      assignee_dev_id TEXT,
      assignee_user_id TEXT,
      due_date TEXT,
      last_activity_at TEXT,
      is_blocked INTEGER NOT NULL,
      is_unblocked_ready INTEGER NOT NULL,
      attention_flags_json TEXT NOT NULL,
      group_key TEXT NOT NULL,
      group_role TEXT NOT NULL,
      task_version TEXT NOT NULL,
      board_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return db
}

test('缺失 priority/derivedStage 的任务不会让索引写库失败', () => {
  const db = createTable()
  const args = taskIndexInsertArgs(
    {
      taskKey: '11-06-demo',
      relativeDir: '.trellis/tasks/11-06-demo',
      title: '演示任务',
      taskVersion: 'v1',
    },
    {
      projectId: 'p1',
      searchText: '演示任务',
      boardVersion: 'b1',
      now: '2026-11-06T00:00:00.000Z',
    },
  )
  assert.equal(args.length, COLUMNS.length)
  assert.equal(
    args.some((value) => value === undefined),
    false,
  )
  db.prepare(
    `INSERT INTO team_task_index(${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  ).run(...args)
  const row = db
    .prepare('SELECT priority, derived_stage, assignee_dev_id FROM team_task_index')
    .get()
  assert.deepEqual({ ...row }, { priority: '', derived_stage: '', assignee_dev_id: null })
  db.close()
})

test('保留已有字段并在 groupKey/executionTaskKey 缺省时回落到 taskKey', () => {
  const args = taskIndexInsertArgs(
    {
      taskKey: '11-06-demo',
      title: '演示任务',
      priority: 'P1',
      derivedStage: 'dev',
      groupRole: 'child',
      archived: true,
      archivedAt: '2026-11-09T08:00:00.000Z',
      taskVersion: 'v2',
      execution: { dueDate: '2026-11-10', isBlocked: true, tags: ['ui'] },
    },
    {
      projectId: 'p1',
      searchText: '演示任务',
      assigneeDevId: 'tester',
      assigneeUserId: 'user-1',
      boardVersion: 'b2',
      now: '2026-11-06T00:00:00.000Z',
    },
  )
  const row = Object.fromEntries(COLUMNS.map((column, index) => [column, args[index]]))
  assert.equal(row.execution_task_key, '11-06-demo')
  assert.equal(row.group_key, '11-06-demo')
  assert.equal(row.group_role, 'child')
  assert.equal(row.priority, 'P1')
  assert.equal(row.derived_stage, 'dev')
  assert.equal(row.archived, 1)
  assert.equal(row.archived_at, '2026-11-09T08:00:00.000Z')
  assert.equal(row.is_blocked, 1)
  assert.equal(row.due_date, '2026-11-10')
  assert.equal(row.assignee_dev_id, 'tester')
  assert.equal(row.assignee_user_id, 'user-1')
})

test('归档搜索文本包含项目名、已完成阶段和证据', () => {
  const text = taskIndexSearchText({
    title: '修复归档',
    projectName: '订单服务',
    taskKey: 'p1::.trellis/tasks/archive/2026-11/fix',
    stages: [
      {
        complete: true,
        label: '检查报告',
        evidence: 'tests/archive.test.js 通过',
      },
      {
        complete: false,
        label: '未完成阶段',
        evidence: '不应进入索引',
      },
    ],
  })
  assert.match(text, /订单服务/)
  assert.match(text, /检查报告/)
  assert.match(text, /tests\/archive\.test\.js 通过/)
  assert.doesNotMatch(text, /未完成阶段/)
})
