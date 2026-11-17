# 归档同步方案研究

## 1. 结论

采用“客户端活动-only + 服务端按 project/branch Git 归档导入”的双事实源方案：

```text
活动任务：Agent 双向同步
归档任务：服务端定时 Git 单向导入
```

归档索引继续由服务端统一提供，桌面客户端和普通浏览器共享同一份数据。客户端本地 archive 只由本机 Git/文件系统持有，不进入任务同步链路。

## 2. 当前事实

### 2.1 服务端存储

当前 schema v13 没有活动/归档分表：

- 正文文件在 `sync_task_space_file`。
- 查询索引在 `sync_task_index`。
- 归档由 `relative_path/task_dir` 中的 `archive/` 路径和 `sync_task_index.archived=1` 区分。

依据：

- `packages/server/database.js:829`
- `packages/server/database.js:928`
- `packages/server/team/task-space-index.js:1297`

### 2.2 客户端同步

当前客户端仍把 archive 作为同步对象：

- 全量扫描从 `.trellis/tasks` 根开始。
- 归档路径会进入 local snapshot、cursor、dirty、ownership 和 watcher。
- 活动移动到归档时会在同一批次配对旧路径删除和新路径写入。

依据：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:303`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:6762`

### 2.3 当前数据规模

2026-11-17 对当前本机 `board.sqlite` 的只读统计：

| 项目 | 分支 | 活动文件行 | 归档文件行 |
| --- | --- | ---: | ---: |
| mdp-backend-service | dev | 37 | 1,578 |
| mdp-backend-web | dev | 0 | 627 |
| mdp-management-web | release/3.0.0/dev | 0 | 1,615 |
| mdp-report-service | release/3.0.0/dev | 8 | 265 |
| trellis-board | main | 25 | 741 |
| 合计 |  | 67 | 4,826 |

归档占有效文件行约 `98.6%`。因此把 archive 从客户端同步集合移除，比继续优化“如何更快扫描归档”收益更大。

## 3. 候选方案

### 方案 A：继续 Agent 双向同步全部任务

- 优点：不改变库存、索引和归档可见性。
- 缺点：归档越多，扫描、ownership、HEAD diff、conflict 和 pending 面越大。
- 结论：不采用。

### 方案 B：Agent 归档时封存一次，服务端不再接收后续归档

- 优点：比全双向同步少。
- 缺点：服务端归档来源仍依赖客户端；新机器、离线 Agent、未提交本地修改会产生数据缺口；与“归档只从 Git 来”冲突。
- 结论：不采用。

### 方案 C：完全本地归档，服务端不保存

- 优点：客户端和服务端最轻。
- 缺点：普通浏览器、只读成员和未关联本地项目的用户无法查看团队归档；与已确认的“归档索引读服务端”冲突。
- 结论：不采用。

### 方案 D：客户端活动-only + 服务端 Git 单向导入

- 优点：客户端只承担活动任务；服务端归档来源明确为 Git；浏览器和桌面一致；服务端不创建项目工作副本。
- 缺点：新增 Git 调度、凭据、主机信任、bare cache 和归档索引投影复杂度。
- 结论：采用。

## 4. 凭据边界决策

用户确认：

- 不同远端来源使用不同凭据。
- 同一 `scheme + host + port` 内的项目共用一份凭据。
- `git.weintdata.cn:1022` 与 `github.com:443` 不能共用。

当前远端：

- `ssh://git.weintdata.cn:1022/prod-mdp/...`
- `https://github.com/yxtdhappy/trellis-board`

因此：

- 内部 SSH 项目匹配 `ssh://git.weintdata.cn:1022` 的只读 SSH 私钥。
- GitHub HTTPS 配置 `https://github.com:443` 的 Token 时使用 Token；未配置时按公开仓库匿名读取。
- 如果 GitHub 改为 SSH 远端，则使用独立的 `ssh://github.com:22` profile，不复用 HTTPS Token。

## 5. 一致性与可用性

### 5.1 用户接受的不一致

- 客户端本地归档完成，但未 commit/push 时，服务端归档不会出现。
- 已 push，但服务端尚未到下一轮同步时，最多延迟一个配置周期。
- 活动任务删除在 Agent revision 中先生效，归档在 Git revision 中后生效。

### 5.2 必须保证的完整

- 活动任务的 CAS 和冲突语义不变。
- Git 导入按 branch 原子替换；失败时保留最后成功快照。
- 不允许部分文件导入后推进 revision。
- 不允许把未配置来源的凭据用于任意 SSH/HTTPS 主机。
- 不允许 archive 重新进入 Agent snapshot 或 changes API。

## 6. 归档详情

归档索引和详情都从服务端读取：

- 索引：`sync_task_index.archived=1`
- 详情：按 archive 目录从 `sync_archive_file` 读取

因此桌面客户端不需要新增“本地归档桥”，普通浏览器和桌面客户端的行为一致。

## 7. 性能判断

客户端潜在收益：

- 常规扫描文件行从 `4,893` 降到 `67`。
- 全量目录遍历不再进入 archive。
- watcher 不再为每个归档文件产生事件。
- ownership、HEAD diff、cursor、pending 和 conflict 集合显著缩小。

服务端新增成本：

- 每 project 一个 bare cache。
- 每 branch 定时 fetch、ls-tree、cat-file。
- 只在 ref/内容变化时写 SQLite 和重建索引。
- Git 不进入 HTTP 请求线程，失败不阻塞任务创建。

## 8. 未纳入 MVP

- 归档二进制附件（图片、Office、PDF）。
- Git 历史版本浏览。
- 跨分支归档自动合并。
- 任意 Git 协议或任意远端 URL 探测。
- 客户端未提交归档的服务端预览。
