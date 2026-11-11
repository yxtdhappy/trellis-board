# 服务端无 Git 实时任务同步实施计划

## 1. 开始前门禁

只有用户在看到最终规划摘要后再次明确批准，才允许运行：

```text
python ./.trellis/scripts/task.py start
```

开始编码前必须完成：

- [x] 当前任务 `prd.md`、`design.md`、`implement.md` 三者无冲突；
- [x] `implement.jsonl`、`check.jsonl` 有真实条目；
- [x] PRD 的验收项能映射到本文验证步骤；
- [x] 用户明确批准实施；
- [x] 按用户要求在当前 `codex/server-gitless-task-sync` 分支原地实施，不建立 worktree；
- [x] 记录开始提交为 `651826a`；
- [ ] 记录隔离验证数据库路径；不修改真实 `data/board.sqlite`；
- [x] 不删除、重置或格式化当前工作区的无关改动。

开始实施时，已跟踪文件没有未提交修改，仅有其他线程留下的未跟踪任务目录：

- `.trellis/tasks/11-09-admin-all-team-action-guidance/`
- `.trellis/tasks/11-10-no-server-git-live-task-sync/`
- `.trellis/tasks/11-10-team-sync-line-ending-normalization/`

实施过程中必须保留这些目录和其他线程后续产生的无关改动，不把它们加入本任务提交。

## 2. 实施顺序

顺序按“先建立新链路，再删除旧链路”执行。新链路未通过自动测试前，不删除旧模块的最后可用实现。

### 步骤 1：共享身份与快照规则

目标：让客户端和服务端对远端、路径、任务目录、摘要和差异使用同一规则。

- [x] 新增 `shared/remote-identity.js`，迁移并收敛现有 HTTPS/SSH/scp 规范化逻辑；
- [x] 新增 `shared/task-snapshot.js`：
  - `.trellis/tasks/**` 路径校验；
  - 活动/归档任务目录解析；
  - task ID 提取；
  - 完整任务目录文件分组；
  - `same/local-only/server-only/content-conflict/move-delete-conflict/invalid` 分类；
  - 文件摘要集合比较；
- [x] 复用 `shared/live-text.js` 的 LF 规范化，不新增第二套换行规则；
- [x] 复用 `shared/trellis-agent-tools.js`，不硬编码 Agent flags；
- [x] 给共享纯函数补 Node 单测，先覆盖非法路径和边界输入。

本步骤验收：

- HTTPS 与 SSH 指向同一仓库时得到同一远端身份；
- `.trellis/workspace/**`、`.trellis/.developer`、Agent 工具目录全部被拒绝；
- 同一 task ID 从活动目录移动到归档目录可识别为移动，不是两个新任务；
- 仅 LF/CRLF 差异在规范化后判为相同。

### 步骤 2：SQLite schema v10

目标：建立新任务空间数据模型，不迁移或删除旧数据。

- [x] 在 `server/database.js` 将 schema 版本升到 `10`；
- [x] 新增 `ensureV10Schema()`；
- [x] 创建 `sync_project`、`sync_project_team_access`、`sync_project_member`；
- [x] 创建 `sync_task_space`、`sync_task_space_file`、`sync_task_space_batch`；
- [x] 创建 `sync_active_agent`、`sync_agent_binding`、`sync_agent_cursor`；
- [x] 创建 `sync_task_index`、`sync_task_index_tag`、`sync_task_space_scan_cache`；
- [x] 创建 `sync_task_command`、`sync_conflict`、`sync_conflict_backup`、`sync_file_audit`；
- [x] 为项目远端、taskSpace 分支、taskSpace 文件、binding、cursor、命令幂等和索引查询建立必要索引；
- [x] 保持旧表定义和旧数据不变；
- [x] schema 升级前 `VACUUM INTO` 备份；
- [x] 增加每日快照备份和最近 7 份保留策略。

本步骤验收：

- 全新数据库创建 v10 新表；
- 已有 v9 数据库升级后旧表行数不变、新表为空；
- 重复启动不重复建表或重复备份；
- 大于 v10 的 schema 仍拒绝启动；
- 不删除 `board.sqlite*`、旧 `data/projects` 或 Git 凭据密钥。

### 步骤 3：项目、任务空间与访问服务

目标：用客户端接入替代服务端项目 clone/approve。

