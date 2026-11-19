export function withTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 保留原始失败，避免回滚错误覆盖真正原因。
    }
    throw error
  }
}
