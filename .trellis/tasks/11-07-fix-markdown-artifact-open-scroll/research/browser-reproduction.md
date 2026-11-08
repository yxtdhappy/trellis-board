# Markdown 产物预览自动滚到底部：浏览器复现与根因

## 复现环境

- 页面：`http://127.0.0.1:4317/`
- 项目：`mdp-report-service`
- 任务：`11-05-multi-robot-push`
- 日期：2026-11-07
- 方式：复用 Chrome DevTools 当前页面，打开任务卡片详情，再点击 `任务产物` 中的 PRD 与 Design。

## 复现步骤与结果

1. 点击任务卡片“支持推送任务绑定多个飞书机器人”。
2. 在任务详情末尾点击 `PRD / 查看`。
3. 等待产物弹层完成渲染后读取滚动容器与焦点。

PRD 观测结果：

```text
clientHeight = 732
scrollHeight = 1660
scrollTop = 928
maxScrollTop = 928
activeElement = 弹层内第 1 个 button（页脚“关闭”）
```

4. 关闭 PRD，点击 `Design / 查看`，对同一组属性再次采样。

Design 观测结果：

```text
clientHeight = 732
scrollHeight = 7464
scrollTop = 6732
maxScrollTop = 6732
activeElement = 弹层内第 1 个 button（页脚“关闭”）
```

两次复现都精确落在最大滚动位置，排除了仅由某一份文档内容特殊定位造成的偶发现象。

## 当前 DOM 与状态链

- 产物弹层直接使用可滚动的 `DialogContent`，见 [TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:560)。
- Markdown 正文渲染完成后，页脚内先出现一个可聚焦的“关闭”按钮，见 [TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:571)。
- `DialogContent` 随后才追加右上角自动关闭按钮，见 [dialog.tsx](../../../web/src/components/ui/dialog.tsx:102)，所以页脚按钮在 Tab 顺序中仍排第一。
- 本地依赖 `@base-ui/react` 默认没有指定具体首次焦点元素；桌面交互使用默认行为，见 `web/node_modules/@base-ui/react/dialog/popup/DialogPopup.mjs:55`。
- 默认行为选取弹层内第一个可 Tab 元素，见 `web/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.mjs:379`。
- 聚焦该按钮时 `preventScroll=false`，见 `web/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.mjs:401`；浏览器为保证焦点可见，会把滚动容器滚到页脚。

## 根因结论

**已确认事实：** 产物弹层打开后，默认自动聚焦的是 Markdown 正文之后、页脚中的“关闭”按钮；该按钮位于滚动容器底部，聚焦行为导致容器滚到最大位置。

**因果链：**

```text
打开产物弹层
  → Base UI 使用默认首次焦点策略
  → 选取 DOM 中第一个可 Tab 元素
  → 该元素是 Markdown 之后的页脚“关闭”按钮
  → 聚焦时浏览器保证按钮可见
  → overflow-y-auto 容器滚动到底部
  → 用户先看到文档末尾
```

这不是推测性结论；滚动数值、当前焦点元素、DOM 顺序和依赖源码行为相互印证。

## 影响范围

- **已确认事实：** PRD 与 Design 两种长 Markdown 产物都会在首次打开时落到最大滚动位置。
- **推断：** 基于三者共用同一产物弹层渲染路径，Implement 及其他长 Markdown 产物也会受影响；文档越长，错误滚动距离越大。
- **推断：** 文档不足一屏且 `maxScrollTop=0` 时不会出现可观察的跳跃。

## 修复评估

推荐在产物弹层内解决首次焦点与初始滚动问题，避免先改动全局 `DialogContent` 的 DOM 顺序：

- 可为产物弹层指定位于顶部或弹层容器上的初始焦点目标，并确保打开时滚动位置归零。
- 可调整产物弹层页脚关闭按钮的首个可聚焦地位，但不能破坏键盘可访问性与 Esc 栈式关闭。
- 直接删除页脚关闭按钮不是完整修复，因为自动关闭按钮仍在正文之后，且会改变现有交互。

具体实现方式在实施阶段结合现有组件 API 选择；如果最终必须修改通用弹层行为，必须 regression 检查任务详情、管理台、登录页及其他 `DialogContent` 使用方。

## 待验证

- 修复后用同一任务重新打开 PRD 与 Design，断言 `scrollTop=0`。
- 滚动到底部后关闭并重开，确认位置重置。
- 验证 Esc、页脚关闭、右上角关闭、焦点在弹层内以及滚轮浏览均正常。