- [x] 新增 `server/team/task-space-service.js`；
- [x] 实现 `resolve`：按规范化远端返回新建、可加入或需要授权；
- [x] 实现 pre-attach `preflight`：无 binding 时只返回任务 manifest 元数据，不写任何 `sync_*` 表；
- [x] 实现 `attach`：创建全局项目、owner team、首位 lead、任务空间和 binding；
- [x] 并发接入相同远端时依赖唯一键和 `BEGIN IMMEDIATE` 收敛到同一项目；
- [x] 同项目不同分支创建独立 taskSpace；
- [x] 实现 owner team 自动可读；
- [x] 实现其他团队邀请/移除；
- [x] 实现项目成员和 Trellis developer ID 映射；
- [x] 实现项目停用、taskSpace 停用和绑定撤销；
- [x] 重写 `permissions.js` 的项目读取和写入判定；
- [x] 更新 Board 项目列表、状态和任务查询，区分 Git 项目与任务空间。

本步骤验收：

- 团队 A 首次接入创建 owner team；
- 团队 B 未邀请时看不到任务内容；
- 邀请后团队 B 命中同一 project/taskSpace，不新建重复项目；
- 同远端不同分支有两个 taskSpace ID、两份 revision 和两份 cursor；
- 非项目写成员不能执行任务写入。

### 步骤 4：tasks-only 快照、CAS 和冲突

目标：服务端从“Git 基线 + 覆盖层”改为单一持久化快照。

- [x] 新增 `server/team/task-snapshot-service.js`；
- [x] 实现 manifest/incremental snapshot API；
- [x] 实现单文件 `baseSha256` CAS；
- [x] 实现 taskSpace 级 revision 单调递增；
- [x] 实现单 batch 事务、整批成功或整批拒绝；
- [x] 实现 batch 幂等、同 batch 不同请求冲突和文件 no-op；
- [x] 实现删除墓碑；
- [x] 实现活动/归档移动在同一 batch 内原子提交；
- [x] 实现 `sync_file_audit`；
- [x] 实现首次接入 manifest 比较；
- [x] 实现冲突记录、来源人员/设备/时间投影；
- [x] 实现“使用服务端版本”“用我的版本覆盖”“仅保存本地副本”；
- [x] 覆盖前保存服务端旧内容和新内容，二次确认并写审计；
- [x] 保留现有责任人确认 preflight，与 CAS 冲突分开响应。

本步骤验收：

- 两个客户端基于同一摘要修改同一文件时只有一个成功；
- 任一文件冲突时同 batch 其他文件也不落库；
- 重复 batch 返回同一 revision，不重复写审计；
- 删除后增量拉取能收到墓碑；
- 冲突消息不直接要求用户理解 SHA、HTTP 状态码或 revision；
- 覆盖动作可查到双方备份、覆盖人、设备和时间。

### 步骤 5：纯快照扫描与任务索引

目标：Board 只依赖服务端快照，不再读取 Git 工作副本或项目脚本。

- [x] 调整 `server/loader.js`，支持注入 workspace/member/repository metadata；
- [x] Team 快照扫描只物化 `.trellis/tasks/**`；
- [x] `scanRepository()` 不启动 Git 子进程，不读取 scripts/spec/config/workflow/workspace；
- [x] 重写 `server/team/scan-worker.js` 的物化入口；
- [x] Worker 从 `sync_task_space_file` 读取 revision 快照；
- [x] `sync_task_index` 以 taskSpace 为主键边界；
- [x] `taskKey`、`executionTaskKey` 包含 taskSpace 身份；
- [x] 使用 `task.json.id` 作为稳定执行身份；
- [x] 更新手工阶段、计划字段、依赖、事件、assignment、归档和详情查询；
- [x] 同 taskSpace 重复 task ID 显示身份冲突；
- [x] 非同 taskSpace 相同 ID/路径互不影响；
- [x] workspace journal 阶段显示“服务端不判定”，不伪造完成或失败。

本步骤验收：

- 删除所有服务端项目工作副本后，已有快照仍能构建完整 Board；
- 活动任务归档移动后，旧活动路径不再出现在索引；
- 同一远端两个分支有完全独立的 Board、revision 和 cursor；
- 服务端扫描不依赖 `.trellis/scripts` 或 `.trellis/spec` 是否存在。

### 步骤 6：单账号单 Agent 与服务端命令

目标：Web 创建/改派只向目标用户唯一在线 Agent 发命令。

