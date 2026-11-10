# 项目接入 `dev` 分支端到端验收

## 范围

- 环境：本机 Team 模式 `http://127.0.0.1:4317`
- 团队：大数据
- 远端：`ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-web.git`
- 凭据：`yhj_trellis`
- 验收分支：仅 `dev`
- 其他分支不作为本次真实环境验收范围

## 操作与结果

1. 在项目接入页输入目标 SSH 地址并选择 `yhj_trellis`。
2. 远端识别成功后选择 `dev`，页面重新探测目标分支。
3. Agent 工具自动选中并锁定 `Codex`、`Pi`、`Oh My Pi`，三项均显示“已接入”且不可取消。
4. 点击 Agent 工具下拉可正常展开，页面没有清空、重定向或 Base UI 运行时错误。
5. 第一个负责人选择 `yhj`，Trellis developer ID 填写 `yhj`。
6. 提交接入返回 `201`，工具链摘要审批后项目状态变为 `current`。

## 数据与 Git 证据

- 工具链摘要：`700f3b29094001f91fad5c44b4d43d041336f13f03ca0aa72bef3c7f33db1f65`
- Agent 持久化值：`["codex","pi","omp"]`
- `dev` 接入前 HEAD：`cdc56bab76ba672015152da1a18fe52d982ba2a7`
- `dev` 接入后 HEAD：`cdc56bab76ba672015152da1a18fe52d982ba2a7`
- 工作副本状态：`## dev...origin/dev`，无本地改动
- 稀疏检出规则：`.trellis/`
- 工作副本顶层仅包含 `.git` 和 `.trellis`
- 项目最近 `push`：从未

`dev` 已有完整的 Agent 初始化文件，因此服务端按设计跳过 Trellis 初始化和远端提交，只拉取 `.trellis/`。

## 数据库证据

`team_project` 中只有一条本次接入记录：

```text
team_name=大数据
sync_branch=dev
sync_status=current
agent_tools_json=["codex","pi","omp"]
bootstrap_lead_trellis_dev_id=yhj
last_error=null
```

## 浏览器控制台

重新加载管理页后，项目仍显示 `current`，当前页面没有 console error、warning 或 assert。

## 结论

本次 `dev` 分支真实页面 E2E 通过。未测试或验证其他分支。
