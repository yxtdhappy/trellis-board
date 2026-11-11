# 服务端无 Git 实时任务同步 E2E 报告

## 1. 环境与版本

- 代码分支：`codex/server-gitless-task-sync`
- 工作提交：`c540120`
- Windows 构建：[43015769040](https://github.com/yxtdhappy/trellis-board/actions/runs/43015769040)
- 服务端：PID `29364`，监听 `0.0.0.0:4317`
- 服务端数据目录：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server`
- 客户端安装目录：`C:\Users\yuhaojie\AppData\Local\Trellis Board`
- 客户端版本：`0.2.0`
- 服务端进程在测试全程未重启。

## 2. Windows 构建与安装

GitHub `windows.yml` 两个 Job 均通过：

- `node tests (windows)`：Web 构建、服务端测试、Windows Agent/DPAPI 测试通过。
- `desktop build (windows)`：sidecar、Rust 单测、Tauri、NSIS 安装器、安装/卸载冒烟和启动冒烟通过。

安装器：

```text
C:\Users\yuhaojie\AppData\Local\TrellisBoardBuild\43015769040\bundle\nsis\Trellis Board_0.2.0_x64-setup.exe
SHA256=DA1D1B4A70E66435D8432DAEAFEC328188FD90FD507E58EA03C73021AECBAE58
```

静默覆盖安装退出码 `0`。安装后的 sidecar：

```text
C:\Users\yuhaojie\AppData\Local\Trellis Board\trellis-agent.exe
SHA256=20C2EC83B34E68D0F6157CCF4A344B6ECCDFE0685E910E7859EE822892D4F44B
```

## 3. 固定 Trellis runtime 初始化

测试目录：

```text
C:\Users\yuhaojie\AppData\Local\TrellisBoardBuild\acceptance-installed-runtime-20261111
```

受控 PATH 只包含：

- `C:\Windows\System32`
- `C:\Program Files\Git\cmd`
- `C:\Users\yuhaojie\AppData\Local\Python\bin`

`Get-Command node,npx,trellis` 返回 0 项。使用安装目录中的 `trellis-agent.exe` 执行：

```powershell
trellis-agent.exe initialize-project --path <repo> --developer yhj --tools codex
```

结果：

- sidecar 退出码 `0`，返回 `ok:true`。
- 生成 `.trellis/scripts/task.py`、`.codex`、`.agents`。
- `git rev-parse --verify HEAD` 退出码 `128`，说明初始化没有自动 commit。
- 工作区文件保持未跟踪，未自动 push。

结论：安装包内置 Node、固定 Trellis CLI 和 Windows sidecar 初始化链路真实可用，不依赖系统
`node`、`npx` 或 `trellis`。

## 4. Windows 客户端 E2E

安装后启动 `trellis-board-client.exe`，冷启动按设计显示本地登录页。用户手动登录后：

- 客户端 PID：`28456`
- Agent PID：`34224`
- Agent 心跳：`2026-11-11T12:17:43.091Z`，无错误
- Agent 到 `192.168.65.27:4317` 建立 TCP `Established`
- Board 显示 `trellis-board`、分支 `codex/server-gitless-task-sync`
- Board 显示 7 个任务，底部显示“客户端后台：运行中”

证据截图：

![客户端 Board](C:/Users/yuhaojie/AppData/Local/TrellisBoardBuild/client-board-20261111.png)

上一轮最终客户端构建中还完成了 UI 创建任务闭环：

- 命令 `627439cc-a9ae-4b55-a553-9b0d1b32cc88` 成功，`attempts=1`
- 本地生成任务目录，标题、负责人、优先级和详情正确
- 任务索引 `55 -> 56 -> 55`
- taskSpace revision `55 -> 56 -> 57`
- 客户端重启后事件流重新连接，没有 429、任务回滚或重复卡片

客户端当前设计为冷启动显示登录页；再次启动后需要用户登录，登录后 Agent 才会启动。因此
“进程重启”本身不等于自动恢复会话，实际验收以登录后的 Agent 心跳和执行态为准。

## 5. 真实服务端 schema 与数据

只读查询 PID `29364` 使用的数据库：

```json
{
  "schema": "10",
  "integrity": "ok",
  "journal": "wal",
  "hasOld": {
    "team_project": true,
    "project_live_file": true,
    "git_operation": true
  },
  "syncTables": 17,
  "counts": {
    "users": 4,
    "projects": 1,
    "taskSpaces": 1,
    "files": 380,
    "tasks": 55,
    "oldProjects": 0,
    "oldLiveFiles": 0,
    "oldGitOperations": 0
  }
}
```

taskSpace：

```json
{
  "id": "75984cbd-ed47-4389-bddf-2efbce07f275",
  "revision": 59,
  "indexed_revision": 59,
  "branch_name": "codex/server-gitless-task-sync",
  "status": "active"
}
```

服务端数据目录没有 `projects`，也没有 `git-credentials.key`。健康检查返回 `200`：

```json
{"status":"ok","mode":"team","processId":29364}
```

## 6. 数据库损坏与备份恢复

新增真实 HTTP + SQLite 恢复用例：

```powershell
node --test tests/team-realtime-sync.test.js
```

覆盖链路：

1. Agent 上传任务快照，revision 推进。
2. 强制创建 `VACUUM INTO` 数据库快照。
3. 停止隔离服务并将主数据库改成非法内容。
4. 验证服务拒绝打开损坏数据库并保留原文件。
5. 用最近快照覆盖损坏库。
6. 重启服务，`PRAGMA integrity_check=ok`。
7. 原 Agent 凭证无需重新注册即可读取任务，任务正文与 revision 恢复。

结果：4/4 通过，0 失败。

## 7. schema v10 升级与回退材料

`tests/database-v10.test.js` 已验证：

- 新库创建 17 个 `sync_*` 表并保留 `team_project`、`project_live_file`、`git_operation`。
- v6/v7/v8/v9 升级到 v10，旧项目行保留。
- 升级前 `pre-v10` 备份可独立打开，schema 仍为 `9`，旧项目行仍存在。
- 预置的 `projects/**` 和 `git-credentials.key` 不被删除。
- schema v10 重复打开幂等。

旧二进制只接受 schema 6-9，不能原地读取 v10。回退必须先恢复 `board.sqlite.pre-v10.*`，
升级后的 `sync_*` 数据不会回到旧版本。该约束已同步到设计文档和运维文档。

## 8. 自动化与构建

- `npm test`：496 项，484 通过、12 跳过、0 失败。
- `npm run build`：TypeScript 和 Vite 生产构建通过。
- SEA sidecar 本地构建通过，安装后的固定 runtime 初始化通过。
- GitHub Windows Node/Rust/Tauri/NSIS 构建通过。
- 本任务改动文件 `oxfmt --check` 通过。
- 仓库级 `format:check` 仍有 9 个与本任务无关的既有插件/测试 fixture 文件未格式化，未顺手修改。

## 9. 结论

PRD 的剩余三项验收已闭环：

- 无系统 Node/trellis/npx 时，安装包内固定 runtime 可初始化。
- 数据库损坏后可由最近快照恢复并继续使用原客户端读取任务。
- schema v10、旧表/旧文件保留、备份可独立打开、Windows 客户端重新接入均已验证。
