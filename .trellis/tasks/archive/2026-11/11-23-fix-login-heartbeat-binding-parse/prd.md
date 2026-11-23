# 修复客户端登录心跳绑定解析失败

## Goal

修复桌面客户端在登录复用设备（`reusable_device`）及运行期心跳（`heartbeat_once`）时，因服务端心跳响应返回 `BINDING_UNKNOWN`、`REMOTE_MISMATCH` 或 `disabled` 状态而被客户端误判为「绑定 ID 格式无效 / 项目 ID 格式无效 / 本地仓库标识无效 / 未知绑定状态」的问题，确保登录不被阻断、运行期心跳不陷入持续报错，并将失效或停用状态准确同步到本地绑定配置与 ProjectRail 展示。

## Background & Confirmed Facts

- 登录复用链路：`packages/desktop/src-tauri/src/agent/device.rs:627-697`（`reusable_device`）与 `packages/desktop/src-tauri/src/agent/device.rs:781-785`（`complete_login`）在同服务器同账号登录时携带本地 `existing.bindings` 调用 `POST /api/agent/heartbeat`，并执行 `parse_heartbeat_response(&payload)?`。`INVALID_RESPONSE` 不属于认证失效（401/403/`AUTH_REVOKED`），直接中断登录并向登录页抛出错误。
- 运行期心跳链路：`packages/desktop/src-tauri/src/agent/runtime.rs:191-243`（`heartbeat_once`）同样调用 `protocol::parse_heartbeat_response(&response)?`，随后调用 `merge_heartbeat_bindings(&mut next, &heartbeat)`（`packages/desktop/src-tauri/src/agent/runtime.rs:675-751`）。
- 服务端契约（`packages/server/team/sync-agent-service.js:422-482`，已有 `packages/server/test/team-agent-slot.test.js:354-388` 与 `packages/server/test/team-gitless-http.test.js:1093-1108` 锁定）：
  1. `BINDING_UNKNOWN`（`packages/server/team/sync-agent-service.js:435-445`）：服务端无对应 `sync_agent_binding` 记录（例如任务空间/项目被删除或服务端解绑）时返回 `{ taskSpaceId, status: "rejected", errorCode: "BINDING_UNKNOWN", error: "当前设备尚未接入该任务空间" }`，**无 `id`/`projectId`/`localRepoKey`**。
  2. `REMOTE_MISMATCH`（`packages/server/team/sync-agent-service.js:447-458`）：本地仓库标识不一致时返回 `{ id, taskSpaceId, status: "rejected", errorCode: "REMOTE_MISMATCH", error: "本地仓库与已绑定仓库不一致" }`，**无 `projectId`/`localRepoKey`**。
  3. `disabled`（`packages/server/team/sync-agent-service.js:459-481`）：任务空间停用或弃用时返回完整字段但 `status: "disabled"`，附带 `errorCode: "TASK_SPACE_DISABLED" | "TASK_SPACE_RETIRED"` 与中文 `error`。
- 客户端缺陷位置：
  1. `packages/desktop/src-tauri/src/agent/protocol.rs:344-416`：`ServerBinding` 的 `id`/`project_id`/`local_repo_key` 为必填 `String`，`parse_server_binding` 强制校验导致 `BINDING_UNKNOWN` 首行即报「绑定 ID 格式无效」，后续行对 `projectId`/`localRepoKey` 报错，且 `status` 白名单缺少 `"disabled"`。
  2. `packages/desktop/src-tauri/src/agent/runtime.rs:701-748`：`merge_heartbeat_bindings` 在 `remote.local_repo_key != binding.local_repo_key` 时直接 `continue`，会静默跳过 `BINDING_UNKNOWN`/`REMOTE_MISMATCH`；`branch_guarded` 与 `BINDING_BRANCH_MISMATCH` 判断未区分非 `approved` 状态，可能掩盖服务端失效/停用原因；`next_server_binding_id` 直接写 `Some(remote.id.clone())`。
  3. `packages/desktop/src-tauri/src/agent/store.rs:195-203`：`validate_binding` 仅允许 `pending | approved | rejected | revoked`，写入 `"disabled"` 会触发 `CONFIG_INVALID`（「第 N 个绑定状态无效」）。
  4. `packages/desktop/src-tauri/src/agent/device.rs:627-697, 781-807`：`reusable_device` 仅返回 `bool`，登录复用成功后未立即把心跳中的绑定状态合并写入 `config.json`。
