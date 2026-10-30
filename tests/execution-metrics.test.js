import test from "node:test";
import assert from "node:assert/strict";
import {
  computeExecutionMetrics,
  missingExecutionMetrics,
  summarizeExecutionMetrics
} from "../server/execution-metrics.js";

const NOW = new Date("2026-10-30T01:00:00.000Z");

function event(id, type, occurredAt, payload = {}, source = "scan") {
  return {
    id,
    type,
    source,
    actor: source === "system" ? "system" : "dev",
    occurredAt,
    payload,
    reversible: false
  };
}

function trackingEvent(occurredAt = "2026-10-30T00:00:00.000Z") {
  return event(1, "tracking_started", occurredAt, {
    after: { derivedStage: "implement" }
  }, "system");
}

test("空事件和仅追踪起点返回 missing，不把 tracking_started 当作阶段停留", () => {
  const empty = computeExecutionMetrics({ now: NOW });
  assert.equal(empty.completeness, "missing");
  assert.deepEqual(empty.missingReasons, ["没有可用事件"]);
  assert.equal(empty.leadTimeMs, null);
  assert.deepEqual(empty.stageDurations, []);

  const trackingOnly = computeExecutionMetrics({
    events: [trackingEvent()],
    now: NOW,
    eventTotal: 1
  });
  assert.equal(trackingOnly.completeness, "missing");
  assert.equal(trackingOnly.missingReasons.some((reason) =>
    reason.includes("tracking_started")
  ), true);
  assert.equal(trackingOnly.leadTimeMs, null);
  assert.deepEqual(trackingOnly.stageDurations, []);

  assert.deepEqual(
    summarizeExecutionMetrics(
      missingExecutionMetrics({ reasons: ["旧任务没有可信历史"] })
    ),
    {
      completeness: "missing",
      leadTimeMs: null,
      leadTimeOpen: false,
      cycleTimeMs: null,
      cycleTimeOpen: false,
      reworkCount: 0,
      blockedRatio: null,
      missingReasonCount: 1
    }
  );
});

test("缺少检查节点返回 partial，开放阶段计算到显式 now", () => {
  const metrics = computeExecutionMetrics({
    events: [
      trackingEvent(),
      event(2, "stage_observed", "2026-10-30T00:10:00.000Z", {
        before: { derivedStage: "review" },
        after: { derivedStage: "design" }
      }),
      event(3, "stage_manual_confirmed", "2026-10-30T00:20:00.000Z", {
        before: { stage: "design", updatedAt: "2026-10-30T00:10:00.000Z" },
        after: { stage: "implement", updatedAt: "2026-10-30T00:20:00.000Z" }
      }, "user")
    ],
    now: new Date("2026-10-30T00:40:00.000Z")
  });
  assert.equal(metrics.completeness, "partial");
  assert.equal(metrics.missingReasons.includes("缺少检查阶段完成事件"), true);
  assert.equal(metrics.missingReasons.some((reason) =>
    reason.includes("中间阶段停留无法精确拆分")
  ), true);
  assert.equal(metrics.leadTimeMs, 30 * 60_000);
  assert.equal(metrics.cycleTimeMs, 20 * 60_000);
  assert.equal(metrics.cycleTimeOpen, true);
  assert.deepEqual(
    metrics.stageDurations.map((item) => [
      item.stageId,
      item.durationMs,
      item.open
    ]),
    [
      ["design", 10 * 60_000, false],
      ["implement", 20 * 60_000, true]
    ]
  );
});

test("实现到检查连续覆盖且归档时返回 tracked 和固定归档终点", () => {
  const metrics = computeExecutionMetrics({
    events: [
      trackingEvent(),
      event(2, "stage_observed", "2026-10-30T00:10:00.000Z", {
        after: { derivedStage: "implement" }
      }),
      event(3, "stage_manual_confirmed", "2026-10-30T00:20:00.000Z", {
        after: { stage: "check", updatedAt: "2026-10-30T00:20:00.000Z" }
      }, "user")
    ],
    archived: true,
    archivedAt: "2026-10-30T00:40:00.000Z",
    now: NOW
  });
  assert.equal(metrics.completeness, "tracked");
  assert.deepEqual(metrics.missingReasons, []);
  assert.equal(metrics.leadTimeMs, 30 * 60_000);
  assert.equal(metrics.leadTimeOpen, false);
  assert.equal(metrics.cycleTimeMs, 10 * 60_000);
  assert.equal(metrics.cycleTimeOpen, false);
  assert.deepEqual(
    metrics.stageDurations.map((item) => [item.stageId, item.durationMs, item.open]),
    [
      ["implement", 10 * 60_000, false],
      ["check", 20 * 60_000, false]
    ]
  );
  assert.deepEqual(metrics.evidenceEventIds, [1, 2, 3]);
});

test("追踪起点已在实现之后且后续没有实现节点时保守返回 partial", () => {
  const metrics = computeExecutionMetrics({
    events: [
      trackingEvent("2026-10-30T00:10:00.000Z"),
      event(2, "stage_observed", "2026-10-30T00:20:00.000Z", {
        after: { derivedStage: "check" }
      })
    ],
    archived: true,
    archivedAt: "2026-10-30T00:40:00.000Z",
    now: NOW
  });
  assert.equal(metrics.completeness, "partial");
  assert.equal(metrics.missingReasons.includes("缺少实现阶段事件"), true);
  assert.equal(metrics.evidenceEventIds.includes(1), true);
  assert.equal(metrics.evidenceEventIds.includes(2), true);
});

