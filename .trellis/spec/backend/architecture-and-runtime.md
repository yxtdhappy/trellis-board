# 架构与运行时

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [server/config.js](../../../server/config.js) | 应用目录、SQLite 与旧 JSON 路径、默认仓库、仓库路径规范化 |
| [server/database.js](../../../server/database.js) | `node:sqlite` 连接、PRAGMA、schema v1 -> v3 顺序迁移、事务辅助和旧 JSON 一次性迁移 |
| [server/repositories.js](../../../server/repositories.js) | SQLite 白名单增删、ID 生成、路径规范化和显示顺序 |
| [server/metadata.js](../../../server/metadata.js) | 13 个阶段的合法 ID、SQLite 人工阶段存储 |
| [server/persistence.js](../../../server/persistence.js) | SQLite 扫描缓存和看板状态 facade |
| [server/task-location.js](../../../server/task-location.js) | 白名单任务定位、真实路径校验、身份冲突检查 |
| [server/execution-store.js](../../../server/execution-store.js) | 计划字段、标签、保存视图、阻断依赖和不可变事件事务 |
| [server/execution-projection.js](../../../server/execution-projection.js) | Board 批量执行摘要、依赖图、WIP/DoR/DoD 风险、注意力原因和详情事件投影 |
| [server/loader.js](../../../server/loader.js) | 扫描任务、读取证据、推导阶段、父子关系、列表投影 |
| [server/scan-worker.js](../../../server/scan-worker.js) | Worker Thread 内执行仓库扫描、增量任务刷新和结果汇总 |
| [server/watcher.js](../../../server/watcher.js) | 监听 `.trellis` 的 tasks、workspace、`.developer`，过滤相关事件 |
| [server/actions.js](../../../server/actions.js) | 创建任务、更新负责人和写操作边界校验 |
| [server/board-events.js](../../../server/board-events.js) | 单机与团队 Board 的 SSE 连接、鉴权复查、合并广播和关闭 |
| [server/index.js](../../../server/index.js) | HTTP 路由、静态资源、缓存、刷新队列、Worker 生命周期 |

依赖方向保持简单：

```text
server/index.js
  -> database / loader / metadata / persistence / actions / repositories / watcher
  -> task-location / execution-store / execution-projection

server/scan-worker.js
  -> database / loader / metadata / repositories

server/actions.js
  -> repositories / public/slug.js

server/task-location.js
  -> database / loader / metadata

server/loader.js
  -> config / public/slug.js
```

`config.js` 不应反向导入业务模块。`database.js` 是 SQLite schema 和迁移的唯一所有者；业务模块不绕过它的连接、事务和旧数据导入入口。`loader.js` 是可复用扫描核心，Worker、详情接口和测试都依赖它；不要在 HTTP 路由里另写一套扫描。

## 主线程与 Worker

HTTP 进程在主线程维护：

- `boardCache`、`inflightScan`、`queuedRefresh`。
- `scanWorkerRuntime`、请求 ID 和待完成请求 Map。
- `watchRuntime`、防抖计时器和待合并事件。
- 一个进程级默认 SQLite 连接，仓库、人工阶段和持久化 facade 共享它。

完整扫描交给 Worker Thread，避免长时间同步文件读取阻塞 API。Worker 协议使用消息类型 `scan`、`scan-result`、`scan-error`；请求通过 ID 匹配。单次扫描超时为 `180_000ms`。

Worker 内会缓存各仓库最近结果，并根据事件判断是仓库级重扫还是单任务增量刷新。Worker 模块加载后打开自己的 SQLite 连接，不跨线程共享 `DatabaseSync`。最终仍要重建跨仓库父子任务关系，因此前端状态变化不能只看单个任务结果。

## 启动与关闭

[server/index.js](../../../server/index.js) 启动时：

1. 打开 `data/board.sqlite`，按顺序迁移到 schema v3，创建仓库存储和 HTTP 服务。
2. 监听 `127.0.0.1:4317`。
3. 启动对白名单仓库的文件监听。
4. 异步触发启动扫描。

测试导入 `loader`、`repositories`、`actions` 等模块时不应意外启动 HTTP 服务。服务启动逻辑只保留在 `server/index.js` 的顶层入口。

