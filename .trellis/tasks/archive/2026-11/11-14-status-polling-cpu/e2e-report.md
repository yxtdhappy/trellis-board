# E2E 报告：状态刷新与空闲 CPU

## 结论

基于 `main@0bb105f`、GitHub Release `v0.4.15` 的 Windows 生产客户端通过真实 Team 服务验证：

- Board 稳定 60 秒平均 `2.16%` 单核，归档页稳定 60 秒平均 `3.31%` 单核，均低于本轮确认的
  `<5%` 验收线。
- Board 和归档页稳定采样期间均为 `0` 个 `git.exe` 子进程。
- `list_local_associations` 与 `/api/team/status` 已不再按原 3 秒周期读取；39.1 秒运行期探针只记录
  `5` 次本地关联 IPC 和 `4` 次 Team 状态请求，4 次 Team 状态均为 `304`。
- Board、团队、归档、插件页面均真实打开；5 个正式关联显示 `同步正常`，归档页显示 `1/36`、共
  `701` 条。
- 临时分支切换后显示“分支不一致，已暂停同步”；切回 `main` 后 12 秒内恢复“同步正常”。

启动阶段仍有一次高 CPU/Git 扫描峰值，详见“已知限制”；该峰值不计入稳定态结论，也不应被描述为
已经完全消除。

## 环境与版本

- 时间：2026-11-14，Asia/Shanghai
- 客户端版本：`0.4.15`
- 客户端路径：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-v0415-e2e-20261114-153300\portable\TrellisBoard_0.4.15_x64-portable\trellis-board-client.exe`
- 客户端 EXE SHA256：
  `2c88f87e8879649c952338e2f804c2d2d3a671b8f00a35c95570cf9932a9d634`
- Release ZIP SHA256：
  `c1d1c0059d330ee5467dddbcc67be4050bad5d53fab15e4514e5eae240aa2948`
- GitHub Release：
  `https://github.com/yxtdhappy/trellis-board/releases/tag/v0.4.15`
- GitHub Actions：
  `https://github.com/yxtdhappy/trellis-board/actions/runs/43571122328`
