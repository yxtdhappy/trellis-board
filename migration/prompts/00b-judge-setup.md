# 00b — Judge 搭建

> 改编自 Claude Code Migration Kit `prompts/00b-judge-setup.md`（commit `cf91c9d`）。  
> 上游的 judge 通过 CLI/HTTP/文件 I/O 对比旧/新实现；本项目的公共界面是 **HTTP API + 浏览器页面**，所以 judge = API 契约测试 + Playwright parity。

**When:** 00 可行性 verdict 为 `go` 之后，第一个业务切片之前。  
**Prerequisites:** `migration/reports/00-feasibility.md` 已签；`migration/JUDGE.md` 已读。  
**Mode:** 可以创建测试代码和 fixture；不改 `public/` 业务行为。

---

## 任务

按 `migration/JUDGE.md` 建立裁判，分三层。

## 1. 盘点现有测试

逐类统计并写报告：

- 纯函数/可移植测试：
  - `tests/slug.test.js`
  - `tests/execution-filter.test.js`
  - `tests/markdown.test.js`
  - `tests/team-web.test.js` 中 import `public/team-client.js` 的部分
- 源码字符串/内部绑定测试：
  - `tests/team-web.test.js` 中 `publicFile()` + `assert.match` 的部分
- 服务端 API 测试：
  - `tests/team-core.test.js`
  - `tests/team-web.test.js` 的 API 部分
  - 其他 `tests/*.test.js`

输出：

```text
portable: N
internal-bound: N
service-side: N
```

并给每类至少 3 个例子。

## 2. 建立 L1 API 契约测试

位置：

```text
frontend/tests/api/
```

要求：

- 用临时 SQLite / 临时仓库 fixture，不碰 `data/board.sqlite`。
- 覆盖 `migration/JUDGE.md` §3 L1 的端点。
- 断言状态码、字段、错误 `code`，不用 truthy 代替。
- 同一组测试可以跑旧服务端；前端迁移不改变 API。

先做最小集：

- `/api/runtime` standalone/team
- 登录/登出/`/api/auth/me`
- `/api/board`
- `/api/tasks` 创建
- `/api/team/projects`
- 401/403

## 3. 建立 L2 Playwright parity harness

位置：

```text
frontend/tests/e2e/
frontend/playwright.config.ts
```

要求：

- 参数化 `legacy` / `next` 两个 base URL。
- 旧应用：`/`；新应用：`/next`（S0 之后可用）。
- 同一测试后端、同一 fixture。
- 断言 role/name/text/URL/API 结果；不用固定等待。
- 先覆盖 `JUDGE.md` 的 AUTH-01..06、BOARD-01..05、TEAM-01..02。
- 新应用还没有时，先只跑 legacy，把 harness 结构建好。

## 4. 验证裁判

### 4.1 旧应用全绿

- 启动测试后端 + 旧应用。
- 跑完整 L1 + L2。
- 记录通过数；旧应用自身失败必须先归因（环境/数据/judge bug）。

### 4.2 故意破坏必红

在旧应用上做至少 5 个临时 mutation（不提交）：

1. 登录成功跳转改错。
2. 任务筛选条件去掉。
3. 权限判断反转。
4. 分页游标清空。
5. 错误提示吞掉。

每次跑 judge，确认对应场景失败。  
如果破坏后仍全绿，修 judge，不要继续。

### 4.3 新旧同跑

新应用可用后，同一组场景：

```text
legacy: N/N pass
next:   N/N pass
```

记录差异；DOM 差异不算失败。

## 5. 输出

写入：

```text
migration/reports/00b-judge.md
```

包含：

- 测试分类计数
- L1 覆盖端点
- L2 覆盖场景
- 旧应用通过数
- 5 个 mutation 的“预期失败/实际失败”
- 已知假阴性/未覆盖场景
- 运行命令
- 是否需要人工在 gate 上启动服务

然后**停下**。不要开始 01 或任何业务切片。
