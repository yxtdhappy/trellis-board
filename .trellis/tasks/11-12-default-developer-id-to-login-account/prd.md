# 客户端接入项目默认填入当前登录账号

## Goal

客户端接入本地 Git 项目时，减少重复输入：Trellis developer ID 默认使用当前登录账号，同时保留用户手动修改能力。

## Background

- 接入弹窗当前在每次打开时把 developer ID 重置为空字符串，见 [ProjectOnboardingDialog.tsx](../../../../web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:258)。
- 看板运行时已经提供当前登录用户信息 `runtime.user.username` 与 `runtime.user.displayName`，见 [board.ts](../../../../web/src/api/board.ts:54) 和 [BoardPage.tsx](../../../../web/src/pages/board/BoardPage.tsx:98)。
- 登录名和 developer ID 都允许 ASCII 字母、数字、点、下划线和中划线；登录名为 3 到 64 位，developer ID 为 1 到 64 位，因此有效登录账号可直接作为默认值，见 [auth.js](../../../../server/team/auth.js:16) 和 [toolchain.js](../../../../server/team/toolchain.js:7)。

## Requirements

- R1：接入本地 Git 项目弹窗打开时，Trellis developer ID 默认填入当前登录账号的 `username`。
- R2：默认值不得使用显示名，以免与登录名、项目成员映射和 Trellis workspace 目录语义混淆。
- R3：用户仍可在接入前手动修改 developer ID；普通输入、团队切换和 Agent 工具选择不得把用户输入重置回登录账号。
- R4：切换待接入仓库或重新打开接入弹窗时，developer ID 重新以当前登录账号作为初始值。
- R5：当前运行时没有可用 `username` 时保持空值，并沿用现有“请填写 Trellis developer ID”校验与错误提示。
- R6：不改变初始化、首次推送确认、任务预检、接入以及服务端 developer ID 校验逻辑。

## Acceptance Criteria

- [x] AC1：以账号 `yhj` 登录并打开“接入本地 Git 项目”弹窗，截图中对应输入框初始显示 `yhj`。
- [x] AC2：输入框中的默认值可以编辑；编辑后执行团队切换或 Agent 工具选择，输入值保持不变。
- [x] AC3：关闭弹窗后重新打开，或切换为另一个待接入仓库，输入框再次显示当前登录账号。
- [x] AC4：当前用户没有 `username` 时输入框为空，空值仍阻止初始化和任务预检，并显示现有校验提示。
- [x] AC5：使用预填值完成接入时，客户端传递给初始化、预检和关联命令的 `developerId` 与界面显示值一致。
- [x] AC6：相关自动测试、TypeScript 类型检查和一次最终构建通过；桌面端接入弹窗完成一次实际交互验证。

## Out Of Scope

- 不修改账号模型、登录流程或 developer ID 校验规则。
- 不自动替其他成员配置 developer ID，也不修改管理端成员映射。
- 不记忆用户上一次手动修改的 developer ID，不引入按项目保存的本地偏好。
- 不改变 developer ID 输入框的最大长度、占位文案或卡片布局。
