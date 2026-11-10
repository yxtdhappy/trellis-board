# Agent 目录识别与增量初始化设计

## 1. 共享 Agent 注册表

扩展 `shared/trellis-agent-tools.js` 中每个工具的数据：

```js
{
  id: 'codex',
  flag: '--codex',
  label: 'Codex',
  presencePaths: ['.codex'],
}
```

`presencePaths` 来自 Trellis 0.6.17 平台注册表，只包含能独立证明该 Agent 已初始化的路径。共享目录 `.agents/skills` 不参与单个 Agent 判定。

新增纯函数：

```js
detectTrellisAgentTools(paths) -> string[]
```

输入是当前分支 tree 的相对路径；函数按注册表顺序返回存在配置路径的 Agent。路径必须精确匹配或位于探测目录下。

## 2. 分支级远端探测

扩展 `probeRemote()` 输入：

```json
{
  "remoteUrl": "ssh://...",
  "credentialId": "...",
  "branch": "dev"
}
```

流程：

1. `git ls-remote --symref` 读取分支和默认分支。
2. 未指定 `branch` 时使用默认分支。
3. 校验请求分支存在于远端。
4. 使用临时 partial clone 浅取目标分支：

```text
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch=<branch>
```

5. 使用 `git ls-tree -r --name-only -z HEAD -- <presencePaths> .trellis AGENTS.md .gitattributes` 读取受限路径。
6. 使用 `git show HEAD:.trellis/.template-hashes.json` 读取清单，把 `hashes` 的键并入 Agent 探测路径；ignored 的 `.codex/config.toml` 等文件也能据此识别。
7. 清单缺失、损坏或输出不可用时安全回退为空，不阻断基于 tree 的常规探测。
8. 返回 `branch`、`existingAgentTools`、`hasTrellis`。
9. 无论成功失败都删除临时目录和认证资料。

远端探测值仅用于 UI 预选和反馈；接入时服务端重新探测。

## 3. 前端锁定规则

`OnboardingTab` 保存探测结果中的 `existingAgentTools`：

- 探测完成后将现有 Agent 自动加入 `form.agentTools`。
- 分支变化时重新调用探测；成功后用新分支的现有 Agent 重置选择。
- 已存在 Agent 只能来自探测结果，用户不能取消。
- 新 Agent 可以多选。
- 提交时发送“已锁定 + 新选择”的完整 ID 数组。

扩展 `MultiSelectField`：

```ts
lockedValues?: string[]
```

锁定项始终 `checked=true`、`disabled=true`，并在行尾显示“已接入”。触发器和选项继续使用 ARIA checkbox 菜单语义。

同时修复：

- `DropdownMenuLabel` 移入 `DropdownMenuGroup`，解决 Base UI `MenuGroupContext is missing`。
- `OnboardingTab` 在具体团队且 `users` 为空时调用 `reloadUsers(true)`。
- “全部团队”范围显示需要先选择具体团队的提示。

## 4. Git 初始化流程

`cloneForTeam()` 接收完整所选 Agent 列表，并在 Git tree 中重新探测现有 Agent：

```text
existingTools = detectRemoteAgentTools(cwd)
newTools = requestedTools - existingTools
```

工作副本校验同样把 `.trellis/.template-hashes.json` 的 `hashes` 键与 `git ls-files` 结果合并；因此初始化生成但被 `.gitignore` 排除的 Agent 文件不会误报为缺失。

### 已有 `.trellis/`

- `newTools` 非空：只把 `newTools` 传给 Trellis CLI。
- `newTools` 为空：不运行初始化，不产生提交。
- 初始化前临时检出 `.trellis/`、`AGENTS.md`、`.gitattributes` 和已有 Agent 探测路径，让 `--skip-existing` 能看到真实文件。
- 校验通过后只清理本次临时克隆中的已知 Agent 路径，确保 ignored 生成目录不会残留到最终稀疏工作副本。
- 提交、推送成功后重新收敛为只含 `.trellis/` 的 sparse checkout。

### 缺少 `.trellis/`

- 使用完整选择运行基础初始化，`--skip-existing` 保护远端已有文件。
- 初始化前同样临时检出已有 Agent 路径和根级配置文件。
- 初始化、提交和推送成功后收敛为只含 `.trellis/`。

### 返回值与持久化

`cloneForTeam()` 返回：

```js
{
  existingAgentTools,
  initializedAgentTools,
  initialized,
}
```

数据库 `agent_tools_json` 保存当前分支已存在 Agent 与本次成功初始化 Agent 的并集。

## 5. API 契约

`POST /api/admin/projects/probe` 新增可选字段：

```json
{
  "branch": "dev"
}
```

响应新增：

```json
{
  "branch": "dev",
  "existingAgentTools": ["codex"],
  "hasTrellis": true
}
```

`POST /api/admin/projects` 继续接收 `agentTools`。服务端不信任其中代表“已存在”的语义，而是在克隆后重新探测并决定实际初始化列表。

## 6. 测试策略

- 共享注册表：探测路径唯一、相对路径安全、能按 tree 路径识别 Agent。
- Git 探测：本地临时远端在 `dev` 和 `main` 放置不同 Agent 目录，验证分支隔离。
- Git 探测：tree 不含被忽略 Agent 目录、但模板清单记录其文件时仍识别对应 Agent；清单缺失或损坏时回退到 tree。
- 已有 `.trellis/`：只把新 Agent 传给 initializer；无新 Agent 时 initializer 不被调用。
- 缺少 `.trellis/` 且 Agent 已存在：初始化成功且不覆盖已有文件。
- 初始化生成被 `.gitignore` 排除但清单记录的 Agent 文件：校验通过，推送后工作副本仍只保留 `.trellis/`。
- API：probe 返回现有 Agent 和 `.trellis` 状态；connect 持久化完整 Agent 并集。
- 前端：类型检查和构建；浏览器验证菜单不崩溃、锁定项不可取消、团队用户可加载。

## 7. 真实 E2E

目标分支：

```text
ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-web.git
dev
```

凭据：`yhj_trellis`。使用页面完成探测、`dev` 分支选择、Agent 选择、接入和工具链批准；本次不验证其他分支。若 `dev` 没有 `.trellis/`，允许服务端完成初始化提交和推送。
