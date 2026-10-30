# Bootstrap Guidelines 检查报告

## 结论

规范初始化任务的文档产物、上下文编排和静态验收均已完成。独立复核又补正了任务路径、文件监听范围和前端 `api()` 描述；当前规范与源码事实一致。

看板实测推导阶段为 `commit`，`commit` 与 `archive` 尚未执行，等待用户明确授权。

## 检查发现

- 已修复：原 PRD 使用中文标题，阶段推导无法按标准 `## Requirements` / `## Acceptance Criteria` 识别。现已改为标准结构，7 项验收全部勾选。
- 已修复：原任务事实仍写 Node `>=20` 和 `data/*.json`。现已按当前代码更新为 Node `>=24`、内置 `node:sqlite` 和 `data/board.sqlite`。
- 已修复：跨层指南曾把任务定位字段写成“相对于 `.trellis/tasks` 的目录”；实际 `relativeDir` 相对仓库根，并由不同接口以 `taskDir` / `taskPath` 传入。
- 已修复：扫描规范曾声称监听刷新会全量重扫全部白名单仓库；实际按事件执行任务级或仓库级增量刷新，再基于全部缓存任务重建跨仓库关系。仅在 Worker 冷启动和手动刷新时执行仓库级完整扫描。
- 已修复：前端状态规范现明确只有请求体存在时才设置 JSON 请求头和序列化数据。
- 已验证：四份旧 JSON 只作为首次迁移来源和回滚备份，规范没有再把它们描述为运行时状态来源。
- 已验证：规范没有把认证、审计、远程协作或共享数据库写成已实现能力。
- 未修复：`PUT /api/tasks/stage` 当前只校验阶段枚举，没有重新校验 `projectId` 白名单和 `taskPath` 任务根。该问题属于产品代码边界，超出本任务“不改 `server/`”的范围；规范已明确记录，后续应补路径校验及回归测试。
- 未处理：`.gitattributes` 仍引用不存在的 `.trellis/spec/cli/backend/directory-structure.md`。它与本任务验收无关，按最小改动原则保持原状。
- 未处理：[README.md](../../../README.md) 仍写着自动刷新会重扫全部白名单仓库，与当前增量扫描实现不一致。README 不属于本次 `.trellis/spec/` 范围，保持原状以免扩大文档任务。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `python ./.trellis/scripts/task.py validate 00-bootstrap-guidelines` | 通过；implement.jsonl 3 条、check.jsonl 3 条 |
| `python ./.trellis/scripts/get_context.py --mode packages` | 通过；发现 backend、frontend 两层规范 |
| `node .audit/bootstrap-spec-check.mjs` | 通过；12 个 Markdown 文件、90 个相对链接、缺失链接 0、未入索引文件 0 |
| `rg` 模板占位检查 | 通过；`.trellis/spec` 未发现 `TBD`、`TODO`、`placeholder`、`占位`、`待补充` |
| `npm test` | 通过；55 项测试，55 通过、0 失败 |
| `server/`、`public/` JS 语法检查 | 通过；全部 JavaScript 文件通过 `node --check` |
| `POST /api/task` 实时接口 | 通过；返回 `derivedStage: "commit"`，PRD 证据为 `7/7` |

`task.py validate` 对 `main` 分支给出提示，是因为仓库当前还没有任何提交，`refs/heads/main` 尚不存在；`git status` 同时显示 `No commits yet on main`。该提示不是本次文档验收失败。

## 验证边界

- 本任务是规范和任务文档交付，没有修改 `server/`、`public/`、`tests/` 的产品行为。
- 真实验证阶段为可选步骤；本任务不涉及可执行产品变更，因此不新增 E2E 证据。
- 未提交、未推送、未归档。
