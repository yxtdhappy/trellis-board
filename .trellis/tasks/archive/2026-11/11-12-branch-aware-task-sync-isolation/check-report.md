# 同一仓库跨分支任务串写修复检查报告

## 结论

代码级质量门禁通过。尚未重启 4317，因此真实 Tauri/WebView2 与安装包验收未执行；存量清理只做了
dry-run，未写真实数据库。

## 实现检查

- 同一 Agent 同一 `localRepoKey` 只允许一个 approved binding；历史双绑定可读取，但新写入不能增加
  第二个有效 binding。
- 运行时按真实 Git 分支只启用一个 watcher；无法唯一匹配时暂停整个仓库同步。
- 上传、拉取、首次同步、watcher、pending retry、延后补同步、冲突覆盖和本地目录写入前均执行分支门禁。
- 上传携带 `observedBranchName`；HTTP 缺失时返回 `400 BRANCH_OBSERVATION_REQUIRED`，服务层校验
  taskSpace/binding 分支一致。
- 分支异常状态不会被 heartbeat 或普通仓库同步覆盖；切回绑定分支后恢复为 `syncing` 或 `ready`。
- 接入向导展示同仓库旧/新分支并要求再次确认；服务端 attach 事务撤销当前 Agent 的旧 binding，
  保留旧 taskSpace、任务数据和其他设备 binding。
- 清理脚本默认 dry-run，支持数据库备份、tombstone、audit、revision 和索引待重建。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 聚焦 Agent/Team/Git 测试 | 54/54 通过 |
| 单独分支门禁真实 Git 测试 | 1/1 通过 |
| `node --test agent/test/*.test.js` | 77/77 通过 |
| `npm test` | 491 个，487 通过，4 个平台跳过，0 失败 |
| 插件测试串行全量 | 46 个，38 通过，8 个环境跳过，0 失败 |
| 插件默认并行模式 | Windows 临时目录清理偶发 `EPERM`；失败断言单独重跑均通过 |
| `npm --prefix web run build` | TypeScript 与 Vite 构建通过 |
| oxfmt 指定文件检查 | 全部通过 |
| 真实库清理 dry-run | 6 个重复任务、33 个待墓碑文件、0 unresolved；未执行 apply |

## 真实库 dry-run

详见 `cleanup-dry-run.md`。其中 `11-12-rust-desktop-agent-single-exe` 的 6 个文件在旧分支和
`main` 上内容不同，不能直接清理。当前任务自身也已被尚未重启的旧双写进程同步到两个空间。

## 未执行

- 未停止或重启 4317 服务；当前仍是 PID `41152`、启动时间 `2026-11-12T06:05:32.491Z` 的旧加载代码。
- 未做真实桌面登录、重新关联、分支切换、sidecar watcher 停止和恢复 E2E。
- 未执行真实库 `--apply`，未写 tombstone、audit、revision 或索引。
- 未提交、推送、归档或修改历史。