## 同步与异步

- HTTP 请求体和网络处理使用 async API。
- 扫描内部大量使用同步 `fs`，但通过 Worker 隔离长扫描。
- SQLite 使用同步 `DatabaseSync`；多行状态写入必须在 `BEGIN IMMEDIATE` 事务中完成。
- 依赖行与其创建/解除事件必须处于同一事务；活动依赖边在写入前完成重复和环检测。
- 目标仓库的任务 `task.json` 仍使用同步临时文件加 rename，保证文件原子替换。
- 外部 `task.py` 使用 `spawn()` 和参数数组，不启用 shell；环境设置 `PYTHONUTF8=1`。

新增长耗时逻辑时先判断是否会阻塞 HTTP 主线程。单纯数百毫秒内的配置读写可沿用同步模式；全仓库扫描、递归目录和大文件解析应留在 Worker 或明确的异步流程。

### Scenario: Git 子进程的出站代理环境

#### 1. Scope / Trigger

Git 探测、clone、fetch、push 和远端身份检查都通过共享 `runGit()` 启动子进程。服务进程自身的代理环境不会自动传给使用最小环境的子进程；漏传会让企业代理网络中的 HTTPS 远端统一退化为 `GIT_REMOTE_FAILED`。

#### 2. Signatures

- `gitEnvironment(extra = {}) -> object`：构造所有 Git 子进程使用的环境。
- `runGit(args, options) -> Promise<{ code, stdout, stderr, truncated }>`：必须复用 `gitEnvironment()`。
- `minimalEnvironment(extra = {}) -> object`：通用子进程边界，不负责 Git 网络代理。

#### 3. Contracts

- Git 环境可继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及对应小写变量。
- 只复制非空值；未设置的代理变量不得以空字符串注入。
- `GIT_TERMINAL_PROMPT=0`、`GIT_CONFIG_NOSYSTEM=1`、全局配置隔离、askpass、SSH、TLS 和秘密脱敏必须继续生效。
- 代理变量不得因此进入插件、Python、工具链或其他通用子进程。

#### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 服务进程设置大写代理变量 | Git 子进程收到对应变量 |
| 服务进程只设置小写代理变量 | Git 子进程收到对应小写变量 |
| 代理变量为空或未设置 | Git 环境不包含该变量 |
| 通用 `minimalEnvironment()` 被调用 | 仍不包含代理变量 |
| Git 网络失败 | 保留现有 `GIT_REMOTE_FAILED`、认证、SSH 和超时分类 |

#### 5. Good/Base/Bad Cases

- Good：服务经 `HTTPS_PROXY=http://127.0.0.1:7897` 访问 GitHub，`git ls-remote` 成功并解析默认分支。
- Base：服务未配置代理，Git 子进程环境与本修复前一致。
- Bad：把整个 `process.env` 传给所有子进程，导致插件和脚本意外获得代理、凭证或宿主配置。

#### 6. Tests Required

- 单元测试断言大写、小写和空代理变量。
- 单元测试断言 `minimalEnvironment()` 不额外继承代理。
- 真实服务测试断言远端探测不再返回 `GIT_REMOTE_FAILED`。
- 浏览器测试断言“识别远端”成功回填项目名称和共享分支。

#### 7. Wrong vs Correct

Wrong：

```js
minimalEnvironment({ ...process.env });
```

Correct：

```js
minimalEnvironment({
  ...gitProcessOptions,
  ...proxyEnvironmentFromProcessEnv()
});
```

### Scenario: Windows OpenSSH 的环境与空配置

#### 1. Scope / Trigger

Windows OpenSSH 的 `ssh-keyscan.exe` 和 `ssh.exe` 在最小子进程环境中存在两个非预期行为：缺少 `PROGRAMDATA` 时会退出 255 且无输出；`-F NUL` 会被当作普通配置文件并报 `Can't open user config file NUL`。问题发生在认证前，不能通过更换私钥或凭据解决。

#### 2. Signatures

