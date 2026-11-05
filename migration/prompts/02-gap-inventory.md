# 02 — 缺口清单

> 改编自 Claude Code Migration Kit `prompts/02-gap-inventory.md`（commit `cf91c9d`）。  
> 上游盘点的是“目标语言要求、源语言可以心算”的东西（ownership/nullability/接口契约）；本项目盘点的是 **DOM/状态/API/团队上下文/SSE/测试** 的迁移缺口。

**When:** 01 依赖图/功能地图签完之后。  
**Prerequisites:** `migration/depmap/`、`migration/feature-map.tsv` 已签。  
**Mode:** 只写 `migration/inventory*.tsv` 和报告；不改业务代码。

---

## 1. 缺口维度

对每个维度做机械扫描，先写计数，再写行。

### 1.1 全局状态

```bash
grep -o 'state\.' public/app.js | wc -l
grep -n '^const state = {' public/app.js
```

基线：442 处 `state.`。  
每个跨页面状态要回答：

- 归哪个 store
- 谁写、谁读
- 团队切换时是否清空
- 是否来自 API

### 1.2 手动渲染

```bash
grep -n 'renderAll\|function render' public/app.js
```

基线：`renderAll()` 在 `public/app.js:3517`，串联多个渲染函数。  
每个页面/区域要回答：

- 迁移后由哪个响应式数据驱动
- 查询键是什么
- 是否需要 `watch` / `computed`

### 1.3 DOM 操作

```bash
grep -c 'innerHTML' public/app.js
grep -c 'querySelector' public/app.js
```

基线：39 处 `innerHTML`、247 处 `querySelector`。  
每个高风险点要回答：

- 是否改成组件 props/emits
- 是否有 XSS 风险
- 焦点/滚动/键盘行为如何保留

### 1.4 API 与错误

从 `feature-map.tsv` 的端点清单出发。每个写操作要回答：

- 请求体/响应类型
- 401/403/404/409/422 的处理
- 幂等键
- ETag
- operation 轮询

### 1.5 团队上下文

每个团队数据页面要回答：

- 数据是否带 `teamId`
- 切换团队时如何失效
- 分页游标是否重置
- 旧 SSE 是否关闭

### 1.6 Dialog / 可访问性

基线：`public/index.html` 12 个 `<dialog>`。  
每个 dialog 要回答：

- 迁移到哪个组件
- 打开/关闭触发
- 焦点返回
- Esc/遮罩行为
- 错误提示

### 1.7 测试

区分：

- portable：纯函数/公共接口
- internal-bound：读 `public/app.js` 源码、依赖 DOM 字符串
- service-side：后端 API 测试

### 1.8 新行为

SSE、多团队、新用户管理、密码 6 位。  
不要塞进旧版 parity 行；单独标 `NEW-BEHAVIOR`。

## 2. 清单格式

文件：

```text
migration/inventory.tsv
```

列：

```text
id	area	file_line	source_construct	target_pattern	risk	decision	evidence	status
```

状态：

- `open`：已定位，未决定
- `confirmed`：有证据、有决策
- `unknown`：缺信息，按最保守方案 + `TODO(vue):`
- `deferred`：明确不在本次迁移

规则：

- 一行一个 site。
- `file_line` 必须可定位。
- `evidence` 写命令/行号，不写“看一下”。
- `unknown` 必须写“需要谁回答什么”。
- 不许用“统一处理”代替具体决策。

## 3. 先做 20 行

先完成 20 行，覆盖所有 area，优先复杂/高风险：

1. 全局 state
2. renderAll
3. innerHTML/querySelector
4. requestJson/ApiError
5. initializeTeam
6. dialog
7. 团队切换
8. 分页游标
9. Git operation 轮询
10. 旧源码字符串测试
11. CSS
12. 密码策略
13. SSE
14. Tauri 相关（如前端有）
15. admin 用户
16. admin 项目/Agent/审计
17. 插件
18. 归档
19. 搜索/筛选
20. 构建/部署

写入后**停下**，展示 20 行和 area 计数。人工确认后再全量。

## 4. 全量扇出

- 每个 agent 只写自己的 shard：`migration/inventory.<area>.tsv`。
- 不并发写同一个文件。
- 合并时按 `(file_line, source_construct)` 去重，稳定排序。
- 进度看 shard 行数增长；3 个 poll 无增长视为失败。

## 5. 联合审计

两个 reviewer 同时读 `DESIGN.md` + `inventory.tsv`：

- 找“规则会翻错”的行
- 找“规则没被任何行覆盖”的缺口
- 每个冲突必须给规则、行、错误翻译例子

确认的修 inventory；规则修订写 `migration/reports/amendments.md`，不要改 `DESIGN.md`。

## 6. 输出

```text
migration/inventory.tsv
migration/reports/02-inventory.md
```

报告包含：

- 总行数
- 各 area 行数
- `unknown` 行及问题
- 冲突列表
- 是否覆盖所有已知 site

然后**停下**。不要开始实现。
