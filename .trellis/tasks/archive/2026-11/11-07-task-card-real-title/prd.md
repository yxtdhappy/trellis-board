# 任务卡片显示真实任务名称

## Goal

在现有任务卡片标题下方展示完整的真实任务目录名（`dirName`），并保持“复制任务名”复制该目录名。

## Background

- 任务卡片的可见标题已经直接渲染 `task.title`，见 `web/src/features/board/TaskCard.tsx:70`。
- 卡片上的“复制任务名”按钮已经复制 `task.dirName`，悬停提示也使用 `task.dirName`，见 `web/src/features/board/TaskCard.tsx:33` 与 `web/src/features/board/TaskCard.tsx:130`。
- 当前卡片只显示 `task.title`，没有在标题下方展示 `dirName`。

## Requirements

- 现有卡片标题继续显示 `task.title`，不改文案、不替换为 `dirName`。
- 在标题下方新增真实的 `task.dirName`，使用淡色小字显示，并允许长名称换行以完整展示。
- “复制任务名”继续复制完整的 `task.dirName`，复制结果不包含标题、项目名或额外说明。
- 不改变卡片其他字段、任务详情和归档列表的行为。

## Acceptance Criteria

- [x] 卡片标题仍显示对应 `task.json.title`，内容与现有行为一致。
- [x] 标题正下方显示完整的 `task.dirName`，视觉为淡色小字，长名称不被截断。
- [x] 点击“复制任务名”后，剪贴板内容与卡片的 `task.dirName` 完全一致。
- [x] 卡片布局在长 `dirName` 下正常扩展，不影响优先级、截止日期、进度和负责人等现有信息。
