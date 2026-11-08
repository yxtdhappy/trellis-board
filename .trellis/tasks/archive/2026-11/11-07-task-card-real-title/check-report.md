# 任务卡片显示真实任务名称：质量检查

## 结论

质量检查通过，未发现需要修复的问题。

## 规范核对

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 现有标题不变 | 通过 | 页面快照仍显示完整 `task.title` |
| 标题下方展示完整 `task.dirName` | 通过 | 页面快照显示目录名文本节点 |
| 淡色小字与主题 token | 通过 | `text-[10px] text-muted-foreground` |
| 长目录名不截断 | 通过 | `break-all`，无 `line-clamp` 或 `truncate` |
| 复制真实 `dirName` | 通过 | 拦截 `clipboard.writeText` 得到 `11-07-task-card-real-title` |
| 变更范围 | 通过 | 仅修改 `web/src/features/board/TaskCard.tsx` |

## 自动化检查

- `npm --prefix web run lint`：通过，`TaskCard.tsx` 无新增警告。
- `tsc -p web/tsconfig.app.json --noEmit`：通过。
- `npm --prefix web run build`：通过。
- `git diff --check`：通过。

## 规范回写判断

本次是单次展示补充，没有形成新的跨层契约或可复用约定；现有前端规范已覆盖主题 token、组件边界和页面验收，无需修改 `.trellis/spec/`。

## 未执行项

- 未运行与本次 TSX 展示无关的全量 Node 测试；项目没有覆盖 `TaskCard` 的组件测试。
- 深色模式计算样式的浏览器脚本发生协议超时，未取得运行时颜色值；样式仅使用已有主题 token。
