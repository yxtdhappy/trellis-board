# 项目接入 Agent 目录识别与锁定

## Goal

修复项目接入页 Agent 工具崩溃与成员加载，按所选分支探测远端已有 Agent 初始化目录，锁定已接入项，并支持仅初始化缺失 Agent。

## Background

- 管理页点击 Agent 工具后 React 根节点被清空。浏览器控制台显示 `Base UI error #31`，对应 `MenuGroupContext is missing`；`DropdownMenuLabel` 被放在 `DropdownMenuGroup` 外。
- 系统管理员进入“全部团队”范围后切换到具体团队，项目接入页没有重新加载 active 团队成员，负责人下拉仍显示空列表。
- 当前探测只返回远端分支，不读取目标分支的 Git tree，因此页面不知道仓库已经初始化了哪些 Agent。
- 当前接入流程只在目标分支缺少 `.trellis/` 时运行 Trellis 初始化；已有 `.trellis/` 的仓库无法通过接入页面补充新的 Agent。
- `@mindfoldhq/trellis@0.6.17` 的平台注册表已经定义了每个 Agent 的唯一配置目录，例如 Codex `.codex`、Claude Code `.claude`、Cursor `.cursor`、OpenCode `.opencode`。

## Requirements

- 探测远端时必须基于用户当前选择的分支读取 Git tree，不能把其他分支的 Agent 状态套用到当前分支。
- 已存在对应 Trellis Agent 配置目录的 Agent 必须自动选中并锁定；用户不能取消该选择。
- Agent 工具下拉中只允许新增选择当前分支尚不存在的 Agent；已存在项保持可见但禁用。
- 切换共享分支后必须重新探测并刷新已锁定 Agent，用户之前未提交的新选择可以重置。
- 服务端在克隆后必须重新探测并校验 Agent 状态，不能信任前端锁定结果。
- 目标分支已有 `.trellis/` 且选择了新 Agent 时，只初始化新 Agent，并把新增初始化文件提交、推送到同一共享分支。
- 目标分支已有 `.trellis/` 且没有新 Agent 时，不运行初始化，不产生空提交。
- 目标分支缺少 `.trellis/` 时仍完成 Trellis 基础初始化；远端已有 Agent 文件必须通过临时检出避免被误判为可覆盖文件。
- 修复 Agent 工具下拉点击导致的 Base UI 运行时崩溃。
- 进入项目接入页或切换具体团队时，必须加载该团队的 active 用户作为首个负责人候选。
- 保持“全部团队”范围只读提示；接入项目必须先选择具体团队。
- 完成后必须使用真实页面和真实 SSH 远端接入
  `ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-web.git` 的 `dev` 分支，使用
  `yhj_trellis` 凭据；其他分支不作为本次真实环境验收范围。

## Acceptance Criteria

- [x] 在项目接入页点击 Agent 工具下拉不再出现空白页、React 崩溃或页面导航。
- [x] 选择具体团队后，首个负责人下拉能看到该团队的 active 用户。
- [x] 探测某个分支后，该分支已有的 Agent 自动选中并置灰，无法取消。
- [x] 下拉中只有当前分支不存在的 Agent 可以选择并初始化。
- [x] 切换共享分支后，已锁定 Agent 列表随目标分支重新探测。
- [x] 直接调用接入 API 时，服务端重新探测并拒绝或安全处理伪造的 Agent 状态。
- [x] 已有 `.trellis/` 的项目只初始化新选择的 Agent；没有新 Agent 时不运行初始化。
- [x] 缺少 `.trellis/` 且已有 Agent 目录的项目可以初始化基础 Trellis，不覆盖已有文件。
- [x] 自动化测试覆盖工具目录映射、分支探测、锁定值传递、增量初始化和跳过初始化。
- [x] 前端类型检查、构建和浏览器 E2E 通过。
- [x] `mdp-backend-web` 的 `dev` 分支使用 `yhj_trellis` 凭据完成页面接入和工具链批准。

## Out of Scope

- 不改变 Trellis Agent 工具本身的 CLI flag 或模板内容。
- 不根据任意用户文件推断 Agent 已初始化；只使用 Trellis 0.6.17 声明的平台配置目录。
- 不在浏览器端缓存其他分支的 Agent 状态。
