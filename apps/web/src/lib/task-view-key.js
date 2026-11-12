function scopedKey(task, key) {
  const taskSpaceId = String(task?.taskSpaceId || '')
  return taskSpaceId ? `${taskSpaceId}\0${key || ''}` : String(key || '')
}

export function taskInstanceKey(task = {}) {
  return scopedKey(task, task.taskKey)
}

export function taskGroupInstanceKey(task = {}) {
  return scopedKey(task, task.groupKey || task.taskKey)
}
