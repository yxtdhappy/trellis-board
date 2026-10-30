# 项目开发规范初始化

## Goal

根据当前仓库真实代码重建 `.trellis/spec/`，让后续 Trellis 子代理在不引入错误技术假设的前提下继续开发。

## Background

原始任务开始时，项目状态主要存储在多个 JSON 文件中。任务收尾前，仓库已经完成 SQLite 持久化迁移，因此规范验收以当前代码为准，不再保留“JSON 是运行时状态来源”的过期描述。

## Requirements

- 使用 Node.js 原生能力和当前真实模块边界描述项目，不引入不存在的框架、构建链或第三方依赖。
- 将 `.trellis/spec/frontend/` 限定为原生 HTML、CSS 和浏览器 ES Module 的真实模式。
- 将 `.trellis/spec/backend/` 覆盖 `server/` 的 HTTP、Worker、扫描、SQLite、缓存、白名单和原子写边界。
- 将 `.trellis/spec/guides/` 覆盖阶段、路径、`taskKey`、API 错误和代码复用边界。
- 所有索引只链接实际存在的文件，不保留未替换的模板占位内容。
- 不修改产品源代码、测试或运行时行为。
- 已知重复阶段定义只记录为技术债，不在本任务中重构。

## Acceptance Criteria

- [x] `.trellis/spec/frontend/` 只描述原生 DOM 前端的真实模式。
- [x] `.trellis/spec/backend/` 覆盖 `server/` 的 HTTP、Worker、SQLite、扫描、缓存、白名单和原子写。
- [x] `.trellis/spec/guides/` 覆盖阶段、路径、`taskKey`、API 错误和复用边界。
- [x] 所有索引与实际文件一致，正文引用真实代码路径。
- [x] 规范明确 Node `>=24`、内置 `node:sqlite` 和 `data/board.sqlite` 为当前运行状态来源。
- [x] 不把认证、审计、远程协作或共享数据库写成已经实现的能力。
- [x] `npm test`、JS 语法检查、上下文包发现和 Markdown 链接检查全部通过。

## Non-goals

- 不修改 `server/`、`public/` 或 `tests/` 的产品行为。
- 不提交、推送或归档任务；这些动作由后续 Phase 3.4 和 `trellis-finish-work` 处理。
- 不为已知重复的阶段定义做顺手重构。
