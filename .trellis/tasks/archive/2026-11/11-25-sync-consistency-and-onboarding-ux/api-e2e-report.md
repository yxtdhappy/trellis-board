# API E2E Report

- Task: `11-25-sync-consistency-and-onboarding-ux`
- Work type: `fullstack` (backend API change: `POST /api/agent/task-spaces/preflight`)
- Result: **PASS** (verified against local `createTeamRuntime` HTTP server + SQLite persistence)

## Verification Topology

- Local HTTP runtime: `packages/server/team/http.js::createTeamRuntime` bound on `127.0.0.1:0` with SQLite database (`board.sqlite`) and `enablePolling: false`.
- Authentication: Agent device bearer credentials issued via `POST /api/team/pairing-codes` + `POST /api/agent/enroll` (no external `Weareint-Token` applicable to Trellis Board local Agent API).

## Scenarios & Evidence

| Scenario | Layer | Request / Setup | Persistence / Side-effect Check | Response Result | Status |
| --- | --- | --- | --- | --- | --- |
| 本机持有活跃租约调用预检 | Contract + Persistence | `POST /api/agent/task-spaces/preflight`（`device1` 凭据，已 `claim` 任务 `leased-task`） | `sync_task_lease` 存在 `device1` 活跃租约；`syncCounts()` 在预检前后保持不变（零写库） | HTTP 200，`status: 'existing'`，`tasks` 包含 `['leased-task']`，无 `"content"` 字段 | PASS |
| 同用户第二台设备调用预检 | Contract + Persistence | `POST /api/agent/task-spaces/preflight`（`device2` 凭据，与 `device1` 同属 `owner`） | `sync_task_lease` 仍由 `device1` 持有活跃未过期租约；`syncCounts()` 零变化 | HTTP 200，`status: 'existing'`，`tasks: []`（正确排除他机活跃租约任务），无 `"content"` 字段 | PASS |
| 已有租约与过期租约边界矩阵 | Persistence | `service.preflight`（`team-task-spaces.test.js`）覆盖他机未过期租约、本机未过期租约、他机已过期租约 | `sync_task` / `sync_task_lease` SQL 查询精确按 `expires_at > now` 与 `lease.agent_id <> agentId` 过滤 | 返回 `['expired-other', 'held-self']`，排除 `held-other`，不含 `"content"` | PASS |

## Commands Run

- `node --test packages/server/test/team-gitless-http.test.js`：5 passed, 0 failed（含新增用例 `POST /api/agent/task-spaces/preflight HTTP 路由透传当前 agentId 排除他机活跃租约`）。
- `node --test packages/server/test/team-task-spaces.test.js`：17 passed, 0 failed。
