# E2E 报告：deferred 已一致状态收敛

## 结论

基于 `main@488afa2`、GitHub Release `v0.4.9` 的 Windows 客户端通过真实服务和真实仓库验收：

- 启动时已与服务端完全一致的四组 deferred 全部自动收敛为 0。
- ProjectRail 中五条关联均显示“已关联 · 同步正常”，不再出现“本地任务未同步”。
- 正常运行中的收敛没有生成上传批次，服务端 taskSpace revision 未因收敛推进。
- 服务端不存在的真实差异探针保持 deferred，未自动上传。

## 环境与版本

- 时间：2026-11-14，Asia/Shanghai
- GitHub build：run `43551983002`，成功
- Git commit：`488afa24c519346cee2e3cae6b1cfe8b693452e`
- 客户端版本：`0.4.9`
- Release：
  `https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.9`
- Release zip：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-v049-e2e-20261114-113805\TrellisBoard_0.4.9_x64-portable.zip`
- Zip SHA256：
  `9ede8183fc8a75e4ca63937db2ec66d761182aeb32765844f6bb3e9e0c977803`
- 客户端进程：PID `21548`
- 客户端路径：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-v049-e2e-20261114-113805\portable\TrellisBoard_0.4.9_x64-portable\trellis-board-client.exe`
- 服务端：`http://192.168.65.27:4317`
- 光标文件：`%LOCALAPPDATA%\TrellisBoard\data\agent\live-cursors.json`
- 服务端数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`

## 启动收敛

启动前 cursor 中的 deferred：

| 关联 | deferred |
| --- | ---: |
| `trellis-board` | 64 |
| `mdp-backend-service` | 8 |
| `mdp-report-service` | 10 |
| `mdp-management-web` | 6 |
| `mdp-backend-web` | 0 |

`trellis-board` 本次实测为 64，不是问题截图中的 65；这是验收前本地任务状态已经变化后的实际值。

客户端启动后依次收敛：

- `mdp-report-service`：10 → 0。
- `mdp-backend-service`：8 → 0。
- `mdp-management-web`：6 → 0。
- `trellis-board`：64 → 0。

最终 cursor：

| 关联 | revision | deferred | pending |
| --- | ---: | ---: | --- |
| `mdp-backend-service` | 140 | 0 | 否 |
| `mdp-backend-web` | 102 | 0 | 否 |
| `mdp-report-service` | 39 | 0 | 否 |
| `mdp-management-web` | 325 | 0 | 否 |
| `trellis-board` | 361 | 0 | 否 |

在探针构造之前，五个 taskSpace 的 revision 分别保持 `140/102/39/325/359`。服务端 batch 表在
03:39 启动收敛窗口内没有新增记录，下一批次到 03:41 才因测试探针构造产生。

## UI 验收

真实 Windows 客户端截图见 [e2e-sync-normal.png](./e2e-sync-normal.png)。窗口内五条关联均显示：

- `mdp-backend-service：已关联 · 同步正常`
- `mdp-backend-web：已关联 · 同步正常`
- `mdp-management-web：已关联 · 同步正常`
- `mdp-report-service：已关联 · 同步正常`
- `trellis-board：已关联 · 同步正常`

验收时系统处于锁屏，使用 Win32 `PrintWindow` 读取真实 WebView 窗口内容；不是静态截图或模拟页面。

## 差异探针

### 无效尝试

第一次探针在客户端仍运行时创建，watcher 按正常同步路径把新文件上传为 revision `360`。该结果不用于
验证 deferred 保护逻辑。随后通过正常删除路径生成 revision `361` 墓碑，服务端只保留
`deleted=1` 的审计记录。

### 有效探针

1. 停止客户端。
2. 创建本地任务 `.trellis/tasks/11-14-e2e-deferred-probe-v049-b/task.json`。
3. 把该任务以完整本地 SHA256 写入 cursor 的 deferred，但服务端不存在该任务。
4. 启动 `v0.4.9` 客户端并等待启动同步完成。
5. 结果：
   - cursor deferred 保持 1。
   - 服务端 `sync_task_space_file` 中没有该任务。
   - `sync_task_space_batch` 数量保持 `359`，revision 保持 `361`。
   - `pending=false`。

说明真实服务端缺失的 deferred 不会被自动上传或收敛。

## 资源采样

客户端稳定后，对进程树
`21548,56308,41532,63904,67004,48784,30008` 做 30 秒 CPU 采样：

- CPU 时间增量：`2.0 s`
- 单核平均：`6.67%`
- 根进程工作集：约 `125 MB`

与修复前约 `6%` 的单核基线一致，没有因 deferred 收敛新增周期扫描或 CPU 尖峰。

## 清理结果

- 两个探针目录均已删除。
- 有效探针未进入服务端。
- 无效探针在服务端保留 `deleted=1` 墓碑，这是正常同步审计语义。
- 最终 `trellis-board` revision `361`，deferred `0`，pending `false`。
- merge evidence 数量保持 `65`，未因有效 deferred 探针新增。

## 已知限制

- 手动构造 deferred 时触发过一次历史合入任务的本地 pending baseline evidence 候选，尚未发送到
  服务端即被清理。该路径不来自常规 deferred 收敛，但说明“手工改 cursor”不是受支持的生产操作。
- GitHub Release 的 `v0.4.8` 构建失败，最终验收只使用成功的 `v0.4.9`。
