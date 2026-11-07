# 修复项目删除参数契约

## Goal

修复“管理看板项目”弹窗点击删除后提示“缺少项目 ID”的问题，让用户可以从看板白名单移除项目，同时不删除仓库源文件。

## Background

- 项目管理弹窗当前把项目 `path` 交给删除动作：[ProjectManagerDialog.tsx](../../../web/src/features/board/dialogs/ProjectManagerDialog.tsx:81)。
- 前端 API 当前发送 `{ path }`：[board.ts](../../../web/src/api/board.ts:113)。
- 后端删除接口只读取 `id`，缺失时抛出“缺少项目 ID”：[repositories.js](../../../server/repositories.js:118)。
- 后端现有测试使用 `{ id }` 调用，因此没有覆盖前端实际发送的错误请求形状：[repositories.test.js](../../../tests/repositories.test.js:140)。

## Requirements

- 项目管理弹窗必须使用列表返回的仓库 `id` 调用删除动作。
- 前端删除 API 必须向后端发送 `{ id }`，不得再发送 `path`。
- 后端继续按仓库 `id` 定位并删除白名单记录，不改变现有数据清理和事务语义。
- 删除成功后刷新项目列表和看板数据，并显示成功提示。
- 删除项目仍只移除 Board 白名单及其关联 Board 数据，不删除源仓库目录或 Trellis 任务文件。

## Acceptance Criteria

- [x] 在项目列表中点击任一项目的删除按钮，不再出现“缺少项目 ID”。
- [x] 删除请求体包含目标仓库的 `id`，不包含用于定位的 `path`。
- [x] 删除成功后该项目从数据库白名单和页面项目列表中消失，源目录仍然存在。
- [x] 后端“缺少项目 ID”和“项目不在看板中”校验仍然有效。
- [x] 相关 Node 测试通过，前端类型检查与构建通过。
- [x] 启动真实服务后，通过实际 API 或页面操作完成一次删除并确认列表刷新。

## Out of Scope

- 不修改项目添加流程。
- 不修改仓库目录、Trellis 任务文件或项目扫描逻辑。
- 不改变删除项目时对人工阶段、执行扩展数据和依赖行的现有清理规则。

## Technical Notes

- 这是轻量级前后端契约修复，PRD 足够，不新增 `design.md` 或 `implement.md`。
- 主要消费者为 `ProjectManagerDialog`、`useBoard` 的 repository action、`web/src/api/board.ts` 和后端 `DELETE /api/repositories`。
