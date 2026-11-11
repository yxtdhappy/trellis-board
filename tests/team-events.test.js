import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

test('Agent 事件流只保留单活动 Agent、任务空间变更和命令事件', () => {
  const http = read('server/team/http.js')
  const events = read('server/team/agent-event-stream.js')
  assert.match(http, /createAgentEventStream/)
  assert.equal(http.includes('startMatch'), true)
  assert.doesNotMatch(http, /\/api\/agent\/event-cursor/)
  assert.doesNotMatch(http, /agentEvents\.openStream/)
  assert.match(events, /agent\.revoked/)
  assert.match(events, /command/)
  assert.match(events, /task\.changed/)
  assert.match(events, /sync_active_agent/)
  assert.match(events, /staleLeases/)
  assert.match(events, /markDelivered/)
  assert.doesNotMatch(events, /publishTaskEvent|Last-Event-ID|event_cache/)
})

test('旧实时覆盖层和 Git 凭据路由不再出现在 Team 客户端 API', () => {
  const api = read('agent/api.js')
  assert.doesNotMatch(api, /live-changes|live-files|live-cursor|git-operations/)
  assert.match(api, /task-spaces/)
  assert.match(api, /commands\/\$\{encodedId\}\/start/)
  assert.match(api, /commands\/\$\{encodedId\}\/result/)
})
