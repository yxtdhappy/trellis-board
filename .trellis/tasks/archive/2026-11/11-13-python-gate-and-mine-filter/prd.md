# 客户端 Python 环境门禁与只看我的过滤修复

## Goal

首次启动环境门新增 Python >=3.9 检查与自动安装；任务流水线「只看我的」按每个项目当前配置的 trellis developer id 过滤（修复索引期冻结 assignee_user_id 导致的过滤失效）

## 背景与现状

1. **Python 缺失只在任务阶段暴露**：客户端进程本身（Rust/前端）与服务端（Node）都不依赖 Python；需要 Python 的是客户端要执行的 Trellis 流程脚本（`.trellis/scripts/task.py`、`get_context.py`、`add_session.py` 等，仅标准库）。桌面端首次启动环境门（`apps/desktop/src-tauri/src/agent/env.rs`）只检查 Node.js 与 Trellis CLI；Python 只在真正执行 `.trellis/scripts/task.py` 时才探测（`apps/desktop/src-tauri/src/agent/task_command.rs:728-731`：`python` → `py -3` 回退），失败时报「客户端找不到 Python 运行环境，无法执行项目 task.py」。为避免用户跑到任务流水线才失败，把 Python 纳入首次启动环境门。
2. **「只看我的」过滤失效**：服务端 mine 过滤使用索引期预计算的 `assignee_user_id`（`apps/server/team/task-space-index.js:787-790`、`apps/server/team/task-index.js:773-776`：`t.assignee_user_id = ?`）。该列在索引写入时由当时 `sync_project_member` / `project_member` 的 `trellis_dev_id` 映射（`task-space-index.js:497-505`、`task-index.js:473-484`），而成员 dev id 变更（`PUT /api/projects/:id/members` → `upsertMember`，`apps/server/team/task-space-service.js:1071-1104`）不重建索引。已复现：把成员 dev id 改成 `other-dev` 后，mine 仍返回旧 dev id 的任务、漏掉新 dev id 的任务。

## Requirements

### R1 首次启动环境门加入 Python 检查

- 环境检查结果新增 Python 项（版本、路径、来源、最低版本 3.9.0），与 Node.js / Trellis CLI 并列呈现。
- 检测顺序（与客户端执行 task.py 的候选一致，先客户端已装便携解释器）：`client.json` 的 `python_runtime` 标志 → 环境变量 `TRELLIS_PYTHON` → `python` → `py -3`。探测到后写回标志，标志指向的文件被删时自愈重探。
- 版本必须 >= 3.9（Trellis 脚本要求）；版本输出形如 `Python 3.12.8`，缺少 patch 段按 `.0` 补齐。

### R2 缺失时自动安装（对齐 Node.js 缺失时的行为）

- 环境门不通过时「安装运行环境」按钮同时负责下载并**静默安装** Python：
  - 下载官方安装包 `https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe`（27,043,760 字节，sha256 `71bd44e6b0e91c17558963557e4cdb80b483de9b0a0a9717f06cf896f95ab598`）到 `<dataDir>/downloads/`，校验哈希后执行。
  - 静默参数：`/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=0 Include_test=0 Include_doc=0 Shortcuts=0`。已实测：耗时 76.5 s、退出码 0、**无 UAC 提权**（per-user 安装，卸载项落在 HKCU）、安装后 `python.exe .trellis/scripts/task.py --help` 退出码 0；卸载（`/uninstall /quiet`）后目录与注册项均清理干净、用户 PATH 无残留。
  - 机器上已有 <3.9 的 Python 时不卸载、侧装 3.12.8；客户端记录实际解释器路径，运行时以该路径优先。
  - 安装器退出码 0 或 3010（需重启）视为成功；其他退出码报明确中文错误，并附官方下载链接供手动安装。
  - 安装完成后重新探测，仍无可用的 >=3.9 解释器则报 `PYTHON_INVALID`。
- 不使用 embeddable zip + 手工解压方案（该方案必须删除 `python312._pth` 才能让 `from common.log import ...` 生效，属非标准 CPython 语义，已废弃）。
- 安装进度纳入现有 `runtime-progress` 事件与检查页步骤列表（阶段 `python:download` / `python:verify` / `python:install` / `python:validate`）。

### R3 运行时统一使用已安装解释器

- 客户端执行 `task.py`（`run_task_python`）时优先使用 `client.json` 记录的便携解释器（`<dataDir>/runtime/python/python.exe`），避免 PATH 上无关的 `python` 抢先。

