# 心跳循环韧性：技术设计

## 1. 目标不变式

| 编号 | 不变式 | 违反时的现场后果 |
| --- | --- | --- |
| I1 | 进程在运行且未被用户暂停时，心跳循环每轮必有尝试（成功 15s 一次，失败 1s→2s→…→60s 退避） | 在线监听永久归零，只能重启客户端 |
| I2 | 心跳请求的发出只依赖内存缓存 + 一次 HTTP POST，不等待任何同步/git 工作 | 一次慢同步就会拖垮在线状态 |
| I3 | 单轮 `heartbeat_once` 有上限（60s），超时即放弃并进入下一轮 | 任一步永久阻塞 ⇒ 循环永久停摆 |
| I4 | 只有认证失败（`AUTH_REVOKED`/`DESKTOP_TOKEN_INVALID`/401/403）与显式 `agent.revoked` 能停止运行时 | 普通网络错误把客户端永久下线 |

## 2. 现状缺陷

`packages/desktop/src-tauri/src/agent/runtime.rs`（770 行）：

| 位置 | 行为 | 超时 | 风险 |
| --- | --- | --- | --- |
| `runtime.rs:191-243` `heartbeat_once` | 先 `await task_sync.update_bindings(config.bindings)`，再 POST 心跳，再 `update_bindings(merged.bindings)` | 两次同步均无 | `update_bindings` 要拿 `binding_selection_lock`+`cursor_write` 两把全局 AsyncMutex，还可能逐个等待 per-taskSpace 串行锁并做 git 文件 I/O —— 任一环节永久等待，心跳就不再发出 |
| `runtime.rs:138-189` 循环 | 认证失败才 `break`；其它错误退避 | 整轮无 | 循环卡在上面的 await 时，连「失败」都不会被记录 |
| `runtime.rs:596-606` `write_state` | 不去重、每次失败重写 | — | 可作为“是否还在尝试”的外部探针（本次定位就靠它） |
| `agent/rt.rs:9-27` | 裸 `spawn`，无监督 | — | 任务消失不重建 |

**关键事实**：release 构建 `packages/desktop/src-tauri/Cargo.toml:68` 为 `panic = "abort"`。现场客户端进程一直存活并持续同步，因此心跳任务**不是 panic，而是永久阻塞在某个 await 上** —— 这决定了修复重点是“有界等待”，而不是 panic 隔离。

## 3. 方案

### 3.1 重排 `heartbeat_once`：先心跳，后同步

```rust
async fn heartbeat_once(&self) -> AgentResult<()> {
    self.retry_pending_detachments().await;              // 保留，内部各请求自带超时

    let config = self.store.read_config(false)?;
    // 1) 心跳只读内存缓存（bindings.rs:735-745 active_bindings 仅短暂拿 bindings 锁）
    let listening = self.task_sync.active_bindings().await;
    let response = self
        .api
        .post("/api/agent/heartbeat", &heartbeat_payload(&config, &listening), 30, false)
        .await?;
    let heartbeat = protocol::parse_heartbeat_response(&response)?;

    // 2) 合并服务端权威绑定
    let merged = self.apply_heartbeat_response(&config, &response)?;

    // 3) 绑定同步降级为“尽力而为”，有界、可超时、不影响本轮心跳结果
    self.update_bindings_bounded(merged.bindings).await;
    Ok(())
}
```

- **为什么能去掉第一次 `update_bindings`**：绑定缓存在 `start()` 里已由 `prepare_startup_bindings` 预热（`runtime.rs:42-115`）；此后配置变更最多让新绑定晚一轮（≤15s）上报，远小于服务端 60s 判定阈值。
- **保留第二次**：服务端返回的权威绑定（含 `rejectedTaskSpaceIds`）仍需并入 `task_sync`，只是不再阻塞心跳结果。
- **顺序收益**：即使同步永久挂起，心跳已在挂起之前发出；下一轮继续尝试，在线状态不受影响。

### 3.2 有界同步助手

```rust
const BINDING_SYNC_TIMEOUT: Duration = Duration::from_secs(30);

async fn update_bindings_bounded(&self, bindings: Vec<AgentBinding>) {
    if tokio::time::timeout(BINDING_SYNC_TIMEOUT, self.task_sync.update_bindings(bindings))
        .await
        .is_err()
    {
        logging::warn("心跳：绑定同步超过 30 秒未完成，本轮跳过，下一轮重试");
    }
}
```

取消语义：超时后 future 被 drop，`AsyncMutex` guard 随 drop 释放；`sync_task_spaces` 的 `JoinSet` 被 drop 时 abort 子任务；已落盘的 git 操作由下一轮 `pull_and_report` 的基线对账兜底（`bindings.rs:615-644`）。因此超时不会留下永久锁。

### 3.3 循环级总超时（最后一道保险）

```rust
const HEARTBEAT_ROUND_TIMEOUT: Duration = Duration::from_secs(60);

match tokio::time::timeout(HEARTBEAT_ROUND_TIMEOUT, self.heartbeat_once()).await {
    Ok(Ok(())) => {
        if self.last_heartbeat_error.swap(false) {          // 仅状态跃迁时写日志
            logging::info(&format!("心跳恢复：上报 {} 个监听任务空间", listening.len()));
            self.write_state("running", None, None);          // 清掉遗留的 error
        }
        delay = RETRY_BASE;
        next_delay = HEARTBEAT_INTERVAL;
    }
    Ok(Err(error)) if protocol::is_authentication_error(&error) => {
        self.write_state("error", Some(&error), Some("AUTH_REVOKED"));
        self.stop();
        break;
    }
    Ok(Err(error)) => {
        self.last_heartbeat_error.store(true);
        logging::warn(&format!("心跳失败（{}）：{}", error.code, error.message));
        self.write_state("error", None, Some(&error.message));
        /* 原有探活 + 退避 */
    }
    Err(_) => {
        self.last_heartbeat_error.store(true);
        logging::warn("心跳单轮超过 60 秒未完成，已放弃本轮");
        self.write_state("error", None, Some("心跳超时（60 秒）"));
        delay = RETRY_BASE;
        next_delay = HEARTBEAT_INTERVAL;
    }
}
```

