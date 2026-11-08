# 修复 Markdown 产物预览打开时自动滚到底部

## Goal

从任务卡片详情打开 PRD、Design、Implement 等 Markdown 产物时，预览应从文档顶部开始显示，让用户先看到标题、路径和开头内容，而不是直接落在文档末尾。

## Background

- 用户反馈任务卡片详情中的产物预览一打开就显示末尾，纵向滚动条位于最底部。
- 已在 `http://127.0.0.1:4317/` 使用真实浏览器复现：打开 `mdp-report-service / 11-05-multi-robot-push` 的 PRD 与 Design 后，弹出层均在最大滚动位置。
- PRD 弹层实测 `scrollTop=928`、`maxScrollTop=928`；Design 弹层实测 `scrollTop=6732`、`maxScrollTop=6732`，两者都精确落在底部。
- 当前焦点不是弹层容器，而是 Markdown 正文之后的第一个“关闭”按钮。该按钮位于滚动容器底部，自动聚焦时浏览器会把它滚入可视区。
- 产物弹层自身使用 `overflow-y-auto` 作为滚动容器，见 [TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:560)。
- 正文后的页脚“关闭”按钮是弹层内 DOM 顺序上的第一个可聚焦元素，见 [TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:571)。
- 通用弹层把右上角关闭按钮追加在全部 `children` 之后，见 [dialog.tsx](../../../web/src/components/ui/dialog.tsx:102)，因此它不能阻止上述页脚按钮成为首次聚焦目标。

详细复现数据与依赖行为见 [research/browser-reproduction.md](./research/browser-reproduction.md)。

## Requirements

- 首次打开任一长 Markdown 产物预览时，滚动容器的初始位置必须为顶部，标题和文档路径应立即可见。
- 关闭当前产物后打开同任务的其他产物，或重新打开同一产物，仍必须从顶部开始，不继承上一次滚动位置。
- 弹层打开后，用户仍可用滚轮、触控板、键盘和滚动条正常浏览至文档末尾。
- 自动聚焦不得触发滚动容器跳到底部；键盘焦点必须保持在弹层内，Esc 仍只关闭最上层弹层。
- 保持现有 Markdown 渲染、路径展示、产物切换、双层弹层关系和关闭方式不变。
- 修复范围限定为产物预览的打开位置与初始焦点行为；不得顺带修改看板布局、任务详情内容或 Markdown 渲染规则。

## Acceptance Criteria

- [x] 在真实浏览器打开长 PRD，弹层出现后 `scrollTop=0`，标题“工件查看 · PRD”与文件路径处于可视区。
- [x] 关闭 PRD 后打开长 Design，`scrollTop=0`，不出现首次打开即到底部的现象。
- [x] 在同一产物内滚动到底部后关闭，再次打开该产物仍从顶部开始。
- [x] 页脚关闭按钮不得成为打开弹层时的首次滚动触发目标；焦点仍在弹层内且可通过 Esc 关闭。
- [x] 滚轮、键盘和滚动条仍能到达文档末尾，页脚关闭按钮仍可正常使用。
- [x] 短 Markdown 不需要滚动时视觉与交互无回归；`maxScrollTop=0` 的容器无滚动空间，首次焦点位于顶部，不会制造位移。
- [x] 浅色与深色主题下标题、正文和关闭按钮显示正常。
- [x] 最终实现完成后执行前端 lint、TypeScript 检查与构建，并通过至少 PRD、Design 两种产物的真实浏览器回归。

## Out of Scope

- 不修改 Markdown 解析、安全转义或正文样式。
- 不新增按产物记住滚动位置的产品能力。
- 不重做任务详情弹窗、产物列表或看板布局。
- 不调整任务产物 API、读取逻辑或产物文件格式。
- 不批量修改其他弹窗的视觉结构；若修复必须改变通用弹层行为，需要在实施前重新评估影响面。

## Technical Notes

- 已确认根因是弹层默认聚焦第一个可 Tab 元素，而该元素位于长正文之后；不是 Markdown 内容自带的定位，也不是滚动条状态被持久化。
- 该问题属于轻量级前端交互缺陷，当前按 PRD-only 任务规划。若实施时确认需要改变通用 `DialogContent` 的全局焦点或 DOM 策略，应在开工前补充 `design.md` 和 `implement.md`，并扩大回归范围。
- 实际修复将产物弹层标题区设为首次焦点，未改变通用 `DialogContent`、Markdown 渲染或弹层栈逻辑。
