# 归档控制日志降噪：技术设计

## 1. 目标不变式

| 编号 | 不变式 | 违反时的现场后果 |
| --- | --- | --- |
| I1 | 每轮同步产生的日志条数与「本轮实际发生的本地状态变化」成正比，不与「Agent 可见的归档任务总数」成正比 | 归档任务积累到 144 个后，每次 pull 打印 146 行，96.5% 的日志被同一句话占满，真实告警被淹没 |
| I2 | `控制状态已不可写` 这类**状态**不得以 WARN 级别按轮打印；只有真实动作（释放租约）或真实异常（释放失败）才记日志 | 日志失去「异常信号」含义，用户无法再靠 grep WARN 定位问题 |
| I3 | `.trellis/tasks/archive/` 下的目录不参与任何客户端计算（脏目录、上传目标、inactive 集合） | 每轮为 144 个永不参与同步的路径分配/比较字符串，且掩盖了「archive 已被排除」这一事实 |
| I4 | 归档 control 仍是清理残留活跃副本的唯一信号，客户端继续消费，服务端契约不变 | 归档后残留的活跃副本被当成本地独有任务反复上传、反复被 409 `TASK_ARCHIVED` 顶回 |

## 2. 现状缺陷

### 2.1 日志点位置错误

`packages/desktop/src-tauri/src/agent/task_sync/control.rs:592-637`：

```rust
for control in controls.iter().filter(|control| !control.is_writable_local()) {
    crate::logging::warn(&format!(                 // :600-604 先打印
        "任务进入 {:?} 控制状态，本地数据保留并停止写回：{}",
        control.control_state(), control.relative_dir
    ));
    let Some(lease) = self.stored_task_lease(&control.execution_task_key).await else {
        continue;                                   // :605-607 再判断有没有租约
    };
    ...
}
```

- 打印在租约判断**之前**，所以没有租约、什么都不做的 control 也每轮打印一次。
- `task_control.rs:35-40` 的 `is_writable_local` 对 `Archived` 恒为 false，归档任务又只增不减（现场 776 个 unique 归档目录），于是日志量随历史线性增长。
- 文案是边沿事件（「进入 Archived」），实现是每轮状态打点，语义与行为不一致。

### 2.2 archive 未被 control 消费点短路

`initial_sync.rs:1087-1094`：

```rust
pub(super) fn inactive_control_dirs(controls: Option<&[TaskControl]>) -> HashSet<String> {
    controls.unwrap_or_default().iter()
        .filter(|control| !control.is_writable_local())
        .map(|control| control.relative_dir.clone())
        .collect()
}
```

消费方 `pull.rs:465-476`（过滤 dirty/deferred）、`initial_sync.rs:53/:306`。归档目录本就进不了 dirty 集合（`local_files.rs:569`、`cursor.rs:194-203`），所以过滤 archive 不改变行为，只是把这层约定写进 control 路径并省掉无意义的集合元素。

`upload.rs:72-79` 也有一份 inactive 集合，但它的输入 `task_dirs` 已在 `upload.rs:82` 被 `is_archive_task_dir` 过滤，重复改动无收益，**不动**。

### 2.3 归档 control 为什么不能丢

`local_files.rs:5-16` 的 `cleanup_archived_controls` 遍历所有 `control_state() == Archived` 的 control，交给 `cleanup_archived_residue`（`local_files.rs:80-128`）：从 `relative_dir` 的 basename 推出活跃路径，只在「本地归档副本存在且 digest 相同」时删除残留活跃副本。这是客户端唯一能发现「任务被别处归档」的通道，因此本次不动服务端下发内容。

## 3. 方案

### 3.1 日志点下移到租约分支（`control.rs:592-637`）

```rust
for control in controls.iter().filter(|control| !control.is_writable_local()) {
    let Some(lease) = self.stored_task_lease(&control.execution_task_key).await else {
        continue;   // 没有本地租约 = 没有任何写回可停止，静默
    };
    crate::logging::info(&format!(
        "释放失效任务租约：{}（{:?}）",
        control.relative_dir,
        control.control_state()
    ));
    match self.release_remote_task(&control.execution_task_key, &lease.token).await {
        ...  // 成功静默；四类幂等错误静默；其余 warn 保持原样
    }
    if let Err(error) = self.remove_task_lease(&control.execution_task_key).await {
        ...  // warn 保持原样
    }
}
```

- 只有「本地真的持有租约」才打印，一条对应一次真实释放，`:622-626`、`:630-634` 的失败 warn 一字不动。
- 级别从 `warn` 降为 `info`：任务被归档/改派后释放租约是正常生命周期，不是异常；WARN 留给释放失败。
- 文案改为描述实际动作，不再声称「任务进入 Archived 状态」。