### R4 「只看我的」按项目当前配置的 trellis developer id 过滤

- mine 过滤改为查询时按任务所属项目**当前**配置的 developer id 判定：查 `sync_project_member` 拿当前登录用户在该项目的 `trellis_dev_id`，与任务索引的 `assignee_dev_id` 做 NOCASE 匹配。（git 路径的 `project_member` 对应逻辑只存在于已不接线的 legacy `task-index.js`，随 R5 一并删除，不重复实现。）
- 不再依赖 `assignee_user_id` 做 mine 判定；成员 dev id 变更后立即生效，无需重建索引。
- 成员未配置 developer id（如 `read_only`）时不产出任何 mine 结果。
- `assignee` 过滤等其他维度行为不变。

### R5 删除已不接线的 legacy git 索引模块

- 删除 `apps/server/team/task-index.js` 与其唯一使用方 `apps/server/test/task-index-args.test.js`（测试对象是 `team_task_index` 表上的 `taskIndexInsertArgs`/`taskIndexSearchText`；生产路径 `http.js` 已不引用该模块，`apps/server/test/team-static.test.js:23-26` 断言了这一事实）。
- 保留 `team_task_index` / `team_task_index_tag` 表结构（`apps/server/database.test.js:107-124` 的 schema 迁移断言仍依赖它们）。
- 独立提交，不与该缺陷修复混在同一 commit。

## 待确认的 4 项细化（D1–D4）

| 编号 | 问题 | 建议 |
|---|---|---|
| D1 | 机器已有 Python 但最终版本 < 3.9（如 3.8）时如何处置 | **已定**：不卸载旧版，静默侧装 3.12.8；客户端记录实际解释器路径，运行时以该路径优先 |
| D2 | 解释器优先级顺序 | `client.json` 的 `python_runtime` → `TRELLIS_PYTHON` → `python` → `py -3`（与现有 `run_task_python` 候选一致，仅前插已记录的安装路径）；候选版本 < 3.9 时不中止，继续下一个候选，并把最低版本记入 `found_version` 用于报错文案 |
| D3 | `python --version` 卡住（Microsoft Store 占位 stub 等） | 单次探测 **30 秒**超时（5 秒偏短，用户反馈）；超时即判该候选不可用并继续下一个候选 |
| D4 | 安装成功后前端动作 | **已定**：改为重新调用 `runtime_status`，仅当 `state === 'ready'` 才进登录页（现状是无条件 `showLogin()`） |

## Non-goals

- 不改客户端本地（非团队）模式 `filterTasks` 的 developer 比较语义。
- 不引入 pip / 第三方库支持；便携 Python 仅保证 Trellis 标准库脚本可运行。
- 不改 Trellis CLI 自身的 python 探测逻辑，也不改服务端 `apps/server/python.js`。

## Acceptance Criteria

- [ ] 全新机器（无 Node/Python/Trellis）：首次启动显示检查页含「检查 Python」项；点「安装运行环境」后自动下载安装 Node.js + Trellis CLI + Python，完成后进入登录页。
- [ ] 机器已有 Python >= 3.9（PATH 上的 `python` 或 `py -3`）：环境门直接通过，不触发 Python 下载，`client.json` 写入 `python_runtime`（source 表明来源）。
- [ ] 机器只有 Python < 3.9 或仅有 Microsoft Store 占位 `python`：判定为缺失，走自动安装；安装后解释器版本 >= 3.9。
- [ ] 安装后客户端执行任务命令（`task.py` 子命令）成功，不再出现「客户端找不到 Python 运行环境」。
- [ ] 把项目成员的 trellis developer id 从 A 改为 B 后，`scope=mine` 立即只返回 dev id 为 B 的任务（复现场景转绿）。
- [ ] mine 匹配大小写不敏感：成员 dev id 为 `Alice`、任务 assignee 为 `alice` 时仍命中。
- [ ] gitless（sync）与 git（team）两条索引路径行为一致。
- [ ] 回归测试：服务端 mine 过滤测试（成员变更 + 大小写）；Rust 侧 Python 版本解析/状态结构单测；既有测试全绿。
- [ ] 文档同步：`apps/desktop/README.md` 环境门与验收表更新为三项运行时。

## Notes

- 复现/回归测试的骨架见 `research/mine-scope-repro.test.js`（由临时复现脚本转入）。
- 便携 Python 下载源与哈希：`https://registry.npmmirror.com/-/binary/python/3.12.8/python-3.12.8-embed-amd64.zip`，sha256 `8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb`（11,094,114 字节）。
