# 设计：Python 环境门与 mine 过滤

## 1. Python 环境门（桌面端）

### 1.1 数据契约（`apps/desktop/src-tauri/src/agent/env.rs`）

```rust
pub const PYTHON_MIN_VERSION: &str = "3.9.0";
pub const PYTHON_INSTALL_VERSION: &str = "3.12.8";
pub const PYTHON_INSTALLER_URL: &str =
    "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe";
pub const PYTHON_INSTALLER_SHA256: &str =
    "71bd44e6b0e91c17558963557e4cdb80b483de9b0a0a9717f06cf896f95ab598"; // 27,043,760 字节
pub const PYTHON_INSTALLER_ARGS: &[&str] = &[
    "/quiet",
    "InstallAllUsers=0",
    "PrependPath=1",
    "Include_launcher=1",
    "InstallLauncherAllUsers=0",
    "Include_test=0",
    "Include_doc=0",
    "Shortcuts=0",
];
pub const PYTHON_PROBE_TIMEOUT_SECS: u64 = 30;
pub const PYTHON_INSTALL_TIMEOUT_SECS: u64 = 600;
pub const CODE_PYTHON_INVALID: &str = "PYTHON_INVALID";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonStatus {
    pub ok: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub source: Option<String>,      // "client" | "path" | "py-launcher" | "env"
    pub min_version: String,         // "3.9.0"
    pub found_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonRuntimeFlag {
    pub version: String,
    pub path: String,
    pub source: String,
    pub installed_at: String,
}

pub struct RuntimeStatus { state, node, trellis, python, download }  // 新增 python
// 解释器路径来自 client.json 的 python_runtime.path（安装/探测记录），不再有 <dataDir>/runtime/python 约定
```

`ClientConfigLike` 增加 `python_runtime()` / `set_python_runtime()`；`Value` 的实现读写 `client.json` 的 `python_runtime`（与 `node_runtime` 同构）。`write_runtime_flags` 增加第三个参数 `python: &PythonRuntimeFlag`（唯一调用点是 `install()`）。

`RuntimeInstallResult` 增加 `python_version: String`（tauri 侧直接序列化给前端）。

### 1.2 探测（`resolve_python`）

顺序与客户端执行 `task.py` 的候选一致，先客户端已装解释器：

1. `client.json` 的 `python_runtime`（文件存在 → 直接读版本，`source="client"`；文件被删 → 清标志自愈）
2. 环境变量 `TRELLIS_PYTHON`（`source="env"`）
3. `python --version`（`source="path"`）
4. `py -3 --version`（`source="py-launcher"`）

`check()`：`state = if node.ok && trellis.ok && python.ok { Ready } else { NeedsSetup }`。探测到的解释器写回标志。

版本解析：`--version` 输出形如 `Python 3.12.8`，用 `parse_python_version` 取第一个 `d+.d+(.d+)?` 片段，缺 patch 段补 `.0`，再复用 `is_version_at_least(found, PYTHON_MIN_VERSION)`。Microsoft Store 占位 `python.exe` 无输出/非零退出 → 判缺失（现有 `run_process` 已处理）。

超时：每次 `--version` 探测 `PYTHON_PROBE_TIMEOUT_SECS`（30 s）。超时/非零退出即判该候选不可用并继续下一个候选，不阻塞环境检查页。

低版本不中止：候选取到 3.8 这类 <3.9 的解释器时，记下 `found_version` 继续尝试后续候选；全部候选都 <3.9 时返回 `ok=false` + `found_version`，前端文案区分「缺少 Python」与「Python 版本过低（3.8）」。

安装后探测优先看安装记录：`install_python` 成功后按顺序确定解释器路径 —— 安装器写出的 per-user 默认位置 `%LocalAppData%\Programs\Python\Python312\python.exe`（存在即用）、`py -3`、`python`，取第一个 >=3.9 者写入 `python_runtime`。

### 1.3 安装（`install_python`）

静默安装官方 CPython，不做便携解压。

