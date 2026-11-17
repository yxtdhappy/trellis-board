import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentEventStream } from '../team/agent-event-stream.js'

function createResponse() {
  const lines = []
  return {
    lines,
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(line) {
      lines.push(line)
      return true
    },
    end() {
      this.writableEnded = true
    },
    on() {},
  }
}

function createFixture(agentIds) {
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT 1 FROM sync_active_agent')) {
        return { get: () => ({ found: 1 }) }
      }
      if (sql.includes('SELECT agent_id') && sql.includes('sync_agent_binding')) {
        return {
          all: () => agentIds.map((agentId) => ({ agent_id: agentId })),
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
  const events = createAgentEventStream({
    db,
    commands: {
      staleLeases() {},
      available() {
        return []
      },
    },
  })
  const responses = new Map()
  for (const agentId of agentIds) {
    const response = createResponse()
    responses.set(agentId, response)
    events.open({
      agent: { id: agentId, userId: `user-${agentId}` },
      response,
    })
  }
  return { events, responses }
}

function taskChangedPayloads(response) {
  return response.lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((payload) => payload.type === 'task.changed')
}

test('Agent task.changed 按 taskSpace 只广播递增 revision', () => {
  const { events, responses } = createFixture(['agent-1', 'agent-2'])

  events.notifyTaskSpaceChanged('space-a', 10)
  events.notifyTaskSpaceChanged('space-a', 10)
  events.notifyTaskSpaceChanged('space-a', 9)
  events.notifyTaskSpaceChanged('space-a', 11)
  events.notifyTaskSpaceChanged('space-b', 5)
  events.notifyTaskSpaceChanged('space-b', 5)
  events.notifyTaskSpaceChanged('space-c', -1)
  events.notifyTaskSpaceChanged('space-c', 1.5)

  const expected = [
    { type: 'task.changed', taskSpaceId: 'space-a', revision: 10 },
    { type: 'task.changed', taskSpaceId: 'space-a', revision: 11 },
    { type: 'task.changed', taskSpaceId: 'space-b', revision: 5 },
  ]
  assert.deepEqual(taskChangedPayloads(responses.get('agent-1')), expected)
  assert.deepEqual(taskChangedPayloads(responses.get('agent-2')), expected)
  events.close()
})
