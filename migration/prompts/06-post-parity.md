# 06 — Post-Parity 收尾

> 改编自 Claude Code Migration Kit `prompts/06-post-parity.md`（commit `cf91c9d`）。  
> 上游在“port shipped bug-for-bug”之后清理 `BUG(port)` / `TODO(port)` / `PERF(port)`；本项目在全部纵向切片通过 parity 之后，清理迁移标记并决定是否删除旧前端。

**When:** 所有 slice 完成、全量 parity 绿、人工确认之后。  
**Prerequisites:** `migration/reports/06-parity.md` 的前置计数；`manifest.tsv` 全部 `done`。  
**Mode:** 可以改新前端；不要删除 `public/` 直到本 gate 签字。

---

## 1. 机械收集标记

```bash
rg -n 'TODO\(vue\)|PARITY-GAP|NEW-BEHAVIOR|BUG\(legacy\)|PERF\(vue\)' frontend migration
```

报告开头给每个标记的计数（grep 输出，不是叙述总数）。

## 2. 分类

每行标记只选一个：

- **fix now**：影响行为/权限/数据正确性，或阻塞删除旧前端。
- **document and close**：已知差异、不影响当前验收，写清楚原因并保留记录。
- **new task**：属于新功能/后续优化，拆出去，不在本 gate 修。

分类表：

```text
marker	id	decision	reason	owner
```

## 3. Fix-now 规则

- 一个 fix 一个提交/变更。
- 每个 fix 必须重跑相关 parity。
- 证明“只有标记的行为变了”；其他输出不变。
- 如果 fix 改变多个行为，拆成多个变更。
- 复发模式（同一类标记出现 3 次）视为设计/规则问题，写 amendment，不要继续修实例。

## 4. 删除旧前端前的检查

- [ ] 所有现有流程 parity 通过。
- [ ] standalone / team 两种模式 smoke 通过。
- [ ] `/legacy` 回退路径验证。
- [ ] Tauri 加载验证（远程 URL 或本地 `frontend/dist`）。
- [ ] 旧测试中的源码字符串断言已删除或替换。
- [ ] 旧 `public/` 入口无引用。
- [ ] README / 部署文档更新。
- [ ] 人工签字。

## 5. 输出

```text
migration/reports/06-parity.md
```

内容：

- 标记计数
- 分类表
- fix-now 列表及各自 parity 结果
- 未修复项和原因
- 旧前端删除建议（保留一个发布周期 / 立即删除）
- 最终 DoD 核对

然后**停下**，展示分类表和 parity 结果。不要自行删除 `public/`。
