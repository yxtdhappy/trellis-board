# 首次项目关联自动同步与状态反馈实施报告

## 实施结果

- Binding 在保持 `schemaVersion=1` 的前提下新增兼容字段
  `liveSyncStatus=pending|syncing|ready|error` 和 `liveSyncError`。
- Agent 在启动或发现新 approved binding 时执行服务端 full pull，再扫描 Git 脏文件、
  未跟踪文件和 `.trellis/.developer`，补传关联前已存在的本地变化。
- 初始化与 watcher 批次共用项目串行队列；服务端同路径内容优先，本地冲突先备份并通过
  `remote_overwrite` 提示，支持一键复原。
- `read_only` 只拉取和落盘，不扫描或上传本地修改。
- 初始化、后续上传和 pending 重试共用实时同步状态；网络失败显示同步异常，恢复后回到同步正常。
- pending 冲刷和初始化重试使用单飞 Promise，避免 5 秒定时器重入和重复上传。
- Tauri 关联成功后立即重启 sidecar，避免等待下一次 15 秒心跳才触发首次补传。
- Tauri `LocalAssociation` 透传实时同步状态，并兼容旧 sidecar 缺省字段。
- assignment warning 增加绝对过期时间；Tauri 轮询剔除已过期或 pending 文件已不存在的内存事件。
- 控制窗口提交时显示“正在提交，请稍候…”，失败后恢复按钮。
- `ProjectRail` 增加项目级 loading、Sonner 成功/失败提示，以及未关联、关联中、同步中、
  同步正常、同步异常、只读和失效状态。

## 主要文件

- `agent/config-store.js`
- `agent/live-sync.js`
- `agent/cli.js`
- `desktop/sidecar/desktop-association.js`
- `desktop/sidecar/desktop-device.js`
- `desktop/src-tauri/src/main.rs`
- `desktop/src-tauri/src/sidecar.rs`
- `desktop/ui/control.js`
- `web/src/components/layout/ProjectRail.tsx`
- `tests/desktop-realtime-apply.test.js`
- `tests/desktop-association.test.js`
- `tests/desktop-package.test.js`
- `agent/test/runtime-cli.test.js`

## 验证

- 检查阶段 `npm test`：373 通过、0 失败、5 跳过。
- 定向 Node 测试：首次初始化、冲突、只读、幂等、状态恢复、DTO 和包边界全部通过。
- `npm --prefix web run lint`：0 error，仅保留仓库既有 warning。
- `npm run build`：TypeScript 和 Vite 生产构建通过。
- `desktop/sidecar/build-sidecar.ps1`：SEA sidecar 构建通过。
- 新 sidecar 执行 `version`：`agentVersion=0.1.0`、`protocolVersion=2`。
- `git diff --check`：本任务产品文件和规范文件通过。

## 未验证

- 当前 `cargo`、`rustc` 不在 PATH，用户目录也没有可用的 `.cargo/bin/cargo.exe`，无法执行
  `cargo test` 或 `cargo tauri build`。
- 未安装新 sidecar/Tauri 包，未在 Windows WebView2 中验证关联 loading、取消、成功/失败提示、
  冲突复原和过期控制事件。
- `desktop/ui/control.js` 没有独立的客户端硬超时；动作最终依赖 Agent API 的 30 秒请求超时。
  连续多个请求时总等待时间可能更长，但不会无限保留按钮，最终会通过 invoke reject 恢复。

## 未执行

- 未提交、未推送、未安装安装包。
- 未处理仓库中与本任务无关的 `data/standalone-backup-20261108-142014/board.sqlite` 删除。