- [x] Agent 注册事务写 `sync_active_agent`；
- [x] 新设备生效时撤销旧设备、旧 binding，取消旧命令，关闭旧 SSE；
- [x] `authenticate()` 校验 active slot；
- [x] 同一安装有效凭证重复登录继续复用原 Agent；
- [x] 新设备保留账号项目权限，不保留本地路径和 binding；
- [x] 新增 `server/team/task-command-service.js`；
- [x] Web 创建和改派先检查目标用户唯一在线、approved binding、项目写角色和 developer 映射；
- [x] 新增 `/api/task-operations` 查询、重试、取消；
- [x] 命令成功必须晚于 CAS 上传和索引命中；
- [x] 命令失败前不创建正式 task index 行，不改变原负责人；
- [x] 移除旧 `git_operation` 路径。

本步骤验收：

- 目标 Agent 离线时返回具体用户、项目、分支和下一步；
- 在线命令只产生独立操作项，不产生空任务卡；
- 改派完成前原负责人不变；
- 新设备登录后旧凭证立即 401，旧 SSE 关闭，旧 pending 命令 cancelled；
- 重试不会生成第二个任务。

### 步骤 7：客户端项目接入、初始化和推送检测

目标：用户在客户端选择本地 Git 仓库完成项目接入。

- [x] 新增 `agent/project-onboarding.js`；
- [x] 实现仓库根、origin、branch、HEAD、`.trellis` 和 Agent 工具预检；
- [x] 扩展 `agent/git-sync.js` 白名单：`ls-remote`、`ls-tree`，保持 push 等禁止；
- [x] 新增 `desktop/sidecar/trellis-runtime.js`；
- [x] 桌面安装包包含固定 Node runtime、`@mindfoldhq/trellis@0.6.17` 和模板文件；
- [x] 缺少 `.trellis` 时调用固定 `trellis init -y --skip-existing -u <dev> <flags>`；
- [x] 已有 `.trellis` 时跳过基础初始化；
- [x] 实现“添加本机其他 Agent 工具”，只改当前仓库；
- [x] 实现推送状态机：未提交、未推送、本地领先、远端领先、分叉、无法确认、ready；
- [x] `resolve` 和 pre-attach `preflight` 只读；`attach` 才写项目和 binding；
- [x] 目录选择取消不写本地或服务端状态；
- [x] 首次接入先预检，用户明确选择后才 attach；`暂不接入` 只清除待接入路径；
- [x] binding 持久化 `initialSyncMode` 和 `initialSyncCompleted`，配置重载后不丢失；
- [x] 扩展 Tauri capability 和 sidecar CLI，但不开放通用命令执行。

本步骤验收：

- 无系统 `trellis`/`npx` 的机器仍可初始化；
- 初始化不自动 commit/push；
- 网络不可达显示“无法确认”，不显示“未推送”；
- 已有 `.trellis` 项目直接进入任务比较；
- 同一安装可增加 Codex/OpenCode/Pi 等工具，不同设备无需一致。

### 步骤 8：客户端 tasks-only 同步和本地任务命令

目标：客户端只同步任务，并以完整任务目录安全落盘/上传。

- [x] 将 `agent/live-sync.js` 的路径过滤收紧到 `.trellis/tasks/**`；
- [x] 移除 `.developer` 和 `workspace/**` 上传/拉取；
- [x] binding/cursor/pending 从 projectId 改为 taskSpaceId；
- [x] 首次接入执行 manifest 比较，展示三个预检入口；
- [x] `bootstrap` 只用于空服务端快照；`safe` 不只上传本地独有内容；`review` 无差异时直接完成；
- [x] 本地应用远端 revision 使用目录级 staging + swap；
- [x] 冲突显示任务名、文件、人员、设备、时间；
- [x] 四个冲突动作接到 sidecar/Tauri；
- [x] 新增 `agent/task-command.js`；
- [x] `create_task` 调用本地 `.trellis/scripts/task.py create`；
- [x] `assign_task` 原子修改 `task.json.assignee`；
- [x] 命令前后比较 Git 状态，只允许目标路径变化；
- [x] 无关 dirty 允许，目标路径 dirty 给出具体文件；
- [x] 检查 merge/rebase/cherry-pick/revert 中断状态；
- [x] 命令成功后走同一 CAS 同步并等待服务端确认；
- [x] 同步中展示分支切换风险，不增加拦截或自动修复逻辑。

本步骤验收：

- 源码或其他任务 dirty 不阻塞创建/改派；
- 目标任务 `task.json` dirty 或版本变化时拒绝；
- 远端 revision 本地写入失败时不会留下半个任务；
- 客户端重启不重新 full pull 已删除/归档的旧路径；
- 同步协议绝不发送 workspace、developer、scripts、spec 或 Agent 目录。

