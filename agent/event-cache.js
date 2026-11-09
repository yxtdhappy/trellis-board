import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function safeSegment(value) {
  const text = String(value || '')
  if (!text) return null
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function createEventCache({ root }) {
  const baseDir = path.resolve(root, 'events')

  function taskFile(teamId, projectId, executionTaskKey) {
    const team = safeSegment(teamId)
    const project = safeSegment(projectId)
    const task = safeSegment(executionTaskKey)
    if (!team || !project || !task) return null
    return path.join(baseDir, team, project, `${task}.json`)
  }

  async function readSnapshot(teamId, projectId, executionTaskKey) {
    const file = taskFile(teamId, projectId, executionTaskKey)
    if (!file) return null
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      return null
    }
  }

  async function writeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null
    const teamId = snapshot.teamId
    const projectId = snapshot.projectId
    const executionTaskKey = snapshot.executionTaskKey || snapshot.taskKey
    const file = taskFile(teamId, projectId, executionTaskKey)
    if (!file) return null
    const existing = await readSnapshot(teamId, projectId, executionTaskKey)
    if (
      existing &&
      String(existing.taskVersion) === String(snapshot.taskVersion) &&
      Boolean(existing.archived) === Boolean(snapshot.archived)
    ) {
      return { ...existing, unchanged: true }
    }
    const record = {
      schemaVersion: 1,
      cachedAt: new Date().toISOString(),
      ...snapshot,
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    })
    await fs.rename(temporary, file)
    return record
  }

  return {
    readSnapshot,
    writeSnapshot,
  }
}
