# Board 项目栏关联本地仓库分析

## 当前边界

- Board 项目栏是服务端 `web/` 前端，在 Tauri WebView 中加载：[BoardPage.tsx](../../../../web/src/pages/board/BoardPage.tsx:107)。
- 本地 Git 路径和目录选择器只存在于 Windows 客户端。
- 当前桌面 capability 不让远程 Board 调用 Tauri IPC。
- 当前本地绑定只有 Agent CLI 入口，最终由 Agent heartbeat 上报服务端：[cli.js](../../../../agent/cli.js:300)、[agents.js](../../../../server/team/agents.js:430)。
- 当前新绑定写入 `pending`，需要项目负责人操作后改为 `approved`：[agents.js](../../../../server/team/agents.js:561)、[agents.js](../../../../server/team/agents.js:775)。

## Tauri v2 远程能力

Tauri v2 capability 支持通过 `remote.urls` 仅向指定远程 origin 暴露选定命令。实施时新增独立 capability：

```json
{
  "identifier": "board-local-association",
  "windows": ["main"],
  "remote": {
    "urls": ["https://*", "http://localhost:*", "http://127.0.0.1:*"]
  },
  "permissions": [
    "allow-associate-local-project",
    "allow-list-local-associations"
  ]
}
```

远程页面只获得这两个命令，不获得通用文件系统、Shell、进程或 dialog 权限。Rust 命令仍必须动态校验当前页面 origin 等于本次登录成功的 Board origin，形成第二道防线。

## 关联流程

```text
Board 项目栏
  -> window.__TAURI__.core.invoke("associate_local_project")
  -> Rust 校验 Board origin + projectId
  -> 系统目录选择器
  -> sidecar inspectRepository()
  -> 本地分支 / .trellis / origin 强校验
  -> 创建本地绑定并触发一次 heartbeat
  -> 服务端验证团队成员、项目状态和远端身份
  -> 绑定立即 approved（read_only 则只读）
  -> Board 项目栏显示“本地已关联”
```

## 权限规则

- 目标团队的 active member 可以关联该团队全部 active 项目。
- 显式 `project_member.role=read_only` 保留只读：可以接收服务端内容，不能上传本地修改。
- 项目负责人审批和新绑定的 `pending` 状态不再出现在用户流程中。
- 项目停用、团队移除、设备撤销、Git origin 或分支不匹配时，绑定失效。