### 步骤 9：Web 项目接入、分支、冲突和操作项

目标：让新链路在 Board 上可理解、可操作。

- [x] `Project`/`TaskSpace` 类型和 API 归一化增加 projectId、taskSpaceId、branch、revision；
- [x] ProjectRail 增加“接入本地项目”和分支子项；
- [x] 实现接入向导：团队、developer ID、Agent tools、初始化状态、推送状态；
- [x] 实现 Web 向导内首次接入预检和差异选择，选择前不建立 binding；
- [x] 实现冲突弹窗和技术详情折叠；
- [x] 实现任务操作列表和进度弹窗；
- [x] CreateTaskDialog 改为选择 taskSpace；
- [x] TaskDetail 改派时显示“改派中”并保留原负责人；
- [x] 任务卡/详情显示 branch；
- [x] 同步中显示分支切换风险提示；
- [x] 新设备替换后旧端显示下线原因；
- [x] 管理台删除 Git 凭据、SSH trust、probe、工具链批准；
- [x] 项目访问页增加团队邀请。

本步骤验收：

- 新建项目不要求管理员预先创建；
- 目标 Agent 离线时表单保留输入并显示可操作错误；
- 成功请求关闭表单，但正式任务只在 Agent 上传后出现；
- 冲突不展示不可理解的裸 SHA/HTTP 状态；
- 1440/1024/860px、浅色/深色均可操作，无页面级横向滚动。

### 步骤 10：删除 Team 服务端 Git 运行时

目标：代码和运行时不再依赖项目 Git。

- [x] 删除 `server/team/git-manager.js` 的 Team runtime 引用；
- [x] Team runtime 不引用 `git-credentials.js`；旧文件暂保留给历史模块测试和人工回滚；
- [x] Team runtime 不引用 `git-askpass.js`；旧文件暂保留给历史模块测试和人工回滚；
- [x] 远端规范化纯函数移入 `shared/remote-identity.js`；旧模块文件不进入 Team runtime；
- [x] 删除 `createTeamRuntime()` 中的 credential/git manager；
- [x] 删除项目 clone、refresh、repair、approve、credential 和 SSH challenge 路由；
- [x] 删除 Team runtime 的 Git 刷新启动和 `gitPollMs` 配置；旧 scheduler helper 不再装配；
- [x] 删除 `git_operation` 任务写入、commit、push、remote recovery；
- [x] Team Web UI 与 HTTP 路由移除 Git 凭据/probe/SSH/Git operation 入口；
- [x] 确保 Team 模块不 spawn `git clone/fetch/commit/push`；
- [x] 不删除旧数据库表、旧目录和密钥文件。

本步骤验收：

- Team 服务启动后 `data/projects` 不新增或访问；
- Team 模式日志和 API 不出现服务端 Git fetch/push；
- 删除项目不删除客户端 Git 仓库；
- 单独模式仍能使用本机仓库和 `task.py`。

### 步骤 11：测试、文档和最终验收

- [x] 更新 `.trellis/spec/backend/architecture-and-runtime.md`；
- [x] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`；
- [x] 更新 `.trellis/spec/backend/http-and-filesystem.md`；
- [x] 更新 `.trellis/spec/backend/scanning-and-persistence.md`；
- [x] 更新 `.trellis/spec/frontend/rendering-and-state.md`；
- [x] 更新 `docs/team-operations.md` 的备份、部署和回滚；
- [ ] 用隔离服务和数据库完成 Windows E2E；
- [x] 完整执行 Node 全量测试 490 项：476 通过、12 跳过、2 个未触及的 Windows 临时目录
  清理 `EPERM`；两项对应测试分别串行复跑通过，业务和新增测试无失败；
- [x] 执行最终 Web 生产构建并通过；
- [ ] Tauri/Rust 构建未执行：本机 PATH 和常见安装路径均没有 `cargo`；
- [x] 检查 dirty diff 并区分本任务、其他任务目录和既有无关改动；
- [x] 当前未收到 commit/push/archive 授权，因此均未执行。

## 3. 测试文件规划

新增或改写：

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/shared-remote-identity.test.js` | HTTPS/SSH/scp 规范化和非法输入 |
| `tests/task-snapshot.test.js` | 路径、任务分组、差异分类、移动识别 |
| `tests/database-v10.test.js` | 新表、旧表保留、升级备份 |
| `tests/team-task-spaces.test.js` | 全局唯一、分支隔离、团队访问 |
| `tests/team-task-snapshot.test.js` | CAS、revision、幂等、墓碑、冲突和审计 |
| `tests/team-task-index-v10.test.js` | tasks-only 扫描、归档移动、taskSpace 隔离 |
| `tests/team-agent-slot.test.js` | 单活跃 Agent、旧 SSE、旧命令和换设备 |
| `tests/team-task-commands.test.js` | 在线检查、命令状态、创建/改派和重试 |
| `agent/test/project-onboarding.test.js` | 初始化、push 检测、已有 `.trellis` |
| `agent/test/task-command.test.js` | 本地 task.py、assign、路径级 dirty 保护 |
| `tests/desktop-realtime-apply.test.js` | tasks-only、CAS、目录级应用、预检和冲突 |
| `tests/team-realtime-sync.test.js` | 两客户端同步、revision、SSE 和 P95 |
| `tests/desktop-package.test.js` | Trellis runtime 打包、安装和 Tauri 命令 |
| `tests/team-static.test.js` | 新路由、删除旧路由和错误文案 |