- 服务端 PID `35308`，监听 `0.0.0.0:4317`
- 服务端数据库：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`
- 正式绑定：`mdp-backend-service`、`mdp-backend-web`、`mdp-report-service`、
  `mdp-management-web`、`trellis-board`

服务端进程在当前任务期间未重启；后续提交对 `apps/server/package.json` 只有版本号变化，没有影响
Team 状态或任务同步的服务端功能代码变化。本轮性能目标位于桌面 Rust/WebView 路径。

## 修复范围

| 提交 | 修复 |
| --- | --- |
| `1672fac` | 事件驱动高成本状态刷新 |
| `341d058` | 相同状态不重复发射事件 |
| `88d30b1` | 稳定 HEAD 不再重复执行 Git 扫描 |
| `4f89349` | 绑定生命周期更新不再持锁进入同步 |
| `0bb105f` | ownership 投影按 taskSpace 独立失效，避免其他仓库阻断当前缓存写入 |

`0bb105f` 新增 `ProjectionEpoch { global, local }`：绑定全集变化使用 global epoch，单个任务空间
watcher 失效只推进 local epoch。缓存回写同时校验两个 epoch 和 binding 身份，避免无关仓库变化
导致当前仓库缓存永远无法命中。

## CPU 对照

### v0.4.14 基线

| 场景 | 平均 | P95 | 峰值 | Git 子进程 |
| --- | ---: | ---: | ---: | ---: |
| Board 稳定 60 秒 | `1.98%` | `4.69%` | `10.94%` | 0 |
| 归档稳定 60 秒 | `4.30%` | `10.94%` | `12.50%` | 0 |

基线截图：[Board](./e2e-v0.4.14-board.png)、[归档](./e2e-v0.4.14-archive-prod.png)。

### v0.4.15 最终生产采样

最终结果使用扩大到 `1700 x 980` 的真实窗口，避免小窗口数据偏乐观：

| 场景 | 平均 | P95 | 峰值 | Git 子进程 | CPU 时间 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Board 稳定 60 秒 | `2.16%` | `6.25%` | `7.81%` | 0 | `1.30 s` |
| 归档稳定 60 秒 | `3.31%` | `7.81%` | `10.94%` | 0 | `1.98 s` |

归档首次进入后立即采样得到 `3.75%`，随后稳定窗口为 `3.31%`；首次采样包含页面切换和一次短时
Git 门禁，不作为最终值。Board 与归档均低于用户确认的 `<5%` 验收线。

## 调用频率

在相同 v0.4.15 包上临时启用 WebView2 调试口，注入只读 fetch 计数；完成频率采集后关闭调试客户端，
重新启动生产客户端：

```text
采集时长：39.1 s
页面可见性：visible
http://ipc.localhost/list_local_associations：5 次
/api/team/status：4 次
/api/team/status -> 304：4 次
```

结果符合“事件触发 + 10 秒可见兜底”，没有恢复为 3 秒固定轮询。稳定态 `git.exe = 0` 表示 HEAD/ref
指纹未变化，ownership 投影直接复用缓存；文件监听覆盖 `.git/HEAD`、`index`、`refs`、`packed-refs`，
指纹变化后仍进入精确 Git 校验，分支门禁和任务同步没有被关闭。

## UI 验收

| 页面/操作 | 结果 | 证据 |
| --- | --- | --- |
| Board | 4 个进行中任务，5 个仓库筛选正常 | [e2e-v0.4.15-board-prod.png](./e2e-v0.4.15-board-prod.png) |
| 团队视角 | 显示 `1-4 / 共 4 条`，负责人统计和项目筛选可见 | [e2e-v0.4.15-team-prod.png](./e2e-v0.4.15-team-prod.png) |
| 归档索引 | 显示 `1-20 / 共 701 条`、`1/36` 页 | [e2e-v0.4.15-archive-prod.png](./e2e-v0.4.15-archive-prod.png) |
| 插件 | Team 模式按预期显示插件机制关闭、`0` 个插件 | [e2e-v0.4.15-plugins-prod.png](./e2e-v0.4.15-plugins-prod.png) |
| 分支门禁 | 临时分支显示“分支不一致，已暂停同步” | [e2e-v0.4.15-branch-paused-prod.png](./e2e-v0.4.15-branch-paused-prod.png) |

截图使用 Win32 `PrintWindow` 从真实 WebView2 读取，不是静态页面或模拟 DOM。

## 分支门禁

1. `main` 下 5 个关联均显示“已关联 · 同步正常”。
2. 创建并切到 `codex/e2e-branch-event-check`，2 秒内 `trellis-board` 显示：
   `分支不一致，已暂停同步，本地当前分支为 codex/e2e-branch-event-check，绑定分支为 main`。
3. 切回 `main` 后 12 秒内恢复“同步正常”。
4. 临时测试分支已删除，当前分支恢复为 `main`。

## 自动化与发布

GitHub Actions run `43571122328`：

- conclusion：`success`
- head：`0bb105f6c4438ebbfccb4980444bdc30577101c9`
- Node/Web 测试：通过
- Rust 单测：通过
- Windows bundle：通过
- portable smoke / launch smoke：通过
- Release 上传：通过

`v0.4.15` Release 已公开，ZIP 和 `.sha256` 两个资产均存在，本地下载包的包内校验文件与 Release
digest 一致。

## 已知限制

- 启动前约 4 分钟仍存在一次高 CPU 和短生命周期 Git 扫描峰值；v0.4.15 启动 30 秒平均约
  `169.69%`、峰值 `306.25%`、23 个 Git 子进程。稳定后降为 `<5%` 且 Git 为 0。该启动扫描性能应
  作为独立后续问题处理。
- 控制窗口的“队列变化立即刷新、隐藏时停止 750 ms 读取”由代码路径和 CI 覆盖；本轮没有人为制造
  真实冲突事件来强制弹出控制窗口，以免写入用户数据。空闲运行期间控制页未创建独立调试目标，
  说明隐藏窗口没有持续加载并轮询。
- 本轮没有新增 E2E 探针任务或业务数据，不需要数据库清理。

## 清理结果

- `codex/e2e-branch-event-check`、`codex/e2e-branch-recovery-check` 均已删除。
- 调试客户端已停止，生产 `v0.4.15` 客户端已重新启动，PID `36236`。
- 仓库当前分支：`main`。
- 5 个正式关联保持 approved/ready，任务同步无新增测试数据。