- `Err(_)` 分支保证：**无论卡在哪个 await，最多 60 秒后循环一定继续**。这是对 I3 的兜底，也是本次故障最直接的修复。
- `write_state("running")` 修掉现场观察到的“恢复后 `runtime.json` 仍停在 error”的可观测缺陷。
- 成功心跳只写 `debug`（15s 一条会淹没日志），失败与恢复写 `warn`/`info`。

### 3.4 可测性：`HeartbeatPolicy`

把硬编码常量收拢成结构体，生产用默认值，测试注入短值（避免测试等 15s/60s）：

```rust
pub(crate) struct HeartbeatPolicy {
    pub interval: Duration,             // 15s
    pub retry_base: Duration,           // 1s
    pub retry_max: Duration,            // 60s
    pub binding_sync_timeout: Duration, // 30s
    pub round_timeout: Duration,        // 60s
}
```

`AgentRuntime::new` 用 `HeartbeatPolicy::default()`；测试用 `..Default::default()` 覆盖单个字段。

## 4. 影响文件

| 文件 | 变化 |
| --- | --- |
| `packages/desktop/src-tauri/src/agent/runtime.rs`（770 行） | 新增 `HeartbeatPolicy`（约 30 行）、`update_bindings_bounded`、重排 `heartbeat_once`、循环四个分支 + 日志 + 恢复写状态；预计 +90/-25 行，仍在 1200 行上限内 |
| `packages/desktop/src-tauri/src/agent/runtime_tests.rs`（新增） | 业务文件内只留 `#[cfg(test)] #[path = "runtime_tests.rs"] mod tests;`。**不用 `runtime/tests.rs`**：按 `.trellis/spec/desktop/tauri-commands/index.md:291-304`，一旦采用 `foo.rs`+`foo/` 目录化，根文件就必须 ≤500 行，而 `runtime.rs` 现有 770 行；用 `#[path]` 旁挂测试文件既满足「测试外移」，又不触发目录化约束（先例：crate 根 `main.rs` 用 `#[path = "main/tests.rs"]`） |
| `packages/desktop/src-tauri/src/agent/task_sync.rs` / `bindings.rs` | 不改（如需暴露测试钩子，只加 `pub(crate)`） |
| `packages/server/**` | 不改 |

## 5. 测试设计

1. `update_bindings_bounded_returns_within_timeout`：注入一个 `sleep(5s)` 的假同步（把助手泛化为 `bounded<T>(dur, fut)` 小函数放 `agent/rt.rs` 便于单测），断言 100ms 内返回并记录超时。
2. `heartbeat_uses_cached_bindings_before_sync`：`prepare_bindings` 里先 sleep，断言 POST 已先发出（mock server 记录到达时间）。
3. `heartbeat_round_honours_round_timeout`（集成，`runtime/tests.rs`）：`HeartbeatPolicy{binding_sync_timeout:50ms, round_timeout:120ms, interval:20ms}`，mock `/api/agent/task-spaces/*/changes` 挂起不响应，断言 2s 内 `/api/agent/heartbeat` 收到 ≥2 次且循环未退出。
4. `auth_error_still_stops_runtime`：mock 返回 401 `AGENT_AUTH_REQUIRED`，断言 `runtime.json` 为 `AUTH_REVOKED` 且循环结束（保持现有语义）。
5. 回归：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿（现有 task_sync 测试）。

## 6. 手工验证

1. 启动服务端 + 客户端，`sqlite3 board.sqlite "select last_seen_at from agent_device where id='<id>'"` 确认前进。
2. 结束服务端进程，20 秒后重启；**不重启客户端**，60 秒内确认：
   - `last_seen_at` 恢复前进；
   - `sync_agent_binding.is_listening=1`；
   - `runtime.json` 从 `error` 变 `running`；
   - `desktop.log` 出现「心跳失败（NETWORK_ERROR）…」→「心跳恢复：上报 5 个监听任务空间」。
3. 停服务端 2 分钟再启动，重复上述检查（覆盖长退避后的恢复）。
4. Board 页面确认「在线监听 1 / 已关联 4」。

## 7. 风险、回滚与遗留

- **取消半途 pull**：超时 drop 可能中断一次 pull；基线/游标机制本就能容忍不完整同步，下一轮重跑。若测试发现脏状态，退化为“只对心跳整轮计时，不对同步单独计时”。
- **持续超时的日志噪声**：同步长期挂起会每 15s 一条 warn；可后续加“连续 N 次超时后日志降级”，不在本任务。
- **403 陷阱（建议另开任务）**：`agent/protocol.rs:681-685` 把任何 403 视为认证失败，而 `agent/http.rs:302-356` 只把 401 映射为认证错误；若将来有反代/网关返回 403，运行时会永久停止。本任务不动，但 PRD 的 R5 已声明认证语义保持。
- **服务端事务回滚（建议另开任务）**：`packages/server/team/sync-agent-service.js:410-600` 在 `INVALID_INPUT` 时整个事务回滚，`last_seen_at` 也不更新；属独立隐患。
- **回滚**：单一提交，`git revert` 即恢复旧行为；旧版客户端不受影响，但会继续复发。
- **发布**：需按现有流程出 0.4.62 portable 包，用户分发给 4 台客户端；未升级的机器仍会复发。
