# 检查报告：合并后任务归属与同步暂停

## 结论

`main@8ddea09` 已通过聚焦回归、真实服务 API、真实 Windows 客户端和 GitHub Actions
Windows 质量门禁。功能验收通过，没有阻断 `v0.4.7` 发布的未修复缺陷。

## 已修复并验证

- `apps/server/team/gitless-board-service.js`
  - `/api/board` 在缓存任务覆盖列表任务时补回 `sourceBranchName`。
  - `/api/task` 直接详情按项目稳定任务 ID 查询合入证据并返回 `sourceBranchName`。
- `apps/server/test/team-gitless-http.test.js`
  - 覆盖基线接纳来源任务后的 `/api/board` 与 `/api/task` 来源分支回归断言。
- `apps/desktop/src-tauri/src/agent/task_sync.rs`
  - 归属展示投影不再递归读取和哈希任务正文。
  - HEAD 未变时复用分支和路径集合，15 秒内直接复用完整投影。
  - watcher、binding 或 HEAD 变化会使缓存失效，代际计数阻止旧结果回写。
  - 上传和冲突门禁仍执行完整、精确校验。
- `apps/desktop/src-tauri/src/agent/device.rs`、`apps/desktop/src-tauri/src/agent/http.rs`
  - 本地、私网、链路本地、IPv6 ULA/link-local 和 `.local` 地址绕过 HTTP 代理。
- 既有检查修复继续保留：
  - 覆盖服务端冲突时传递合入证据。
  - 空分支归属补齐后继续执行基线 HEAD 判定。
  - 来源 taskSpace 收到 `TASK_OWNED_BY_BASELINE` 后清除 pending，不推进 revision/sequence/baseline。

## 自动验证

聚焦回归：

```powershell
node --test apps/server/test/team-task-snapshot.test.js apps/server/test/team-task-index-v10.test.js apps/server/test/team-task-spaces.test.js apps/server/test/team-gitless-http.test.js apps/web/test/team-web.test.js
```

结果：`60/60` 通过。

其他已通过检查：

- Web 生产构建成功，只有既有大 chunk 警告。
- `npm run lint --workspace @trellis-board/web`：通过，只有既有 warning。
- `npx tsc -b apps/web/tsconfig.json --pretty false`：通过。
- 改动 JavaScript/TypeScript 文件的 `oxfmt --check`：通过。
- `git diff --check`：通过。
- GitHub Actions run `43535564677`：Node/Web 测试、Desktop bundle、Rust 单测、
  Windows portable 打包、SHA256、portable smoke test、launch smoke test 全部成功。

## 真实环境验证

- 服务端 PID `35308`，Team 模式，schema `12`、WAL、`integrity=ok`。
- 5 个正式 binding 均为 `approved/ready/listening`。
- `mdp-backend-web` 基线 taskSpace：98 个索引任务、98 个唯一稳定任务 ID。
- `dev` 与 `feat/trellis-board` 的 95 个重叠稳定 ID 默认为只显示 `dev` 副本。
- `/api/tasks/query` 返回 98 条、98 个唯一稳定 ID、0 重复。
- `/api/board` 的 98 条归档任务全部返回 `sourceBranchName`。
- 真实归档页面显示“分支 dev · 来源 feat/trellis-board”，未显示为暂停。
- 17 条 `tracked-in-head` 证据覆盖 17 个任务、7 个来源分支。

未合入探针：

- 在 `mdp-backend-web` 创建 `branch=dev1` 的临时任务后，ProjectRail 出现
  `ownershipPausedCount=1`。
- 等待超过投影 TTL 和多个状态周期后，merge evidence 保持 `17`，服务端 revision 保持 `102`。
- 探针未上传、未生成证据；清理后关联恢复 `paused=0/pending=0/ready`。

## 资源与连接

- 修复前：约 `25%` 单核平均、最高 `101.56%`，存在周期性约 `100%` 尖峰。
- `8ddea09` 预构建：两次稳定采样的单核平均分别为 `4.22%`、`4.69%`。
- 本轮复测：Board 页面平均 `5.99%`，归档页面平均 `6.72%`；最小 `0`，最高 `18.75%`。
- 工作集约 `109.6 MB` 至 `111.7 MB`。
- 没有周期性约 `100%` 尖峰，也没有连接 `127.0.0.1:7897`；只有到
  `192.168.65.27:4317` 的直连。

残余约 `6%` 单核占用来自仍保留的三个固定 3 秒状态轮询：Team 状态、本地关联和 sidecar
状态。任务正文同步仍由 watcher 和 SSE 驱动。尚未做逐项 CPU 火焰图，因此不能把该残余值
归因到单一轮询，也不能宣称已经达到 `<2%`。

## 已知非阻断问题

- `apps/server/test/database-v10.test.js` 在本机 Node `24.21.0` / Windows 上，v9 升级断言
  完成后，临时 SQLite WAL 句柄可能在 `fs.rmSync` 时短暂未释放，导致临时目录清理报
  `EPERM/EBUSY`。迁移和备份断言先通过，GitHub Actions 全量门禁通过；该问题不是产品链路缺陷。

## 残留风险

- 服务端不接 Git 时，`tracked-in-head` 是已批准基线 Agent 的受信声明。服务端校验 active
  Agent、approved binding、分支、任务 ID、目录、受控路径、结构和证据一致性，但不能独立
  证明 Agent 伪造了 HEAD 路径。
- 迁移按最早活动 taskSpace 选择基线。若历史项目最早 taskSpace 不是实际开发基线，需要人工
  修正；本任务未提供基线切换 UI。
- 已合入任务之后从基线快照删除后的归属回退语义不在本任务范围内。
