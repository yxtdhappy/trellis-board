# 技术设计

## 1. 设计目标

把“跨端任务身份”和“本机文件系统定位”彻底分开：

```text
服务端/其他客户端
  taskSpaceId + ".trellis/tasks/<logical-task-dir>"
                    |
                    v
当前客户端 binding
  repoPath + ".trellis/tasks/<logical-task-dir>"
                    |
                    v
本机安全路径解析与文件系统操作
```

网络协议只认相对逻辑路径；本机绝对路径只服务当前操作系统上的文件操作。

## 2. 当前问题

[task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs) 当前执行：

1. 对 `.trellis/tasks` 调用 `std::fs::canonicalize`。
2. 对目标任务路径只执行普通 `join`，不做同形态规范化。
3. 用 `Path::starts_with` 比较两者。

Windows 上步骤 1 得到 `\\?\D:\...`，步骤 2 得到 `D:\...`。两者指向同一位置，但路径前缀组件不同，因此合法任务目录被判为越界。

路径比较本身不是跨客户端身份比较，而是本机安全边界校验；问题在于实现混用了两个不同的路径表示。

## 3. 路径契约

### 3.1 逻辑路径

- 仅接受 `.trellis/tasks/<task-dir>`，归档任务为 `.trellis/tasks/archive/YYYY-MM/<task-dir>`。
- 分隔符固定 `/`。
- 不允许 `.`、`..`、空段、反斜杠、NUL、绝对路径或盘符前缀。
- 该格式跨客户端稳定，不包含任何客户端绝对路径。

### 3.2 本机路径

- 由当前 binding 的 `repo_path` 派生 `.trellis/tasks` 根。
- 只从已经验证的 `taskDir` 后缀逐段构建目标路径。
- 根和目标路径始终使用同一派生来源，避免 canonical 与普通路径混用。
- 保留一次词法包含校验作为纵深防御，只比较同一客户端内、同一形式的路径。

## 4. 实现边界

### 4.1 共享本机解析函数

在 `agent/protocol.rs` 增加一个纯词法安全解析函数：

```rust
pub fn resolve_task_dir_under(tasks_root: &Path, task_dir: &str) -> Option<PathBuf>
```

职责：

- 验证 `.trellis/tasks/` 前缀和每个相对路径段。
- 从 `tasks_root` 逐段 `push`，不调用 `canonicalize`。
- 使用同形态 `is_path_inside` 检查 `push` 后没有切换根或盘符。
- 目标不得等于 `tasks_root`。

该函数不接触网络，也不产生跨客户端身份。

### 4.2 调用方

- `task_sync.rs` 的目录删除、备份和写入全部改用该函数，移除只规范根目录的 `dunce_canonical` 路径。
- `task_command.rs` 现有 `resolve_task_dir` 改为复用同一函数，避免两套路径规则漂移。
- 写侧继续检查已存在的路径组件，拒绝符号链接；校验失败返回错误并停止当前 taskSpace 应用。

### 4.3 错误事件

`task_sync_error` 增加可选字段：

```json
{
  "type": "task_sync_error",
  "taskSpaceId": "5efbba95-...",
  "projectName": "mdp-backend-web",
  "branchName": "dev",
  "message": "任务目录路径校验失败"
}
```

- `projectName` 来自 `AgentBinding.display_name`。
- `branchName` 来自 `AgentBinding.branch_name`。
- 不发送 `repoPath`。
- `report_binding_error` 直接使用当前 binding；普通 `report_error` 从 TaskSync 的绑定表补全展示信息。

### 4.4 控制窗口

- `ControlApp.tsx` 的 `task_sync_error` 类型增加 `projectName`、`branchName`。
- 主行显示 `projectName / branchName`。
- 缺失字段时回退到 `taskSpaceId`。
- `taskSpaceId` 可保留在次级诊断行，不能作为唯一主信息。

## 5. 安全与兼容

- 保留 `.trellis/tasks/**` 限制，不扩大客户端可写范围。
- 词法解析后仍检查本机现有路径组件是否经过符号链接。
- 事件字段只增不改，旧控制窗口和旧事件均可兼容。
- 不改服务端 API、SQLite schema、cursor 格式或 taskSpace 身份。

## 6. 风险与取舍

- 不使用 `canonicalize` 后，物理路径别名不再参与相等比较；这是预期行为。任务逻辑身份由相对 `taskDir` 决定，物理路径只需安全落在当前 binding 根下。
- 符号链接检查与实际文件操作之间仍有理论 TOCTOU 窗口；当前本地桌面 Agent 的信任模型接受该边界，本次不引入复杂的 OS 级目录句柄抽象。
- 实际 macOS/Linux 支持和打包不在本任务范围内；本设计只保证协议与路径解析不依赖 Windows 绝对路径相等。

## 7. 回滚

- 代码回滚点为共享解析函数、TaskSync 调用点、控制事件字段和 ControlApp 展示改动。
- 不涉及数据迁移；回滚代码后现有 cursor、任务目录和事件队列无需恢复。