保留并回归：

- 用户登录、团队权限、审计；
- 方案字段、人工阶段、依赖、撤销；
- 归档分页、成员映射、Board SSE；
- 单独模式仓库扫描和本机 `task.py`。

## 4. 风险文件

| 文件或区域 | 风险 | 控制 |
| --- | --- | --- |
| `server/database.js` | schema 升级错误或误改旧表 | 只追加 `sync_*`；升级前备份；旧行数断言 |
| `server/team/http.js` | 路由混杂旧新协议 | 明确删除列表；新路径独立；404 测试 |
| `server/team/task-index.js` | taskSpace 隔离遗漏 | 所有 PK/唯一索引/缓存/查询带 taskSpace |
| `server/loader.js` | 为 Team 改坏 standalone | 新能力全部可选；standalone 回归 |
| `server/team/agents.js` | 换设备导致权限误删 | 只替换活动槽/binding，不删账号项目权限 |
| `agent/live-sync.js` | 再次出现旧路径回灌 | 删除 Git 合并逻辑；目录级应用；cursor 测试 |
| `agent/git-sync.js` | 新增 Git 操作过宽 | 只加只读 `ls-remote/ls-tree`；继续禁 push |
| `agent/task-command.js` | 命令执行越权或误改源码 | 白名单参数、无 shell、前后状态差、目标路径限制 |
| `desktop/sidecar/*` | 安装包缺少 Trellis runtime | 打包清单、缺 runtime 明确失败、真实安装测试 |
| `web/src/hooks/useBoard.ts` | 分支/taskSpace 旧响应覆盖 | 请求序号、切换清空 cursor/ETag/旧页 |
| 当前共享工作区 | 覆盖另一线程改动 | 每个阶段前核对状态；保留无关路径；显式路径 staging |

## 5. 验证顺序

开发过程中只做必要的小范围测试，不执行构建。全部代码完成后按以下顺序验证一次：

1. 格式检查：

```text
npm run format:check
```

2. 共享与服务端目标测试：

```text
node --test tests/shared-remote-identity.test.js tests/task-snapshot.test.js tests/database-v10.test.js tests/team-task-spaces.test.js tests/team-task-snapshot.test.js tests/team-task-index-v10.test.js tests/team-agent-slot.test.js tests/team-task-commands.test.js
```

3. Agent 目标测试：

```text
node --test agent/test/project-onboarding.test.js agent/test/task-command.test.js agent/test/git-sync.test.js agent/test/protocol.test.js agent/test/runtime-cli.test.js
```

4. 客户端同步和打包测试：

```text
node --test tests/desktop-realtime-apply.test.js tests/team-realtime-sync.test.js tests/desktop-package.test.js tests/team-static.test.js
```

5. 全量 Node 测试：

```text
npm test
```

6. 前端类型检查和生产构建，仅在全部开发完成后执行一次：

```text
npm run build
```

7. Windows 桌面：

```text
npm --prefix desktop run build
cargo test
```

8. 隔离真实服务：

- 独立复制一份应用和运行数据；
- 独立端口；
- 独立 `board.sqlite`；
- 临时 bare Git 远端；
- 两个真实 Agent 配置；
- 不改、不重启真实 4317 服务，不写真实 `data/board.sqlite`。

## 6. E2E 验收脚本

### 场景 A：新项目

