# 桌面客户端冷启动持久缓存设计

## 1. 架构边界

本任务只优化客户端本地派生索引，不改变任务快照协议、服务端数据、分支门禁和写操作信任边界。

持久缓存是“快速展示和增量校验的提示”，不是权威 ownership。任何上传、拉取、合并、冲突覆盖和
ownership 写操作仍使用实时绑定、真实分支、完整文件摘要和 actor HEAD 校验。

## 2. 当前启动问题

正常启动存在两条高成本路径：

1. `AgentRuntime::start` 在把 runtime 放入 `AgentService` 之前同步执行 `apply_bindings`，
   其中会拉取 taskSpace 并调用 `local_sync_state` 扫描本地任务文件。
2. runtime 尚未就绪时，`list_local_associations` 传入的 `task_sync` 为 `None`，会回退到
   `read_local_task_snapshot_files`，递归读取任务正文、规范化并计算摘要。

因此 Board 在启动窗口内可能重复触发第二条路径，而不是等待 Agent 完成一次扫描。

相关代码：

- [runtime.rs](../../../apps/desktop/src-tauri/src/agent/runtime.rs:63)
- [agent_service.rs](../../../apps/desktop/src-tauri/src/agent_service.rs:789)
- [device.rs](../../../apps/desktop/src-tauri/src/agent/device.rs:888)
- [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:5366)

## 3. 组件设计

### 3.1 OwnershipIndexStore

在 `TaskSync` 内增加持久 ownership 索引状态，文件路径：

```text
%LOCALAPPDATA%\TrellisBoard\data\agent\ownership-index.json
```

`AgentPaths` 增加 `ownership_index_file`。文件只在本地读取，不上传、不写日志、不进入控制事件。

文件使用内部 schema 版本 `OWNERSHIP_INDEX_VERSION = 1`，结构：

```json
{
  "version": 1,
  "bindings": {
    "<localId>": {
      "taskSpaceId": "...",
      "repoPath": "D:/...",
      "branchName": "main",
      "baselineBranch": "main",
      "headCommit": "<sha>",
      "headFingerprint": "...",
      "gitIndexFingerprint": "...",
      "trackedPaths": [".trellis/tasks/a/task.json"],
      "trackedPathsLoaded": true,
      "tasks": {
        ".trellis/tasks/a": {
          "taskJsonSize": 123,
          "taskJsonModifiedNs": 0,
          "taskJsonSha256": "...",
          "taskId": "a",
          "branch": "dev1"
        }
      },
      "paused": [".trellis/tasks/a"],
      "localDirs": [".trellis/tasks/a"]
    }
  }
}
```

`taskJsonModifiedNs` 在平台无法取得时允许省略；缺少时该任务视为候选变化。

### 3.2 唯一写者

- 运行中的 Agent `TaskSync` 是唯一持久索引写者。
- 登录、接入和命令操作为 runtime 未启动而创建的临时 `TaskSync` 只读索引，不回写。
- 写文件复用 `ConfigStore::write_atomic`，不新增文件锁；单写者避免多实例覆盖。
- binding detach、替换或配置删除时移除对应 `localId` 条目。

### 3.3 Runtime 未就绪的只读投影

`agent_service::list_associations` 在 runtime 不存在时先读取 ownership 索引，按当前 config binding
和 cursor 生成 `LocalAssociation`。命中时不调用 `read_local_task_snapshot_files`。

索引不存在、版本不匹配或 binding 不匹配时允许回退现有冷扫描；第一次运行不计入缓存命中指标。

## 4. 启动数据流

```text
客户端进程启动
  -> 读取并验证 ownership-index.json
  -> 按 config binding 构造只读 LocalAssociation
  -> ProjectRail 显示上次 ownership 快照
  -> AgentRuntime 启动，应用 binding、watcher 和同步循环
  -> 单后台 worker 逐 binding 做增量校验
  -> 只解析新增或元数据变化的 task.json
  -> HEAD fingerprint 未变时复用 trackedPaths
  -> fingerprint 变化时每仓库最多一次 ls-tree
  -> 更新内存缓存和持久索引
  -> ProjectRail 只在投影实际变化时收到 desktop-state-changed
```

后台校验使用单个 FIFO worker，避免 5 个仓库同时扫描重新形成 CPU 尖峰。

## 5. 增量校验

### 5.1 Binding 校验

只有以下字段全部一致才允许使用对应持久条目：

```text
localId
taskSpaceId
repoPath
branchName
baselineBranch
```

任一不一致时删除该条目并走冷扫描。缓存中的 `repoPath` 只用于匹配，不参与路径拼接；任务路径仍
通过现有 `task_directory_from_path` / `task_dir_under` 安全规则校验。

### 5.2 任务文件校验

每次启动枚举 `.trellis/tasks/**` 的受支持文件，形成当前 taskDir 集合：

- 目录不存在：删除对应缓存项。
- 新目录或新 `task.json`：读取、UTF-8 校验、解析 branch/taskId、计算摘要。
- `task.json` 大小和修改时间均相同：复用缓存 branch/taskId，不读取内容。
- 大小或修改时间变化：重新读取并计算摘要；若 branch 变化则更新 paused。
- `task.json` 已删除：保留该目录作为本地任务目录，但 branch/taskId 为空。

