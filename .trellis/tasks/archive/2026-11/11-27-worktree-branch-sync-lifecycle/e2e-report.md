# 实机 E2E 验收报告：Worktree 分支标识与服务端差异化归档同步

## 1. 验收拓扑与版本证据

| 项 | 值 |
| --- | --- |
| 仓库基线 HEAD | `95c29a2`（含当前未提交工作区改动） |
| 验收层级 | **L1（自动测试）+ L2（真实服务端 + WebView2 浏览器 DOM）+ L3（真实 Tauri 客户端 + WebView2 CDP + 真实 Git worktree）** |
| 隔离数据根目录 | `C:\projects\_trellis-board-e2e\11-27-worktree-branch-sync-lifecycle\` |
| 隔离服务端 | `node packages/server/index.js`（`TRELLIS_BOARD_MODE=team`, `PORT=4467`, `basePath=/weint-spec-board`, `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=true`） |
| 服务端进程证据 | `GET /weint-spec-board/api/health` → `{"status":"ok","mode":"team","processId":16916,"serverStartedAt":"2026-11-27T10:54:09.439Z","version":"0.5.18"}` |
| Web 产物 | `npm run build` 产出 `packages/server/public/assets/admin-BQXsYEbC.js`（1.00s） |
| 真实客户端 | `cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml` 产出 `packages/desktop/src-tauri/target/debug/trellis-board-client.exe` |
| 客户端 CDP 端口 | `9367`（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9367`），`TRELLIS_DESKTOP_HOME=...\clients\c1` |
| 测试仓库 | 本地 bare 远端 `origin.git` + 主工作树 `repo`（`main`）+ 真实 worktree `wt-feat`（`feat/wt-e2e`） |

---

## 2. 自动测试基线（L1）

- `npm test`：**808 tests: 801 passed, 0 failed, 7 skipped**
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：**457 passed, 0 failed**
- `npm --workspace @trellis-board/web run build`：**PASS**（`tsc -b && vite build`）
- `npm --workspace @trellis-board/web run lint`：**PASS**（0 errors）

---

## 3. 实机验收结果与双证据链（L2 + L3）

| 验收项 | 结论 | 实机证据（UI / CDP / 本地状态） | 实机证据（服务端 API / SQLite） |
| --- | --- | --- | --- |
| **AC1（新建 worktree 自动接入打标）** | **PASS** | 真实 `git worktree add wt-feat -b feat/wt-e2e` 并新建任务后，客户端 `refresh_worktree_discovery` 返回 `status="attached"`, `autoManaged=true`, `visibility="visible"`, `activeTaskCount=1`；本地 `clients\c1\agent\config.json` 持久化 `wtIsWorktree=true` | `sync_task_space` 表中 `feat/wt-e2e`（`e79064ed-258d-45cc-9860-a907f1a0238f`）写入 `is_worktree=1, status='active'` |
| **AC2（普通主仓库与基线分支不受影响）** | **PASS** | 客户端通过 `inspect_local_project` + `associate_pending_project` 关联主仓库 `repo`（`main`），本地 `config.json` 中 `mainIsWorktree=false` | `sync_task_space` 表中 `main`（`2019e5d8-364c-4dfd-af8d-ab4967caa848`）写入 `is_worktree=0, status='active'` |
| **AC3（归档同步跳过 worktree）** | **PASS** | 管理端归档同步页无 `ARCHIVE_BRANCH_MISSING` 报错，worktree 状态呈现免同步态 | `POST /weint-spec-board/api/admin/archive-sync/run` 指定 worktree 空间返回 `HTTP 409`，`code="WORKTREE_ARCHIVE_SYNC_SKIPPED"` |
| **AC4（控制面收敛与“等待归档同步”解除）** | **PASS** | 真实任务 `e2e-conv2` 经客户端上传落库后，删除本地活动目录；客户端 `refresh_worktree_discovery` 收敛为 `activeTaskCount=0`, `serverActiveTaskCount=0`, `archiveSyncPending=false`, `visibility="hidden_empty"` | SQLite `sync_task` 中 `e2e-conv2` 由删除前的 `{"archived":0,"materialization_state":"materialized"}` 自动收敛为 `{"archived":1,"materialization_state":"materialized"}` |
| **AC5（待物化任务保护）** | **PASS（L1 覆盖）** | 未在实机单独注入人工 `pending` 态；已在 L1 自动测试 `worktree-branch-sync-lifecycle.test.js` 严格覆盖 | L1 单测断言 `materialization_state='pending'` 在 worktree 索引收敛后保持 `archived=0` |
| **AC6（存量 worktree 自愈）** | **PASS（L1 覆盖）** | 未在实机构造旧版 `config.json`；Rust `mark_binding_worktree` 与服务端 `attach` 补标路径已通过 Rust 编译/单测及服务端单测覆盖 | L1 单测验证 `is_worktree: 0 -> 1` 补标清除 `sync_archive_sync_state.last_error` 并触发 `onTaskSpaceWorktreeMarked` |
| **AC7（管理端 `admin.html` 展示）** | **PASS** | 真实客户端 WebView2 导航至 `/weint-spec-board/admin.html` 并点击「归档同步」Tab，DOM 断言 `hasWorktreeBadge=true`（「Worktree · 免归档同步」）、`hasWorktreeHint=true`（「Worktree 分支一般不推送远端，归档随基线分支同步」）、`hasArchiveMissingError=false` | `GET /api/admin/archive-sync` 返回 `status='worktree_skipped', isWorktree=true, lastError=null` |
| **AC8（数据库 v18 → v19 迁移）** | **PASS** | 隔离空库启动即建 Schema v19，所有迁移/回滚/备份用例在 L1 `database.test.js` & `database-v10.test.js` 全绿 | 隔离实机库 `sync_task_space` 具备 `is_worktree` 列并正常读写 |
| **AC9（删除 worktree 自动弃用与同名重建恢复）** | **PASS** | 执行真实 `git worktree remove --force wt-feat` 后，客户端自动解绑；切回看板页 `/weint-spec-board/` 检查侧边栏 DOM：`hasWtBranch=false`、`hasUnassociatedText=false`（无“无客户端关联”红字）；随后执行 `git worktree add wt-feat feat/wt-e2e` 并新建任务 `11-27-e2e-reborn`，客户端自动重新接入 | 删除后 SQLite `sync_task_space` 自动更新为 `status='disabled', retired_at='2026-11-27T11:01:14.246Z', retired_reason='worktree_deleted'`；重建接入后同一空间 ID 自动恢复为 `status='active', retired_at=null, is_worktree=1` |

---

## 4. 环境清理结果

- 已停止隔离服务端（`4467`）、桌面登录页 dev server（`5199`）及真实客户端进程树（`trellis-board-client.exe`）。
- 已删除隔离目录 `C:\projects\_trellis-board-e2e\11-27-worktree-branch-sync-lifecycle\`（`Test-Path` 返回 `False`）。
- 已确认端口 `4467`、`5199`、`9367` 均无残留监听（`REMAINING_LISTEN_PORTS: 0`）。
- 未触碰生产端口 `4317`。
