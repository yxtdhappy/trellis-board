# 桌面冷启动持久缓存 E2E 报告

## 环境与版本

- 客户端：`TrellisBoard 0.4.17` 正式 Release 便携包。
- 构建：GitHub Actions run `43679964123`，Node、Rust、Tauri 打包和 Release 发布均成功。
- 服务端：`http://192.168.65.27:4317`。
- 本地绑定：5 个 approved binding，共约 706 个任务目录。
- 客户端日志：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs\desktop.log`。
- 持久索引：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\agent\ownership-index.json`。

## 首次启动（索引缺失）

- 时间：2026-11-15 13:18:45。
- ProjectRail：5 秒截图时 5 个项目已显示，但关联状态仍在校验；30 秒截图时 5 个关联为“已关联、同步正常”。
- CPU：5–30 秒进程树平均 `115.69%` 单核，峰值 `226.57%`。
- 索引：生成 `ownership-index.json`，大小 `364787` 字节。
- ownership：首轮 5 个仓库共解析 `706` 个 `task.json`，均记录 `gitCalls=4`。
- 约 `278s` 后 5 个仓库完成启动同步并进入稳定态，稳定后抽样 CPU 约 `0.94%`。

## 正常重启（索引命中）

- 时间：2026-11-15 13:24:28。
- ProjectRail：5 秒和 30 秒截图均显示 5 个“已关联、同步正常”，满足 5 秒内恢复。
- CPU：5–30 秒进程树平均 `85.81%` 单核，峰值 `144.73%`，未满足 `<5%`。
- ownership：命中持久索引，日志为 `taskJsonParsed=0`、`headCacheHit=true`、`gitCalls=0`。
- 结论：ownership 缓存目标已达成，但启动 pull 仍对全部任务文件做正文读取和 SHA256，是剩余 CPU 主因。

## 当前判定

- “5 秒内 ProjectRail 可用”：通过。
- “正常重启不重新解析未变化 task.json”：通过。
- “ownership 路径不执行 Git”：通过。
- “5–30 秒平均 CPU <5%”：失败。

## 后续

按 design 的正向归因条件，扩展为本地快照文件元数据缓存：持久化每个任务文件的路径、size/mtime 和 SHA256，
正常重启 pull 仅枚举元数据；未变化文件复用摘要，只有新增或元数据变化的文件才读取内容和重新哈希。
上传、CAS、冲突覆盖和服务端写入仍使用真实文件内容与精确摘要。