- 下游消费兼容已确认：
  - Rust 侧 `packages/desktop/src-tauri/src/agent/task_sync/bindings.rs`、`packages/desktop/src-tauri/src/agent/runtime.rs:666-673`（`command_target_active`）、`packages/desktop/src-tauri/src/agent/store.rs:339-370`（`assert_repository_bindings_converged`）、`packages/desktop/src-tauri/src/agent/device.rs:896-907`（`read_local_associations`）、`packages/desktop/src-tauri/src/main.rs:169-179`（`approved_association_for_task_space`）均以 `sync_status == "approved"` 门控，`"rejected"` 与 `"disabled"` 均自动停止同步/监听、不阻塞同仓库重新关联（`packages/desktop/src-tauri/src/agent/onboarding.rs:744-747` 按 `local_repo_key` 覆盖旧绑定）。
  - Web 侧 `packages/web/src/components/layout/project-rail/association.ts:180-189` 对任意 `association.status !== 'approved'` 统一渲染 `关联失效 · ${lastError || lastErrorCode || '本地关联已失效'}`，无需改前端。

## Key Decisions

- 保持服务端 `packages/server/team/sync-agent-service.js` 心跳契约不变，在桌面客户端完整对齐服务端协议。
- `BINDING_UNKNOWN` / `REMOTE_MISMATCH` / `disabled` 均保留本地 binding 记录并更新其状态与错误字段（与现有空心跳置 `revoked` 及 ProjectRail「关联失效」展示保持一致），不静默删除本地 binding。
- 严格 fail-closed 边界不变：仅当 `status == "rejected"` 时允许 `id`/`projectId`/`localRepoKey` 缺省或为 `null`；只要字段存在且非 `null`，仍必须通过 `assert_safe_id` / `is_sha256_hex` 严格校验；非 `rejected` 状态（`pending | approved | revoked | disabled`）仍要求三字段齐全且合法。
- 登录复用 `reusable_device` 返回 `Option<HeartbeatResponse>`，在 `complete_login` 中复用同一 `merge_heartbeat_bindings` 立即落盘最新绑定状态。

## Requirements

### R1 心跳绑定响应解析（`packages/desktop/src-tauri/src/agent/protocol.rs`）

- `ServerBinding.id`、`project_id`、`local_repo_key` 改为 `Option<String>`。
- `parse_server_binding` 先校验 `status`，白名单扩展为 `"pending" | "approved" | "rejected" | "revoked" | "disabled"`。
- `task_space_id` 始终必填并过 `assert_safe_id`。
- `id`（`id` / `bindingId`）、`project_id`（`projectId` / `project_id`）、`local_repo_key`（`localRepoKey`）：在 `status == "rejected"` 时允许缺省或 `null`；非 `rejected` 状态缺省或 `null` 仍报错；任何状态下若值为非 `null` 且格式非法（含非字符串类型、非法 ID 或非 64 位小写 hex），必须报错拒绝。

### R2 配置状态白名单（`packages/desktop/src-tauri/src/agent/store.rs`）

- `validate_binding` 允许 `sync_status` 取 `"disabled"`，其余状态（`pending`、`approved`、`rejected`、`revoked`）保持不变。

### R3 心跳绑定合并（`packages/desktop/src-tauri/src/agent/runtime.rs`）

- 将 `merge_heartbeat_bindings` 开放为 `pub(crate)` 供登录与运行期共用。
- 仓库标识匹配：`remote.local_repo_key` 为 `Some(k)` 时要求与本地相等，例外是 `remote.status == "rejected" && remote.error_code.as_deref() == Some("REMOTE_MISMATCH")` 仍应合并；`remote.local_repo_key` 为 `None` 且 `remote.status == "rejected"` 时正常合并；非 `rejected` 状态若 `local_repo_key` 不匹配或缺失继续跳过。
- `server_binding_id` 更新：`remote.id` 为 `Some(id)` 时更新为 `Some(id)`；`None` 且 `remote.error_code.as_deref() == Some("BINDING_UNKNOWN")` 时清空为 `None`；其他 `None` 保持原值。
- 错误优先级与分支守卫保护：仅在 `remote.status == "approved"` 时保留本地分支守卫错误（`is_branch_guard_code`）并检查 `BINDING_BRANCH_MISMATCH`；当 `remote.status != "approved"` 时采用服务端返回的 `error_code` / `error`，不被旧分支守卫或分支名差异覆盖。
- `detach_pending == true` 的绑定继续跳过，保持现有退让与重试解绑逻辑不变。

