# 模块行数上限指南

本指南约束源码文件的物理行数，防止功能迭代把模块重新堆成难以导航的大文件。2026-11 的 `11-19-split-oversized-modules` 任务把 server / web 的 19 个超大源文件拆到阈值内，本指南是防止复发的守门规则。

## 上限

| 范围 | 上限 | 说明 |
| --- | --- | --- |
| `packages/server/**`（非 `test/`） | 800 行 | 含 `plugins/`、`public/` 之外的 server 自有模块 |
| `packages/web/src/**` | 700 行 | 组件、hook、纯模块都算 |

只有 `packages/server/test/**` 与 `packages/web/test/**` 不受限（测试文件按被测行为聚合，拆分反而降低可读性）。

## 守门

规则靠评审与自查执行，不额外加自动化守卫测试（拆分与新增模块都应先看本指南）。超过上限的文件只有两类可以保留：

- 纯数据 / 无逻辑：单个 schema SQL 字面量集合、纯常量表。搬开只会让 schema 真相分散。
- 单一状态机不可切分：方法面被现有测试直接调用、多份状态必须共享同一实例（`packages/server/plugins/supervisor.js` 属此类）。

例外只减不增：新增文件不得例外；例外的文件不允许再变大，要加功能先拆逻辑。降到上限以内就把例外备注删掉。

## 拆分方式（按优先级）

1. 先找死代码与重复实现，删掉，而不是搬走。
2. 纯函数、类型、常量表、SQL 字面量：搬到独立模块，原文件保留装配与导出。
3. 单文件里多个状态机 / 多路由组 / 多视图：按「谁一起变」切开，共享状态收成一个显式的 `state` 对象或 `createXxx(deps)` 工厂，不要留模块级可变单例。
4. 保持对外导出面不变（同名、同签名、同顺序），消费者 import 路径尽量不动：barrel 只在原路径确有需要时保留（`packages/web/src/api/admin.ts`、`packages/web/src/lib/team-client.js` 是既有先例）。

拆分不是重构：禁止顺手改文案、错误码、SQL、默认值、props 契约。需要机械比对时，用 `git show HEAD:<path>` 与拆分后文件逐函数比较字符串字面量与 SQL 占位符数量。

## 硬约束

- 禁止靠合并行、删注释、压成一行的三元表达式来「达标」：统计的是物理行数，但压缩可读性同样视为违规。
- `import.meta.url` 相对路径在搬文件后会指向新目录，搬动前先 `rg "import.meta.url"` 核对（`packages/server/team/http.js`、`packages/server/team/task-space-index.js`、`packages/server/standalone/state.js`、`packages/server/loader.js` 均有）。
- 有测试以文本方式读源码断言内容（`packages/server/test/team-static.test.js` 读 `team/http.js`、`team/task-space-service.js`；`packages/desktop/test/desktop-ui-build.test.js` 读 web 组件），搬动被断言的字符串/文件名时必须同步改写断言，并保持断言验证的仍是同一个可观察行为，不得删除或放宽。
- Worker Thread 图（`scan-worker.js`）会加载整张 import 图：拆分后不能出现循环 import，模块级缓存只能有一份。

## 自查

```powershell
# 找超过上限的 server / web 源文件（排除 test 与构建产物）
Get-ChildItem packages/server -Recurse -Include *.js -Exclude *.test.js |
  Where-Object { $_.FullName -notmatch '\\(test|public)\\' } |
  Where-Object { (Get-Content $_.FullName).Count -gt 800 } |
  Select-Object FullName, @{n='Lines';e={(Get-Content $_.FullName).Count}}
Get-ChildItem packages/web/src -Recurse -Include *.ts,*.tsx |
  Where-Object { (Get-Content $_.FullName).Count -gt 700 } |
  Select-Object FullName, @{n='Lines';e={(Get-Content $_.FullName).Count}}
rg -n "import\.meta\.url" packages/server
```
