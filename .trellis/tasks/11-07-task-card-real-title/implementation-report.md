# 任务卡片显示真实任务名称：实施报告

## 结论

已完成卡片目录名展示。现有标题继续显示 `task.title`，标题下方新增完整的 `task.dirName`，复制动作仍复制该目录名。

## 改动

- `web/src/features/board/TaskCard.tsx`：在标题下新增 `task.dirName`，使用 `break-all text-[10px] leading-3.5 text-muted-foreground`，长目录名可完整换行且沿用主题色 token。
- 未修改 API、任务身份字段、任务详情、归档列表或复制函数。

## 页面验收

- 实际打开 `http://127.0.0.1:4317/` 并加载最新构建。
- 目标卡片标题保持 `[FIX][T170087][R35505] 模型发布多引擎参数元数据与控件修复（前端）`。
- 标题下方显示 `11-06-model-publish-multi-engine-params-frontend-fix`。
- 当前任务卡片标题下方显示 `11-07-task-card-real-title`。
- 拦截目标按钮对 `navigator.clipboard.writeText` 的调用，确认传入值为 `11-07-task-card-real-title`。

## 验证

- `npm --prefix web run lint`：通过。
- `tsc -p web/tsconfig.app.json --noEmit`：通过。
- `npm --prefix web run build`：通过，2596 个模块完成构建。
- `git diff --check`：通过。

## 剩余说明

- 长目录名会增加卡片高度，这是完整展示目录名的预期取舍。
- 浏览器自动化在执行深色模式计算样式时发生协议超时；新增文本使用现有 `text-muted-foreground` 语义 token，没有新增写死颜色。
