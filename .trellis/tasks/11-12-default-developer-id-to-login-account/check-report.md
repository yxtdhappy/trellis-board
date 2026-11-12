# 客户端接入项目默认填入当前登录账号检查报告

## 1. 检查范围

- 当前登录账号 `runtime.user.username` 从看板页面传递到项目栏和接入弹窗。
- 弹窗打开、切换仓库、关闭后重新打开时的默认值初始化。
- 用户手动编辑后，Agent 工具切换或迟到的运行时用户数据不得覆盖输入。
- 当前用户没有用户名、继续沿用空值校验的兼容路径。
- 代码改动范围、前端规范同步和无关工作区改动隔离。

## 2. 检查结论

实现只修改 3 个前端文件，并同步 1 份前端规范：

- `BoardPage.tsx` 传递 `runtime.user.username`。
- `ProjectRail.tsx` 将默认 developer ID 转交给接入弹窗。
- `ProjectOnboardingDialog.tsx` 在打开或切换仓库时初始化默认值；用户编辑后使用 ref 标记，
  迟到运行时数据不覆盖用户输入。
- `rendering-and-state.md` 记录默认账号与迟到数据不覆盖的契约。

检查中发现并修复了“关闭后重新打开输入框为空”以及“迟到运行时数据覆盖用户输入”的时序问题。

## 3. 自动验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试（第一轮） | `npm test` | 517 项：505 通过、12 跳过、0 失败 |
| 全量测试（最终代码复跑） | `npm test` | 503 通过、2 个 ACP 并发超时失败、12 跳过 |
| ACP 失败项隔离复跑 | `node --test --test-name-pattern='运行超时触发\|tool call 执行中' plugins/acp-dispatch/test/index.test.js` | 2/2 通过 |
| Web 构建与 TypeScript | `npm --prefix web run build` | 通过 |
| 格式 | `oxfmt --check` | 通过 |
| 空白错误 | `git diff --check` | 通过 |

Web 构建仅有既存的大 chunk 警告，不影响构建成功。

最终代码复跑中的 2 个失败均位于 `plugins/acp-dispatch/test/index.test.js`，与本次前端接入弹窗
改动无关；隔离复跑均通过，判断为并发执行下的时序抖动。第一轮全量测试已完整通过。

## 4. 桌面端 E2E

- [x] 使用账号 `yhj` 打开“接入本地 Git 项目”，初始值为 `yhj`。
- [x] 将输入改为 `yhj-test`，切换 Agent 工具后仍保持 `yhj-test`。
- [x] 取消弹窗后重新选择同一仓库，输入框重新显示 `yhj`。
- [x] 操作完成后关闭接入弹窗，未建立新的项目关联。

## 5. 尚未执行

- 未提交、未推送。
- 未归档 Trellis 任务。
- 工作区中的其他并行任务和已删除文件未修改、未回滚。