- `sshScanEnvironment({ platform, programData }) -> object`：构造 `ssh-keyscan` 的最小环境。
- `sshScanFailureDetails(result) -> object`：生成脱敏后的退出码、stderr 摘要、实际环境键和全局配置隔离状态。
- `writeSshWrapper(dir, options) -> path`：为 SSH Git 操作生成临时 `ssh` 包装器。
- `runGit(args, options)`：复用经过隔离的 Git 环境。

#### 3. Contracts

- Windows 的 SSH 扫描环境必须保留 `PROGRAMDATA`；其他平台不得凭空注入该变量。
- `ssh-keyscan` 通过 PATH 执行，不硬编码 Windows 用户路径；安装 `openssh-client` 的 Linux 使用 PATH 中的命令。
- `GIT_CONFIG_GLOBAL` 指向应用目录中的真实空文件，不能使用 Node/Windows 的 `NUL` 伪路径。
- SSH wrapper 使用临时目录中的空 `ssh_config`，不使用 `-F NUL`；`GlobalKnownHostsFile` 和 `UserKnownHostsFile` 也使用临时文件。
- 失败日志可包含 host、port、命令、退出码、脱敏 stderr、实际环境键和全局配置隔离状态，但不能包含本机文件路径、私钥、口令、令牌或完整主机公钥。

#### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| Windows 最小环境缺少 `PROGRAMDATA` | `ssh-keyscan` 可能退出 255 且 stdout/stderr 为空 |
| SSH wrapper 使用 `-F NUL` | `git ls-remote` 报 `Can't open user config file NUL` |
| `ssh-keyscan` 未返回合法主机公钥 | API 返回 `SSH_HOST_UNREACHABLE`，日志带脱敏诊断 |
| Git 远端返回非零退出码 | 保留认证/网络/仓库错误分类 |
| host key 未确认 | 仍返回主机指纹确认挑战，不自动信任 |

#### 5. Good/Base/Bad Cases

- Good：Windows 服务用最小环境扫描 `git.weintdata.cn:1022`，在确认三组主机指纹后通过 Deploy Key 读取默认分支。
- Base：Linux 服务安装 `openssh-client`，从 PATH 找到 `ssh-keyscan` 和 `ssh`，使用临时 `known_hosts`。
- Bad：硬编码 `C:\Users\...`、使用 `-F NUL`、关闭 `StrictHostKeyChecking` 或把整个宿主环境传给所有子进程。

#### 6. Tests Required

- 断言 Windows 扫描环境包含 `PROGRAMDATA`，Linux 分支不注入。
- 断言失败摘要保留 code、stderr 摘要并完成 URL/Bearer 脱敏。
- 断言失败摘要不包含测试机路径，并记录实际环境键和全局配置隔离状态。
- 运行 `npm test`，覆盖 Git 凭据、代理环境、SSH 扫描和 HTTP 探测。
- 真实服务确认主机指纹后断言项目名称和默认分支成功回填。

#### 7. Wrong vs Correct

Wrong：

```js
ssh -F NUL -o StrictHostKeyChecking=no ...
minimalEnvironment() // Windows 缺少 PROGRAMDATA
```

Correct：

```js
ssh -F "<temp>/ssh_config" \
  -o GlobalKnownHostsFile="<temp>/global_known_hosts" \
  -o UserKnownHostsFile="<temp>/known_hosts" ...
```

## 配置与常量

路径常量和旧 JSON 迁移来源由 [server/config.js](../../../server/config.js) 定义。业务模块按名称导入，不在本地重新拼接 `data/` 路径。运行时可变 Board 状态只通过 SQLite 读取和写入。

扫描输出结构由 `SCAN_SCHEMA_VERSION` 控制，当前为 `11`。该常量属于缓存兼容协议，不属于普通版本号；执行风险摘要、指标摘要或 flow 输出形状变化时必须同步递增。

## 反模式

- 在 HTTP 路由中直接递归扫描任务。
- 让 `loader.js` 持有 HTTP response、DOM 或页面状态。
- 用 shell 拼接用户输入后执行 `task.py`。
- 绕过 `database.js` / `persistence.js` 直接打开 SQLite，或为当前单机 MVP 引入外部数据库和 Web 框架。
- 在模块导入阶段启动监听器、Worker 或端口。
