# 桌面客户端冷启动持久缓存实施计划

## 0. 前置

- Active task：`.trellis/tasks/11-15-optimize-desktop-startup-cache`
- 只在规划评审通过并显式执行 `task.py start` 后修改产品代码。
- 开发期间不反复构建；全部实现和聚焦测试完成后执行一次最终 Rust/Web 验证。

## 1. 建立基线与观测

- 使用当前 5 个 binding、约 705 个 `task.json` 和同一 Windows 客户端采集修复前基线。
- 分开记录：
  - `AgentRuntime::start` 到 runtime 可用的耗时；
  - ProjectRail 首次 association 可用时间；
  - 启动 0-5 秒和 5-30 秒进程树 CPU、P95、峰值；
  - `git.exe` 数量和完整命令；
  - `task.json` 内容读取数；
  - 启动期 `list_local_associations` 调用数和耗时。
- 若当前阶段无法区分 ownership 扫描和 startup pull 的占比，增加仅测试构建使用的计时日志/计数器，
  不改变生产行为。

验证：

- 保存基线 JSON/Markdown，能复现当前约 4 分钟高 CPU 现象。
- 明确缓存目标路径上已发生、未发生的 Git 调用。

## 2. 索引 schema 与安全路径

- 在 `AgentPaths` 增加 `ownership_index_file`。
- 在 `task_sync.rs` 增加 `OWNERSHIP_INDEX_VERSION = 2`、索引序列化和反序列化结构。
- 复用 `ConfigStore::write_atomic` 原子写。
- 加载时做尺寸、数量、schema、binding、路径安全校验；无效条目丢弃。
- 暂不修改 cursor、config 或服务端协议。

测试：

- 正常 roundtrip。
- schema 不匹配、JSON 损坏、重复/非法路径、越界、符号链接、超限文件安全失败。
- atomic write 失败不破坏旧索引。

## 3. Runtime 未就绪的只读缓存路径

- 提取只读 `OwnershipIndexReader` 或等价最小对象，允许 `agent_service::list_associations` 在
  runtime 不存在时读取持久投影。
- 仅在 binding 完全匹配时使用缓存；否则保持现有冷扫描。
- deferred/pending 仍从 `live-cursors.json` 读取，ownership paused/localDirs 来自索引。
- 不修改 Tauri command 参数或前端接口。

测试：

- runtime 不存在时命中缓存，断言没有调用 `read_local_task_snapshot_files`。
- 缓存缺失时仍走原有路径，结果一致。
- 5 个 binding 只返回当前 config 中存在的条目。

## 4. TaskSync 启动加载与后台校验

- `AgentRuntime::start` 在新 `TaskSync` 创建后加载持久索引，再应用 binding。
- binding 应用完成后启动单个 FIFO 后台校验 worker。
- 每个 binding 记录 in-flight 状态和 `ProjectionEpoch`，禁止重复 worker。
- 后台校验：
  - 比较 binding；
  - 枚举 taskDir 和受支持文件元数据；
  - 未变化文件复用 SHA256，未变化 `task.json` 复用 branch/taskId；
  - 计算当前 owned/paused/localDirs；
  - HEAD 指纹未变时复用 trackedPaths；
  - HEAD 变化时调用现有 `head_tree_paths`；
  - 原子写回索引；
  - 仅在 ownership 结果变化时发射 `desktop-state-changed`。

测试：

- 第二次 TaskSync 命中持久索引。
- 未变化任务不读取任何正文，`head_tree_scans` 不增长。
- 单文件变化只读取并哈希该文件。
- 元数据缓存 dirty 检测与完整文件扫描一致。
- HEAD 变化每仓库一次 `ls-tree`。
- 校验中 invalidation/binding 变化不回写旧结果。

## 5. 运行期 watcher 与写操作边界

- task/Git watcher 失效时更新持久索引或标记 dirty，沿用 250ms 合并窗口。
- 只允许运行中 Agent TaskSync 写索引；临时 TaskSync 只读。
- 上传、pull、merge、conflict overwrite、ownership resolution 保持现有实时校验。
- 增加回归测试：伪造匹配的旧缓存后切换真实分支，写操作仍返回 `BRANCH_MISMATCH`。

测试：

- watcher 修改 task.json 后，关联状态随后更新且索引没有回滚。
- HEAD 切换、merge、任务新增/删除后缓存正确失效。
- detached HEAD、worktree、packed-refs 和未提交任务路径行为不变。

## 6. 聚焦测试

先在 Rust 中完成新逻辑的全部测试，再启动客户端：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml task_sync
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ownership
```

若修改前端状态消费，再执行对应 Node 测试；否则不改前端接口，不新增前端代码。

最终代码级验证在所有开发完成后统一执行：

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm test
```

## 7. 真实客户端 A/B

使用相同 5 个仓库和相同任务量：

1. 删除/禁用新索引，采集当前冷启动基线。
2. 首次启动生成索引。
3. 正常退出并重启，记录 ProjectRail 可用时间、0-5 秒和 5-30 秒 CPU、Git 子进程、
   `task.json` 读取次数。
4. 修改一个 task.json 后重启，确认只解析该任务。
5. HEAD 变化后重启，确认每仓库最多一次 `ls-tree`。
6. 缓存损坏、schema 变化和 binding 变化后重启，确认安全回退。

验收：

- ProjectRail `<= 5s` 可用。
- 5-30 秒进程树平均 CPU `<5%` 单核。
- 未变化 ownership 路径 Git 子进程为 `0`。
- 未变化任务内容读取为 `0`。
- 页面状态与重启前一致，写操作门禁和冲突处理测试通过。

若 5 秒后 CPU 仍高，先用同一次启动的 GPU/Script/Idle 指标和耗时拆分确认是否来自 startup pull；
只有证据证明 pull 是主因时，才在本任务内增加本地 snapshot digest 缓存或将启动 pull 限制为单仓库
串行执行。不得在未归因前扩大改造。

## 8. 收尾

- 写 `e2e-report.md`，记录缓存命中、失效、增量文件和 CPU 数据。
- 更新 `.trellis/spec/backend/desktop-agent-runtime.md` 与 `desktop-realtime-sync.md` 的持久索引契约。
- 核对缓存文件不含凭据、任务正文或可上传数据。
- 只暂存当前任务代码、测试、文档和证据。
- E2E 通过后再提交、打 tag 并走 GitHub 自动构建。

## 9. 风险点与回退

- 不在写操作路径使用缓存短路。
- 增量 worker 必须限制并发，避免把冷扫描改成持续后台负载。
- 缓存 schema 和路径校验失败必须回退冷扫描。
- 任何结果不确定时删除 `ownership-index.json` 即可回退；不得删除或重建任务 cursor。