- 下载：复用 `download_node` 的流式下载/校验形态 → 抽成 `download_file(url, sha256, file_name, stage, on_progress)`（node 调用处改用它，Python 传 `PYTHON_INSTALLER_URL` / `PYTHON_INSTALLER_SHA256` / `python-3.12.8-amd64.exe`），落盘 `<dataDir>/downloads/`，保留 `.part` 原子重命名与 `PROGRESS_INTERVAL`。
- 执行：`python-3.12.8-amd64.exe /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=0 Include_test=0 Include_doc=0 Shortcuts=0`。per-user 安装走 HKCU，**不需要管理员权限**（已实测无 UAC 提权）；`PrependPath=1` 只改用户 PATH（可逆），与用户手动双击安装的默认行为一致。超时 `PYTHON_INSTALL_TIMEOUT_SECS`（600 s，实测 76.5 s）。
- 退出码：0 或 3010（需重启）视为成功；其他码返回错误并附官方下载链接。
- 安装期间 stdout 静默、无进度输出，靠定时发 `python:install` 心跳（沿用 `PROGRESS_INTERVAL`）。
- 安装后清理 `<dataDir>/downloads/` 里的安装包（成功或失败都删；失败场景文案里给下载链接供手动装）。
- 校验：重新跑 `resolve_python`，无 >=3.9 解释器 → `CODE_PYTHON_INVALID`；成功则把版本/路径/来源写入 `client.json` 的 `python_runtime`。
- 进度 stage：`python:download` / `python:verify` / `python:install` / `python:validate`。
- 下载上限沿用 `MAX_ZIP_BYTES`（134 MB，安装包 27 MB）。
- 不新增解压逻辑；`extract_node` 保持只服务 Node，`NODE_ZIP_ROOT` 不动。

### 1.4 运行时使用（`apps/desktop/src-tauri/src/agent/task_command.rs`）

`run_task_python` 候选顺序改为：

1. `TRELLIS_PYTHON`（若设置）
2. `client.json` 的 `python_runtime.path`（环境门记录的解释器，存在才加入）
3. `python`
4. `py -3`

`is_spawn_failure` 分支继续跳过到下一个候选（现有逻辑不变）。

### 1.5 前端（`apps/web/src/desktop/LoginApp.tsx`）

- `RuntimeStatus` 类型加 `python?: { ok?: boolean; version?: string }`。
- `STEP_ORDER` 插入 `python:check`（label「检查 Python」）；`node:download`/`trellis:install` 之后插入 `python:download`（label「安装 Python」）。
- `PROGRESS_STEP` 映射 `python:download`/`python:verify`/`python:install`/`python:validate` → `python:download`。
- `needs_setup`：`missing` 列表加 `Python`；`ready` 文案带 Python 版本。
- `installRuntime()` 成功后改为 `await refreshRuntime()`（由 `runtime_status` 决定进入登录页还是继续提示），避免安装后仍有缺失却直接进登录页。
- 底部说明补一句：Python 缺失或低于 3.9 时下载官方安装包静默安装 Python 3.12.8（per-user，无需管理员权限）。

### 1.6 文档

`apps/desktop/README.md`：:5-13 运行环境段落、「运行环境门」代码块（探测顺序 + 安装步骤）、:407-410 验收表加 Python 行（无 Python 机器安装后可用；已有 ≥3.9 直接进登录页）。

## 2. 「只看我的」过滤（服务端）

生效路径只有 `apps/server/team/task-space-index.js`（`apps/server/test/team-static.test.js:23-26` 断言 `http.js` 不再引用 legacy 的 `./task-index.js`，git 版索引已不接线，不动它）。

### 2.1 过滤条件

```js
if (filters.scope === 'mine') {
  where.push(`EXISTS (
    SELECT 1 FROM sync_project_member mine
    WHERE mine.project_id = t.project_id
      AND mine.user_id = ?
      AND mine.trellis_dev_id IS NOT NULL
      AND t.assignee_dev_id = mine.trellis_dev_id COLLATE NOCASE
  )`)
  params.push(actor.userId)
}
```

替代 `t.assignee_user_id = ?`：索引列是索引时刻的快照，成员 dev id 变更后不重建索引就会漏/错；`sync_project_member` 是当前配置。`sync_task_index.project_id` 与 `sync_project_member.project_id` 均指向 `sync_project`，关联成立；`sync_project_member` 主键 `(project_id, user_id)` 直接命中。

`assignee` 维度过滤保持原样（`:819` `(t.assignee_user_id = ? OR t.assignee_dev_id = ? COLLATE NOCASE)`），`assignees` 分面不变（`:847-853`）。