修改时间只用于快速筛选。写操作不信任该结果，仍读取真实文件并计算摘要。

### 5.3 Git 指纹

`headFingerprint` 继续使用 `.git/HEAD` 和 loose/packed ref 内容。另保存 `.git/index` 的 size 和修改
时间作为 `gitIndexFingerprint`。

- HEAD/ref 指纹未变：复用 `headCommit` 和 `trackedPaths`，不启动 Git。
- index 指纹变化但 HEAD 未变：tracked path 集合仍可复用；task.json 变化由文件清单检测。
- HEAD/ref 指纹变化：后台执行一次分支读取、HEAD commit 和 `git ls-tree`，成功后替换当前 HEAD 条目。
- 直接读取 `.git` 失败：后台回退现有 `binding_head` / `assert_binding_branch` 权威路径。

只保存每个 binding 的当前 HEAD 路径集合，不累积历史 commit，控制文件大小。

## 6. Cache-first 与权威校验

- `ownership_projection` 命中持久条目时立即返回 `paused/localDirs` 快照。
- 首次调用同时确保该 taskSpace 已进入后台校验队列；同一 taskSpace 只允许一个在途校验。
- 校验开始时记录 binding 和 `ProjectionEpoch`；完成写回前再次比较，过期结果直接丢弃。
- 校验结果与缓存相同则只更新校验元数据；结果不同才替换内存投影并发射关联状态事件。
- 缓存命中时不清理现有 15 秒内存 TTL 规则；持久条目负责跨进程，内存条目负责同进程复用。
- 上传、pull、merge、conflict overwrite 和 ownership 写操作不调用缓存短路，继续走实时校验。

## 7. 失效与错误矩阵

| 条件 | 行为 |
| --- | --- |
| 索引文件不存在 | 首次冷扫描；成功后原子写索引 |
| JSON 损坏或 schema 不匹配 | 忽略整个文件，冷扫描重建 |
| binding 字段不一致 | 删除该 binding 条目，冷扫描 |
| taskDir/路径非法 | 删除该任务项；记录告警，不使用缓存路径 |
| 符号链接或任务根不是真实目录 | 失败关闭，冷扫描不得写入该条目 |
| HEAD/ref 指纹变化 | 保留旧投影供短暂展示，后台最多一次 `ls-tree` |
| Git 命令失败 | 保留旧投影，记录缓存未命中原因；写操作继续被门禁阻止 |
| `task.json` 新增/修改/删除 | 只更新受影响目录 |
| 校验期间 binding/epoch 变化 | 丢弃结果，不写缓存，不发送事件 |
| 缓存写盘失败 | 保留内存结果；记录告警，不影响同步 |

## 8. 兼容与迁移

- 新文件独立存在，不修改 `config.json`、`live-cursors.json` 或服务端 schema。
- 旧客户端忽略该文件；新客户端遇到旧/损坏文件自动重建。
- 回退只需停止写入并删除 `ownership-index.json`；任务数据和 cursor 不受影响。
- 文件最大尺寸、binding 数和 task 数设置防御上限；超限视为损坏并冷扫描，不能把本地文件错误
  放大成内存或磁盘压力。

## 9. 可观测性

每次后台校验记录结构化诊断：

```text
cacheHit
invalidateReason
taskDirs
taskJsonReused
taskJsonParsed
headCacheHit
gitCalls
elapsedMs
```

不记录 `repoPath`、任务正文或凭据。日志只在命中、失效原因、Git 调用和异常时输出，避免日志本身
造成持续 I/O。

启动验证记录：

- ProjectRail 首次可用的时间；
- 首个 5 秒后的 25 秒进程树平均/P95/峰值 CPU；
- `git.exe` 数量；
- `task.json` 实际内容读取数；
- `list_local_associations` p50/p95。

## 10. 测试设计

- 持久索引命中：第二次 `TaskSync` 不读取未变化 `task.json`，不执行 Git，paused/localDirs 相同。
- runtime 未就绪：`list_associations` 从索引返回，不调用完整 snapshot 文件读取。
- 单任务变化：只重读目标 `task.json`。
- task.json 删除、任务目录删除：缓存项和本地目录集合正确更新。
- HEAD 不变：`head_tree_scans` 不增加。
- HEAD 变化：每个仓库只增加一次 `ls-tree`。
- binding/schema/损坏/路径越界：拒绝缓存并冷扫描。
- 校验期间失效：旧结果不写回。
- 写操作：故意提供陈旧缓存时，上传/合并门禁仍重新校验真实分支和内容。
- 并发 watcher 与后台校验：无丢事件、无缓存回滚。

## 11. 风险与回滚

- 最大风险是把快速筛选误当成内容证明。所有写操作必须继续读取真实内容。
- 文件大小/时间相同但内容变化属于低概率边界，由 Git index 变化、后续 watcher 或定期全量校准
  修正；缓存只用于展示和启动分类，不能绕过 CAS。
- runtime 未就绪时展示旧状态是已确认产品行为；后台校验完成后必须及时发射差异事件。
- 若新路径没有达到启动目标，可删除索引文件回退到当前冷扫描，不迁移业务数据。
