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

## 远端历史清理

- 原远端分支：`39e67e71ddb4d23d8e03c003c61a2af4c4a21dda`。
- 功能提交后的本地分支：`fb92e3e6c8da6acba159d8102db9ded2e6d7b979`。
- 独立 mirror 重写后的分支：`054d19a7d203cc80a8961c6b25165a3a8f0a1c58`。
- 重写前后根树均为 `a0f20e75f713a37d823dc4fe6cd9d2892a83971b`，确认当前内容未变化。
- 使用 `--force-with-lease=refs/heads/codex/team-board:39e67e71ddb4d23d8e03c003c61a2af4c4a21dda` 完成一次受控强推。
- 全新克隆 `origin/codex/team-board` 指向 `054d19a7d203cc80a8961c6b25165a3a8f0a1c58`。
- 全新克隆执行 `git log --all --name-only --pretty=format:` 后匹配 `^data/` 的数量为 0。
- 全新克隆执行 `git ls-tree -r origin/codex/team-board -- data` 的输出数量为 0。

历史审计确认移除的路径：

- `data/.gitignore`
- `data/repos.example.json`
- `data/plugins.example.json`
- `data/plugins.secrets.example.json`
- `data/standalone-backup-20261108-142014/board.sqlite`

误提交的 SQLite 备份由 `ef7eb4f39357f599834d93b6c6ceb62fcf2f73ac` 引入，大小 5,271,552 字节。此前的只读检查确认库内没有用户、团队、项目或凭据记录，但包含 5 条本地仓库路径。

## 备份

- 目录：`D:\wit\trellis-board-history-backups\20261109-225313-team-runtime-data-sparse-onboarding`
- `all-refs.bundle`：SHA-256 `213DB1770736A65F90F8321C8E2DE91969213F12F22D8AAEC812757321103C52`
- `working-tree.patch`：SHA-256 `1042534503F0437E4C26B78705F1C57C391157CFD07CABBE9B27BF017F646073`
- `unrelated-untracked.zip`：SHA-256 `1E55547EF6589224894CA82B7673A7CD35021EEF23692D51F90B55C55D1C03B1`
- `repo.git` 为完整 mirror；`verify-clone` 为全新验证克隆。

## 限制

- IntelliJ 已保存的旧 VCS 映射属于用户 IDE 配置。当前产品代码不再在源码 `data/projects` 创建新仓库，但已有映射需要手动移除。
- GitHub 可能对失联对象、缓存、PR 引用和其他内部副本延迟回收。本次可以确认远端可达分支历史不再包含 `data/`，不能承诺 GitHub 存储介质立即物理擦除。