列声明就是 `trellis_dev_id TEXT COLLATE NOCASE`（`apps/server/database.js:789`），这里沿用同一 NOCASE 语义；`trellis_lower()`（`database.js:1282`，Unicode 小写）只用于分支名模糊搜索（`:796`），不引入到 dev id 比较，避免与唯一索引 `sync_project_member_developer_unique`（`database.js:800-801`）的 ASCII NOCASE 语义分叉。已知边界：dev id 含非 ASCII 大小写差异时不视为同一人 —— 与现有唯一索引行为一致，不是本次引入的回归。

插入点：`etag` 在 `:750-758` 计算、`cacheKey` 在 `:749-771`，两者都在 `if (!scope.taskSpaceIds.length)` 提前返回（`:766-775`）之前，`mineMembers` 必须在 `etag` 之前取好。

### 2.2 缓存与 ETag

成员变更不 bump 索引 revision，`queryCache` 与 `etag` 会把旧的 mine 结果继续返回/304。两份哈希都加入成员签名（仅 mine 需要，其他 scope 为 `null`）：

```js
const mineMembers =
  filters.scope === 'mine'
    ? db
        .prepare(
          `SELECT project_id, trellis_dev_id FROM sync_project_member
           WHERE user_id = ? AND trellis_dev_id IS NOT NULL`,
        )
        .all(actor.userId)
        .map((row) => `${row.project_id}:${row.trellis_dev_id}`)
        .sort()
    : null
```

`etag`/`cacheKey` 的对象里加 `members: mineMembers`。一次小查询换掉跨模块失效通知，成员写入路径（`task-space-service.js:1068 upsertMember`、`removeMember`）无需改动。dev id 比较用 NOCASE，签名用小写归一化，避免大小写变化被当成不同视图（签名只在过滤结果集合变化时才有意义，用 `trellis_dev_id` 原值亦可；实现时统一 `toLowerCase()`）。

### 2.3 测试

新增 `apps/server/test/team-task-mine-scope.test.js`，从 `research/mine-scope-repro.test.js` 演化（去掉 `console.log`，改为断言）：

1. 成员 dev id 在索引前配置 → `scope=mine` 只返回该 dev id 的任务。
2. 成员 dev id 改为 `other-dev`（`PUT /api/projects/:id/members`）→ 立即返回 `other-dev` 的任务，且不再返回旧 dev id 的任务。
3. 大小写差异（任务 `Alice` / 成员 `alice`）→ 命中。
4. 成员变更后同一 `If-None-Match` 不再 304（etag 变化）。

## 3. 兼容性 / 回滚

- `client.json` 新增 `python_runtime`。旧客户端读不到该字段只是不做 Python 门禁，不影响 schema 3 的其他字段；`runtime_status` 走 `ClientConfigLike` 的读改写路径，字段缺失即自愈写入。
- `RuntimeStatus` 新增 `python` 为向后兼容（旧前端忽略未知字段）。
- 服务端 SQL 只用已有表与索引，无迁移；回滚为还原两个文件的 where + 哈希字段。
- Python 走官方安装器：完整 CPython（含 pip/site-packages），`task.py` 等脚本无需任何特殊处理（实测装完直接 `python.exe .trellis/scripts/task.py --help` 退出码 0），不存在便携包的 `._pth` 语义陷阱。
- 安装器是 per-user 安装（`InstallAllUsers=0`，卸载项在 HKCU）：无需管理员权限，`/uninstall /quiet` 可完整回滚（实测卸载后目录与注册项清零）；用户路径仅受 `PrependPath=1` 影响，若需完全静默不改 PATH 可改为 0（客户端始终记录绝对路径，功能不受影响）。

## 4. 风险

- Python 安装包 27 MB + 安装耗时约 77 s，与 Node 下载串行，冷启动最长安装时间增加；进度事件已覆盖（`python:install` 心跳）。
- `PrependPath=1` 会向 **用户** PATH 追加 Python312 与 Scripts 目录。若系统 PATH 里已有更早的 `python`（如 3.8），新终端里 `python` 仍可能解析到 3.8；因此客户端一律按 `client.json` 记录的绝对路径调用，不依赖 PATH 顺序。
- 安装器在个别机器上可能返回 3010（需重启）或被杀毒软件拦截；前者按成功处理，后者报错并给出官方下载链接。
- 已有 <3.9 的 Python 不会被卸载，机器上会并存两个版本；这是刻意选择（不擅自卸载用户软件），代价是磁盘多占约 100 MB。
