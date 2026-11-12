# 修复双分支绑定导致后台同步崩溃循环

## Goal

当同一本地仓库存在多个历史分支 binding 时，后台 Agent 只能同步当前真实分支对应的激活 binding；
事件流重连不能因为访问未激活 binding 而抛出未处理异常并退出，从而恢复后台同步的可用性。

## Background

- 本机 `trellis-board` 配置同时存在 `main` 和 `codex/server-gitless-task-sync` 两个 approved binding。
- 分支隔离逻辑根据当前真实分支只激活其中一个 binding：
  [task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:295)。
- SSE `onOpen` 仍遍历配置中的全部 approved binding：
  [index.js](../../../agent/index.js:508)。
- 未激活 taskSpace 进入 `pullTaskSpace()` 后由 `_binding()` 抛出 `BINDING_UNKNOWN`：
  [task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:559)、
  [task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:1079)。
- 调用方使用 `void` 丢弃 Promise，Node 24 将未处理的 rejection 作为致命异常；日志已出现
  `onOpen -> pullTaskSpace -> _binding` 堆栈和 sidecar 退出码 1。
- 桌面壳按 1、2、4、8、16 秒重试，第 5 次失败后提示“后台同步连续启动失败”：
  [sidecar.rs](../../../desktop/src-tauri/src/sidecar.rs:629)。

## Requirements

- R1：SSE 事件流恢复时只对当前运行时激活的 binding 发起补拉，不遍历未激活的历史 binding。
- R2：`pullTaskSpace()` 遇到当前未激活的 taskSpace 时返回 `{ skipped: true, reason: "BINDING_INACTIVE" }`，
  不将正常的“分支未激活”误判为未知 binding 并抛异常。
- R3：后台事件触发的 fire-and-forget 补拉必须有 rejection 处理，单个 taskSpace 同步失败只能记录日志，
  不能让整个 Agent 退出。
- R4：保留现有分支保护语义：未激活或分支不匹配的 binding 不拉取、不写任务目录、不上传、不推进 cursor。
- R5：补充回归测试，覆盖同一 `localRepoKey` 存在两个 approved 分支 binding、仅一个当前激活、
  SSE 恢复和未激活 taskSpace 补拉的组合。

## Acceptance Criteria

- [x] AC1：双分支 binding 场景下，SSE `onOpen` 仅触发当前激活 binding 的 `pullTaskSpace()`。
- [x] AC2：对未激活 taskSpace 调用 `pullTaskSpace()` 返回 `BINDING_INACTIVE` skipped 结果，
  且不调用服务端 API、不访问任务文件。
- [x] AC3：SSE 恢复或后台补拉失败不会产生未处理 Promise rejection，Agent 进程保持运行。
- [x] AC4：现有分支切换、首次同步、上传、拉取、pending retry 和冲突处理测试保持通过。
- [x] AC5：相关自动化测试通过，代码格式检查通过；开发期间不执行构建。

## Out of Scope

- 不改变“一个本地工作目录同一时间只激活一个分支 binding”的产品规则。
- 不自动切换 Git 分支、不合并任务、不清理历史 taskSpace 或重复任务。
- 不修复强制重启时 `taskkill/tasklist` 的独立进程生命周期竞态。
- 不修改服务端 attach、revision、CAS 或远端 binding 撤销协议。

## Open Questions

无。
