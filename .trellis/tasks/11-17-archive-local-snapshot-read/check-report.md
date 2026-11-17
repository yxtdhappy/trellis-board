# 归档附件本地快照与只读访问检查报告

## 结论

代码质量门禁通过。任务相关迁移、归档同步、候选快照激活、fileId 历史映射、本地文件读取、
下载权限与前端入口均有自动化覆盖，最终全量测试、插件测试、Lint、类型检查和构建通过。

## 验证结果

- `yarn test`：609 项，608 通过，1 项既有跳过，0 失败。
- `yarn test:plugins`：107 项，106 通过，1 项既有跳过，0 失败。
- `yarn workspace @trellis-board/web lint`：通过；仅既有 React Hook/规则警告。
- `yarn workspace @trellis-board/web exec tsc -b --pretty false`：通过。
- `yarn build`：通过；仅有既有的大 chunk 警告。
- 任务相关文件定向 `oxfmt --check`：通过。
- `git diff --check`：通过。

## 关键回归

- v14 -> v15 幂等迁移、外键、单 TaskSpace 单 active 快照约束、失败回滚和 legacy 可读。
- active/candidate 快照指针、不可变 fileId 历史映射和索引事务内原子激活。
- 索引事务故障注入后 Board cache、revision、active/candidate 指针和快照状态全部回滚。
- 16 MiB 单文件限制、32 MiB 批次内存边界和合法的 36 MiB 多文件归档。
- 当前/历史 fileId 下载、无权限空间 403、可访问空间伪造/跨空间 404、401、缺失文件 503。
- `Content-Type`、`Content-Length`、`Content-Disposition`、`Cache-Control` 和 `nosniff`。
- 数据库备份引用保护、staging 并发保护、manifest/storage key 越界校验和清理失败关闭。

## 范围说明

- Team 当前没有项目物理删除入口，本任务覆盖 TaskSpace 物理删除、备份引用保留和备份轮换后清理。
- Vite 主包和 Monaco chunk 大小警告与本任务无关，未扩大范围优化。