### 3.2 `inactive_control_dirs` 过滤归档（`initial_sync.rs:1087-1094`）

```rust
.filter(|control| !control.is_writable_local())
.filter(|control| !is_archive_task_dir(&control.relative_dir))
.map(|control| control.relative_dir.clone())
```

`is_archive_task_dir` 在该文件已在使用（`initial_sync.rs:1012/:1035/:1053`），无需新增导入或抽象。

### 3.3 明确不动的点

| 点 | 理由 |
| --- | --- |
| `cleanup_archived_controls` / `cleanup_archived_residue` | 唯一残留清理通道，见 §2.3 |
| 服务端 `controls` 全量下发（`packages/server/team/snapshot/views.js:38`、`packages/server/team/task-control/views.js:99-145`） | 去掉 archived 会断掉残留清理；改增量下发需新增「归档事件」信号，超出本任务 |
| `upload.rs:72-79` 的 inactive 集合 | 输入已过滤 archive（`upload.rs:82`） |
| `prepare_controlled_server_groups`（`control.rs:536-589`） | 已用 `selected_server_task_ids` + `!is_writable_local()` 跳过非可写组 |

## 4. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 服务端不再下发 archived controls | 否 | 断掉残留清理，`I4` 不保 |
| 服务端 controls 改为增量下发 | 暂否 | 需要新增归档事件通道与游标语义，影响 Web/服务端，超出「日志降噪」范围，另开任务 |
| 日志降为 `debug` 级别 | 否 | 级别不解决语义错误；`logging` 只有 info/warn/error 落盘策略，debug 等于直接消失；真实释放也失去记录 |
| 日志采样/去重（内存 HashSet 记住已打印目录） | 否 | 只是把「每轮 144 条」变成「每进程 144 条」，语义仍是状态打点，且新增跨轮状态 |
| 客户端完全跳过 archived control | 否 | 残留活跃副本永远不清理，且本地 stale lease 残留（见 §3.1 保留的释放逻辑） |

## 5. 兼容与回滚

- 纯客户端改动，协议与存储格式不变；旧客户端连接新服务端、新客户端连接旧服务端行为一致。
- 本地 `task-control-state.json` 结构不变，无需迁移。
- 回滚：单 commit revert；日志与集合过滤均无持久化副作用。

## 6. 测试设计

新增 `packages/desktop/src-tauri/src/agent/task_sync/tests/inactive_controls.rs`（在 `tests/mod.rs` 注册），复用 `tests/support.rs:522` 的 `test_task_sync_fixture` 与 `mock_api_server`：

| 测试 | 断言 |
| --- | --- |
| `inactive_control_dirs_skips_archive_controls` | 归档目录 control（`.trellis/tasks/archive/2026-11/x`）不进集合；同批 `materialized` control 的活跃路径仍在集合中 |
| `release_inactive_leases_ignores_controls_without_lease` | 传入 archived / handoff_materialized controls，本地无租约 → 没有任何 `/release` 请求、没有租约写入（等价于不再打印日志） |
| `release_inactive_leases_releases_stored_lease_for_archived_task` | 先用 `claim_remote_task` 造出本地租约，再以 archived 状态调用 → `/release` 请求恰好 1 次、本地租约被移除（守住 R3） |
| `cleanup_archived_controls_removes_active_residue` | 归档副本与活跃副本内容一致时，`cleanup_archived_controls` 删除活跃目录（补齐现无覆盖的行为） |

参考先例：`tests/handoff_and_errors.rs:69` 的 `release_execution_lease_releases_stored_lease_once`（请求计数方式）、`tests/snapshot_files.rs:95-117`（直接写 `task_control_file` 造 control 状态）。

不针对日志文本做断言（测试进程未 `logging::init`，且断言文案会把实现细节钉死）；用「是否发起释放请求」间接锁定「无租约就静默」。

## 7. 验证与风险

- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（全任务只跑一次，交 CI 复核）。
- `git ls-files --eol | rg 'i/crlf'` 无输出。
- 手工验收：启动桌面端连接一个含 100+ 归档任务的空间，触发一次同步，确认 `desktop.log` 新增行不含 `任务进入 Archived 控制状态`，且 `cleanup_archived_controls` 后残留活跃副本仍被清理。
- 风险：日志量骤降后若有人依赖该 WARN 做归档监控，会短暂失去信号 —— 释放动作仍有 `info` 行，且该 WARN 从来不是可靠的归档事件来源（每轮重复）。文件行数：`control.rs` 674 → 675，`initial_sync.rs` 1100 → 1101，新增测试文件 180 行，均未触 1200 上限。
