import crypto from 'node:crypto'

import { withTransaction } from '../database.js'

export function importArchiveSnapshot(db, taskSpaceId, snapshot) {
  return withTransaction(db, () => {
    const taskSpace = db
      .prepare(`
        SELECT archive_snapshot_id, archive_candidate_snapshot_id
        FROM sync_task_space
        WHERE id = ?
      `)
      .get(taskSpaceId)
    const activeSnapshotId = taskSpace?.archive_snapshot_id || null
    const previousCandidateId = taskSpace?.archive_candidate_snapshot_id || null
    const existingRows = db
      .prepare(`
        SELECT id, relative_path, blob_oid, sha256, task_dir, task_id,
               content_text, size_bytes, mime_type, storage_key, text_excerpt,
               source_head, snapshot_id
        FROM sync_archive_file
        WHERE task_space_id = ?
      `)
      .all(taskSpaceId)
    const existing = new Map(existingRows.map((row) => [row.relative_path, row]))
    const desired = new Map(snapshot.files.map((file) => [file.relativePath, file]))
    let contentChanged = false
    let legacyMetadataReplaced = false
    for (const [relativePath, file] of desired) {
      const row = existing.get(relativePath)
      if (
        !row ||
        row.sha256 !== file.sha256 ||
        row.task_dir !== file.taskDir ||
        (row.task_id || null) !== (file.taskId || null)
      ) {
        contentChanged = true
        break
      }
      if (
        row.blob_oid === 'legacy' ||
        !row.storage_key ||
        Number(row.size_bytes) !== Number(file.sizeBytes) ||
        row.mime_type !== file.mimeType
      ) {
        legacyMetadataReplaced = true
      }
    }
    if (!contentChanged) {
      for (const relativePath of existing.keys()) {
        if (!desired.has(relativePath)) {
          contentChanged = true
          break
        }
      }
    }
    const changed = contentChanged
    const timestamp = new Date().toISOString()
    if (!previousCandidateId) {
      const insertHistory = db.prepare(`
        INSERT OR IGNORE INTO sync_archive_file_history(
          id, task_space_id, snapshot_id, relative_path, blob_oid, sha256,
          content_text, size_bytes, mime_type, storage_key, text_excerpt,
          task_id, task_dir, source_head, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const row of existingRows) {
        insertHistory.run(
          row.id,
          taskSpaceId,
          row.snapshot_id || activeSnapshotId,
          row.relative_path,
          row.blob_oid,
          row.sha256,
          row.content_text || '',
          row.size_bytes,
          row.mime_type,
          row.storage_key,
          row.text_excerpt,
          row.task_id,
          row.task_dir,
          row.source_head,
          timestamp,
        )
      }
    }

    let snapshotRow = db
      .prepare('SELECT id FROM sync_archive_snapshot WHERE task_space_id = ? AND source_head = ?')
      .get(taskSpaceId, snapshot.head)
    const candidateSnapshotId = snapshotRow?.id || crypto.randomUUID()
    if (snapshotRow) {
      db.prepare(`
        UPDATE sync_archive_snapshot
        SET status = 'published',
            active = CASE WHEN id = ? THEN 1 ELSE 0 END,
            storage_root = ?, file_count = ?, byte_count = ?,
            manifest_sha256 = ?, published_at = ?, retired_at = NULL
        WHERE id = ?
      `).run(
        activeSnapshotId,
        snapshot.storageRoot,
        snapshot.fileCount,
        snapshot.byteCount,
        snapshot.manifestSha256,
        timestamp,
        candidateSnapshotId,
      )
    } else {
      db.prepare(`
        INSERT INTO sync_archive_snapshot(
          id, task_space_id, source_head, status, active, storage_root,
          file_count, byte_count, manifest_sha256, published_at, retired_at
        ) VALUES (?, ?, ?, 'published', 0, ?, ?, ?, ?, ?, NULL)
      `).run(
        candidateSnapshotId,
        taskSpaceId,
        snapshot.head,
        snapshot.storageRoot,
        snapshot.fileCount,
        snapshot.byteCount,
        snapshot.manifestSha256,
        timestamp,
      )
    }
    const activeHistory = db
      .prepare(`
        SELECT id, relative_path, sha256, size_bytes, mime_type
        FROM sync_archive_file_history
        WHERE task_space_id = ?
          AND (
            (snapshot_id = ?)
            OR (? IS NULL AND snapshot_id IS NULL)
          )
      `)
      .all(taskSpaceId, activeSnapshotId, activeSnapshotId)
    const activeFiles = new Map(activeHistory.map((row) => [row.relative_path, row]))

    db.prepare('DELETE FROM sync_archive_file WHERE task_space_id = ?').run(taskSpaceId)
    const insertFile = db.prepare(`
      INSERT INTO sync_archive_file(
        id, task_space_id, snapshot_id, relative_path, blob_oid, sha256, content_text,
        size_bytes, mime_type, storage_key, text_excerpt,
        task_id, task_dir, source_head, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const file of desired.values()) {
      const activeFile = activeFiles.get(file.relativePath)
      const reusableId =
        activeFile &&
        activeFile.sha256 === file.sha256 &&
        Number(activeFile.size_bytes) === Number(file.sizeBytes) &&
        activeFile.mime_type === file.mimeType
          ? activeFile.id
          : crypto.randomUUID()
      insertFile.run(
        reusableId,
        taskSpaceId,
        candidateSnapshotId,
        file.relativePath,
        file.blobOid,
        file.sha256,
        file.sizeBytes,
        file.mimeType,
        file.storageKey,
        file.textExcerpt || null,
        file.taskId,
        file.taskDir,
        snapshot.head,
        timestamp,
      )
    }
    db.prepare(`
      UPDATE sync_task_space
      SET archive_candidate_snapshot_id = ?,
          archive_revision = archive_revision + ?,
          updated_at = ?
      WHERE id = ?
    `).run(candidateSnapshotId, changed ? 1 : 0, timestamp, taskSpaceId)
    const archiveRevision = Number(
      db.prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?').get(taskSpaceId)
        .archive_revision,
    )

    const priorSuccess = db
      .prepare('SELECT last_success_at FROM sync_archive_sync_state WHERE task_space_id = ?')
      .get(taskSpaceId)?.last_success_at
    const needsIndex = true
    db.prepare(`
      UPDATE sync_archive_sync_state
      SET status = ?, ref_name = 'refs/heads/trellis-archive',
          remote_head = ?, last_success_at = ?, last_error = NULL,
          file_count = ?, byte_count = ?, updated_at = ?
      WHERE task_space_id = ?
    `).run(
      needsIndex ? 'indexing' : 'current',
      snapshot.head,
      timestamp,
      snapshot.fileCount,
      snapshot.byteCount,
      timestamp,
      taskSpaceId,
    )
    if (previousCandidateId && previousCandidateId !== candidateSnapshotId) {
      db.prepare(`
        DELETE FROM sync_archive_snapshot
        WHERE id = ? AND task_space_id = ? AND active = 0
      `).run(previousCandidateId, taskSpaceId)
    }
    return {
      changed,
      contentChanged,
      legacyMetadataReplaced,
      needsIndex,
      archiveRevision,
      firstSuccess: !priorSuccess,
    }
  })
}
