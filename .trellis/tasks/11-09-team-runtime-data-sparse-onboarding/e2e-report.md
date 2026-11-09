# 团队运行数据外移与 .trellis 稀疏项目接入 E2E 报告

## 已执行证据

### 真实团队 HTTP + Git 链路

`tests/team-release.test.js` 使用临时 SQLite、临时 Git 远端和监听回环端口的真实团队运行时，完成：

- 创建系统管理员、团队和成员；
- 通过 `POST /api/admin/projects` 接入真实 Git 项目并保存 Agent 工具与 bootstrap 负责人；
- 验证批准负责人不一致时返回 409；
- 使用正确 bootstrap 信息批准项目；
- 创建 Trellis 任务、推送共享分支并读取远端任务文件；
- 完成任务接受和 Agent 快进同步。

结果：通过。

### 稀疏检出与自动初始化

`tests/team-sparse-onboarding.test.js` 使用临时裸仓库验证：

- 远端已有 `.trellis/` 时，工作副本除 `.git` 外只有 `.trellis`；
- 远端缺少 `.trellis/` 时，固定版本真实 Trellis CLI 可以初始化、提交、推送并在成功后收敛为只包含 `.trellis` 的工作副本；
- 初始化期间远端分叉时执行一次 fetch + rebase 重试；
- 初始化产生越界文件、推送失败或覆盖远端已有文件时拒绝接入并清理工作副本；
- 旧的干净完整克隆可以自动收敛为 `.trellis` 稀疏工作副本。

结果：通过。

### 运行数据迁移

`tests/data-migration.test.js` 覆盖：

- Windows、macOS、Linux 默认路径和 `TRELLIS_BOARD_DATA_DIR` 覆盖；
- 只迁移运行数据，不迁移示例和未知文件；
- staging 成功后替换目标目录；
- 数据库项目路径与工作副本路径同步重写；
- 目标冲突、项目目录缺失和失败路径保留旧数据；
- 仅含布局标记的目标目录后续仍可迁移运行数据。

结果：7/7 通过。

## 尚未执行

- 未修改正在运行的旧 4317 服务，未迁移真实 `data/`。
- 未自动修改 `.idea/vcs.xml`。
- 远端历史清理和全新克隆审计在功能提交后执行，结果应追加在本报告。

## 限制

- IntelliJ 已保存的旧 VCS 映射属于用户 IDE 配置。当前产品代码不再在源码 `data/projects` 创建新仓库，但已有映射需要手动移除。