### R4 登录复用路径合并（`packages/desktop/src-tauri/src/agent/device.rs`）

- `reusable_device` 成功解析心跳后返回 `Ok(Some(heartbeat))`（认证拒绝返回 `Ok(None)`，其他异常仍返回 `Err`）。
- `complete_login` 复用设备更新 `config.json` 时调用 `merge_heartbeat_bindings(&mut config, &heartbeat)`，使登录后立即反映最新绑定状态，同时不阻断登录。

### R5 自动化测试覆盖

- `packages/desktop/src-tauri/src/agent/protocol/tests.rs`：覆盖 `BINDING_UNKNOWN`（无 `id`/`projectId`/`localRepoKey`）、`REMOTE_MISMATCH`（有 `id` 无 `projectId`/`localRepoKey`）、`disabled`（`TASK_SPACE_RETIRED`/`TASK_SPACE_DISABLED`）、以及非 `rejected` 缺字段 / `rejected` 带非法格式字段均拒绝。
- `packages/desktop/src-tauri/src/agent/runtime/tests.rs`：覆盖 `merge_heartbeat_bindings` 处理 `BINDING_UNKNOWN`（清 `server_binding_id`、置 `rejected`）、`REMOTE_MISMATCH`（不因仓库标识不匹配被跳过）、`disabled`（不被旧分支守卫或分支不一致覆盖）、`approved` 保留本地分支守卫与跳过无关 `local_repo_key`。
- `packages/desktop/src-tauri/src/agent/store/tests.rs`：覆盖 `sync_status = "disabled"` 通过 `validate_config`。
- `packages/desktop/src-tauri/src/agent/device/tests.rs`：覆盖登录复用路径解析含 `BINDING_UNKNOWN`/`disabled` 心跳响应时成功登录并立即合并绑定状态（用本地 mock HTTP server 或等价单元/集成测试）。

## Out of Scope

- 不修改服务端 `packages/server/team/sync-agent-service.js` 心跳返回格式或既有服务端测试。
- 不修改 Web 前端 ProjectRail UI 文案或交互。
- 不自动删除本地 `BINDING_UNKNOWN` 绑定记录，不改动 `detach_local_association` 或 worktree 自动解绑逻辑。

## Acceptance Criteria

- [x] AC1：本地 `config.json` 含服务端已删除/未绑定的任务空间时，同账号重新登录不再报错「绑定 ID 格式无效」，登录成功进入 Board，且该绑定状态已更新为 `rejected`、`last_error_code = "BINDING_UNKNOWN"`、`server_binding_id = None`。
- [x] AC2：心跳返回 `REMOTE_MISMATCH`（无 `projectId`/`localRepoKey`）时解析与合并成功，本地绑定更新为 `rejected`、`last_error_code = "REMOTE_MISMATCH"`，不阻塞登录与后续心跳。
- [x] AC3：心跳返回 `status: "disabled"`（`TASK_SPACE_DISABLED` / `TASK_SPACE_RETIRED`）时解析、合并与 `ConfigStore` 校验/落盘全部成功，且不被本地分支守卫或 `BINDING_BRANCH_MISMATCH` 覆盖。
- [x] AC4：非 `rejected` 状态缺少 `id`/`projectId`/`localRepoKey`，或任何状态包含非法格式 ID / 非法 `localRepoKey` / 未知 `status` 时，仍严格拒绝（fail-closed）。
- [x] AC5：`approved` 状态下本地分支守卫不被服务端空错误覆盖、不同 `local_repo_key` 的远端绑定不误改本地绑定、`detach_pending` 绑定在心跳合并中保持不变。
- [x] AC6：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` 全绿，且不引入内联 `mod tests {` 或 CRLF 索引文件。
