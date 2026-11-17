# 归档附件本地快照与只读访问 E2E 报告

## 环境

- 使用现网 v14 数据库的一致性副本和现有只读归档凭据，在系统临时目录启动隔离 Team 实例。
- 隔离实例启动时完成 v14 -> v15 迁移，端口 `4318`；现网 `4317` 实例和数据未修改。
- 五个 TaskSpace 均为真实项目分支。

## 五分支同步

| 项目 | 分支 | 文件数 | 字节数 | 尝试到索引完成 |
| --- | --- | ---: | ---: | ---: |
| mdp-backend-service | dev | 1,747 | 17,777,390 | 80.321 s |
| mdp-backend-web | dev | 669 | 5,636,676 | 60.191 s |
| mdp-management-web | release/3.0.0/dev | 1,613 | 3,711,252 | 38.692 s |
| mdp-report-service | release/3.0.0/dev | 316 | 2,431,624 | 18.932 s |
| trellis-board | main | 828 | 7,161,211 | 25.353 s |
| 合计 |  | 5,173 | 36,718,153 | 135.279 s |

五个 TaskSpace 最终均为 `current`，`archive_revision = archive_indexed_revision`，candidate 指针为空，
每个 TaskSpace 恰有一个 active 快照。

## Git tree 与本地快照一致性

重新读取五个本地 bare cache 的 Git tree，逐文件比对路径、blob OID 和字节数，并读取全部本地快照文件
重新计算 SHA-256：

- 五个分支的 Git blob 数、SQLite 文件行数和本地文件数完全一致。
- 路径、blob OID、大小和 SHA-256 不一致数均为 0。
- 本地快照文件实际总字节数与 SQLite `size_bytes` 和 Git tree 大小一致。

## 重启、禁用 Git 与读取

完成同步后停止实例，临时移除归档凭据密钥，禁用归档同步，将 `PATH` 限制为不包含 Git 的目录后重启。

- 服务成功启动，归档任务列表、归档详情和本地附件读取正常。
- 服务进程树 `GitChildCount=0`，远端已建立连接数 `0`，凭据密钥不存在。
- PNG 下载：HTTP 200，101,719 字节，SHA-256 一致。
- XLSX 下载：HTTP 200，3,622 字节，SHA-256 一致。
- PowerShell 脚本下载：HTTP 200，4,788 字节，SHA-256 一致。
- 三个响应均包含固定长度、下载文件名、`nosniff` 和 `private, no-store`。
- 真实页面归档详情显示本地快照文件列表；点击 PNG 下载产生
  `/api/archive-files/:fileId?taskSpaceId=...` 请求并返回 200。

## 同步失败恢复

在隔离副本中把 `mdp-report-service` 的分支临时改为不存在的分支，再启用同步：

- 状态进入 `error`，错误为 `ARCHIVE_BRANCH_MISSING`。
- active 快照 ID、`archive_revision` 和 `archive_indexed_revision` 均保持不变。
- 旧 Board 详情继续返回 200，旧 fileId 仍在附件列表中。
- 旧文件下载返回 200，SHA-256 与失败前一致。
- 页面重载后仍显示原归档附件并可下载。

## TaskSpace 生命周期与清理

在同一隔离副本中验证：

1. 弃用 TaskSpace：状态变为 disabled，快照目录仍保留。
2. 恢复 TaskSpace：状态恢复 active，详情和旧附件下载继续成功。
3. 物理删除 TaskSpace：删除接口成功，数据库任务空间行数变为 0。
4. 严格备份引用了已删除 TaskSpace 的快照，因此快照目录暂时保留。
5. 模拟备份轮换删除该备份并重启实例后，快照目录被清理，重启后不存在孤立目录。

## 结论

PRD 中的五个真实 TaskSpace 同步、读取阶段零 Git/远端、服务重启、下载类型、失败保留和
TaskSpace 生命周期验收均完成。隔离验证后已清理临时数据副本。