test("归档时间早于最后阶段事件时保守返回 partial", () => {
  const metrics = computeExecutionMetrics({
    events: [
      trackingEvent(),
      event(2, "stage_observed", "2026-10-30T00:10:00.000Z", {
        after: { derivedStage: "implement" }
      }),
      event(3, "stage_observed", "2026-10-30T00:20:00.000Z", {
        after: { derivedStage: "check" }
      })
    ],
    archived: true,
    archivedAt: "2026-10-30T00:05:00.000Z",
    now: NOW
  });
  assert.equal(metrics.completeness, "partial");
  assert.equal(
    metrics.missingReasons.includes("归档时间早于最后阶段事件，无法确认结束区间"),
    true
  );
  assert.equal(metrics.leadTimeOpen, false);
  assert.equal(metrics.leadTimeMs, 10 * 60_000);
  assert.equal(metrics.stageDurations.at(-1).durationMs, 0);
});

test("阶段索引逆序时累计回流次数", () => {
  const metrics = computeExecutionMetrics({
    events: [
      trackingEvent(),
      event(2, "stage_observed", "2026-10-30T00:05:00.000Z", {
        after: { derivedStage: "implement" }
      }),
      event(3, "stage_observed", "2026-10-30T00:10:00.000Z", {
        after: { derivedStage: "check" }
      }),
      event(4, "stage_observed", "2026-10-30T00:15:00.000Z", {
        after: { derivedStage: "implement" }
      }),
      event(5, "stage_observed", "2026-10-30T00:20:00.000Z", {
        after: { derivedStage: "check" }
      }),
      event(6, "stage_observed", "2026-10-30T00:25:00.000Z", {
        after: { derivedStage: "implement" }
      })
    ],
    now: new Date("2026-10-30T00:40:00.000Z")
  });
  assert.equal(metrics.completeness, "tracked");
  assert.equal(metrics.reworkCount, 2);
});

test("重叠阻断区间只累计一次并保留证据事件", () => {
  const metrics = computeExecutionMetrics({
    events: [
      trackingEvent(),
      event(2, "stage_observed", "2026-10-30T00:00:00.000Z", {
        after: { derivedStage: "implement" }
      }),
      event(3, "stage_observed", "2026-10-30T00:30:00.000Z", {
        after: { derivedStage: "check" }
      }),
      event(4, "dependency_created", "2026-10-30T00:10:00.000Z", {
        dependencyId: "dep-a"
      }, "user"),
      event(5, "dependency_created", "2026-10-30T00:20:00.000Z", {
        dependencyId: "dep-b"
      }, "user"),
      event(6, "dependency_resolved", "2026-10-30T00:30:00.000Z", {
        dependencyId: "dep-a"
      }, "user"),
      event(7, "dependency_resolved", "2026-10-30T00:40:00.000Z", {
        dependencyId: "dep-b"
      }, "user")
    ],
    dependencies: [
      {
        id: "dep-a",
        createdAt: "2026-10-30T00:10:00.000Z",
        resolvedAt: "2026-10-30T00:30:00.000Z"
      },
      {
        id: "dep-b",
        createdAt: "2026-10-30T00:20:00.000Z",
        resolvedAt: "2026-10-30T00:40:00.000Z"
      }
    ],
    archived: true,
    archivedAt: "2026-10-30T01:00:00.000Z",
    now: NOW
  });
  assert.equal(metrics.blockedTimeMs, 30 * 60_000);
  assert.equal(metrics.blockedRatio, 0.5);
  assert.deepEqual(metrics.blockedEvidenceEventIds, [4, 5, 6, 7]);
});

test("撤销事件排除目标阶段，截断和固定夹具保持确定性", () => {
  const baseEvents = [
    trackingEvent(),
    event(2, "stage_observed", "2026-10-30T00:10:00.000Z", {
      after: { derivedStage: "implement" }
    }),
    event(3, "stage_observed", "2026-10-30T00:20:00.000Z", {
      after: { derivedStage: "check" }
    })
  ];
  const fixture = {
    events: baseEvents,
    archived: true,
    archivedAt: "2026-10-30T00:40:00.000Z",
    now: NOW
  };
  assert.deepEqual(
    computeExecutionMetrics(fixture),
    computeExecutionMetrics(fixture)
  );

  const truncated = computeExecutionMetrics({
    ...fixture,
    eventTotal: 1200,
    eventLimit: 1000,
    eventTruncated: true,
    eventWindowStartAt: "2026-10-30T00:00:00.000Z"
  });
  assert.equal(truncated.completeness, "partial");
  assert.equal(truncated.missingReasons.some((reason) =>
    reason.includes("1,000")
  ), true);

  const undoneCheck = computeExecutionMetrics({
    events: [
      ...baseEvents,
      event(4, "operation_undone", "2026-10-30T00:30:00.000Z", {
        targetCorrelationId: "check-group",
        targetEventIds: [3]
      }, "user")
    ],
    archived: true,
    archivedAt: "2026-10-30T00:40:00.000Z",
    now: NOW
  });
  assert.equal(undoneCheck.completeness, "partial");
  assert.equal(undoneCheck.missingReasons.includes("缺少检查阶段完成事件"), true);
  assert.deepEqual(undoneCheck.evidenceEventIds, [1, 2]);
});
