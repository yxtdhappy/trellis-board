import crypto from "node:crypto";
import {
  getDefaultDatabase,
  withTransaction
} from "./database.js";
import { appendTaskEvent } from "./execution-store.js";

const STAGES = [
  { id: "prd", label: "需求" },
  { id: "research", label: "调研" },
  { id: "design", label: "设计" },
  { id: "implementPlan", label: "实施计划" },
  { id: "context", label: "上下文编排" },
  { id: "review", label: "规划评审" },
  { id: "implement", label: "实现" },
  { id: "check", label: "检查" },
  { id: "e2e", label: "真实验证", optional: true },
  { id: "spec", label: "规范回写" },
  { id: "commit", label: "工作提交" },
  { id: "archive", label: "归档" },
  { id: "journal", label: "会话记录" }
];

export const STAGE_IDS = STAGES.map((stage) => stage.id);

function toManualRecord(row) {
  return row
    ? {
        stage: row.stage,
        updatedAt: row.updated_at
      }
    : null;
}

export function getManualRecord(projectId, taskId, db = getDefaultDatabase()) {
  const row = db.prepare(`
    SELECT stage, updated_at
    FROM task_stage
    WHERE task_key = ?
  `).get(`${projectId}/${taskId}`);
  return toManualRecord(row);
}

export function getManualRecords(db = getDefaultDatabase()) {
  const records = {};
  const rows = db.prepare("SELECT task_key, stage, updated_at FROM task_stage").all();
  for (const row of rows) {
    records[row.task_key] = toManualRecord(row);
  }
  return records;
}

export function setManualStage(
  projectId,
  taskId,
  stage,
  db = getDefaultDatabase(),
  options = {}
) {
  if (!STAGE_IDS.includes(stage)) {
    throw new Error(`未知阶段: ${stage}`);
  }
  const key = `${projectId}/${taskId}`;
  const updatedAt = new Date().toISOString();
  return withTransaction(db, () => {
    const previous = db.prepare(`
      SELECT stage, updated_at
      FROM task_stage
      WHERE task_key = ?
    `).get(key);
    db.prepare(`
      INSERT INTO task_stage(task_key, stage, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET
        stage = excluded.stage,
        updated_at = excluded.updated_at
    `).run(key, stage, updatedAt);
    const correlationId = options.executionTaskKey ? crypto.randomUUID() : null;
    if (options.executionTaskKey) {
      appendTaskEvent(db, {
        executionTaskKey: options.executionTaskKey,
        eventType: "stage_manual_confirmed",
        source: "user",
        actor: options.actor,
        correlationId,
        occurredAt: updatedAt,
        payload: {
          before: previous
            ? { stage: previous.stage, updatedAt: previous.updated_at }
            : null,
          after: { stage, updatedAt }
        },
        reversible: true
      });
    }
    return { stage, updatedAt, correlationId };
  });
}

export { STAGES };