1. 创建没有 `.trellis` 的 Git 仓库；
2. 客户端选目录，选择团队、developer ID、Codex + OpenCode；
3. 验证初始化生成 `.trellis` 和两个 Agent 目录；
4. 未 commit 时显示 waiting_commit；
5. commit 未 push 时显示 waiting_push；
6. 关闭网络时显示 unable_to_verify；
7. push 后显示 ready；
8. 用户确认后 attach，服务端创建 project/taskSpace，不创建 Git 工作副本；
9. 第二个客户端同一远端/分支命中同一 taskSpace。

### 场景 B：同步和冲突

1. A 修改任务 `task.json` 并上传；
2. B 通过 SSE 拉取并在 3 秒目标内更新本地目录和 Board；
3. A/B 基于同一摘要同时修改；
4. 先提交者成功，后提交者得到 `TASK_FILE_CONFLICT`；
5. 冲突弹窗显示任务、文件、人员、设备、时间；
6. 分别验证查看差异、使用服务端、覆盖、仅保存本地副本；
7. 覆盖后双方备份和审计可读。

### 场景 C：归档移动和重启

1. A 将任务从活动目录移动到 archive；
2. 上传完成；
3. B 原子应用目录移动；
4. 重启 A/B；
5. 两端都不恢复旧活动路径；
6. Board 只有归档任务。

### 场景 D：Web 创建和改派

1. 目标用户 Agent 离线，创建/改派返回明确拒绝；
2. Agent 上线并关联目标 taskSpace；
3. Web 创建返回 202 操作项，正式任务暂不出现；
4. Agent 本地 `task.py create`，CAS 上传，Board 出现任务；
5. 改派前原负责人不变；
6. Agent 修改并上传后新负责人出现；
7. 重试同一操作不生成重复任务。

### 场景 E：单账号单 Agent

1. 设备 A 在线并有 binding；
2. 设备 B 登录同账号；
3. 设备 A 立即失去 Agent 鉴权；
4. 设备 A SSE 关闭，pending/delivered/running 命令取消；
5. 设备 B 保留账号项目权限；
6. 设备 B 未重新选本地仓库前不能领取任务命令；
7. 设备 B 手动关联后恢复命令能力。

### 场景 F：分支隔离

1. 同一远端创建 `main` 和 `feature/x` 两个 taskSpace；
2. 在两分支创建同名 task ID；
3. 分别上传和删除；
4. 两个 taskSpace revision、cursor、Board 行完全隔离；
5. “全部项目”只显示两个 taskSpace 的项目/分支摘要，不混合任务卡。

## 7. 回滚点

### 回滚点 1：共享模块和 schema 完成后

- 新表已创建但 Team 仍走旧实现；
- 出错时回退代码，数据库新表可保留不动；
- 不运行任何旧表数据删除。

### 回滚点 2：新快照服务完成后

- 新 API 可在测试服务启用；
- 旧 Team runtime 仍能启动；
- 仅测试数据库可删除重建。

### 回滚点 3：新客户端和服务端联调完成后

- 两个 Agent 新协议可工作；
- 保留旧代码到 Web 和删除步骤前；
- 失败时回退分支到开始提交，不重置用户数据。

### 最终回滚

- 停止新服务；
- 保留 `sync_*` 表和客户端新备份；
- 回退到 `codex/server-gitless-task-sync` 的起点提交或旧二进制；
- 旧二进制继续读取旧表；
- 不自动删除 `data/projects`、`git-credentials.key`、SQLite 或客户端冲突备份。

## 8. 完成标准

- [ ] PRD 验收项全部有测试或 E2E 证据；
- [x] Team 服务端不执行项目 Git clone/fetch/commit/push；
- [x] 服务端只接受和投影 `.trellis/tasks/**`；
- [x] 同远端同分支全局唯一，不同分支完全隔离；
- [x] 同文件并发写采用 CAS，无静默覆盖；
- [x] 首次接入、重启、归档移动、冲突和离线均有确定状态；
- [x] 一个账号只有一个有效 Agent；
- [x] Web 创建/改派只在目标 Agent 在线时下发；
- [x] 客户端可离线初始化 Trellis 并检查首次推送；
- [x] 前端和管理台没有旧 Git 凭据/服务端初始化入口；
- [x] 串行全量执行 490 项：476 通过、12 跳过、2 个无关 Windows 临时目录清理 `EPERM`；
  对应测试分别串行复跑通过；
- [x] 最终 Web 生产构建通过；
- [ ] Tauri/Rust 构建未执行：当前机器没有 `cargo`；
- [x] 真实 4317 服务和真实数据库未被修改；
- [x] 当前授权下未执行 commit/push/archive。
