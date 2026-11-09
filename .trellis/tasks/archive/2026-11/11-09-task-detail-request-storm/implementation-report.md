# 实施报告

## 结论

已修复团队任务详情重复请求问题。

## 变更

- 文件：`web/src/hooks/useBoard.ts`
- 使用 `useMemo` 缓存团队任务行到 `BoardTask[]` 的转换结果。
- 缓存依赖为 `teamMode`、`teamPage?.tasks` 和 `board?.tasks`。
- 非团队模式继续返回原有 `board.tasks`，没有改变调用方接口。

## 原因

团队模式此前在每次渲染时重新执行数组映射。`BoardPage` 的选中任务同步 effect 依据对象引用比较，每次都会把新对象写回 `selected`；`TaskDetailDialog` 又依赖任务对象触发详情读取，形成渲染与请求循环。

## 验证

- `npx oxlint src/hooks/useBoard.ts`：通过
- `npx tsc -b --pretty false`：通过
- `npm run build`：通过
- 浏览器回归：打开任务详情后仅一次 `POST /api/task`，HTTP 200
- 后续网络流量仅包含既有 revision/status 轮询，没有详情请求堆积

## 剩余事项

- 代码修改已包含在提交 `ef7eb4f`。
- 任务元数据、报告和 spec 回写作为收尾文件提交。
- 仓库暂无低成本 React hook 渲染回归测试入口，未新增测试依赖。
