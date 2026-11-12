# 项目初始化兼容与预检体验集成检查

## 子任务状态

- `fix-pi-init-exdev`：已完成并归档，工作提交为 `b2a9575`。
- `fix-project-preflight-guidance`：已完成并归档，工作提交为 `2e8894b`。

## 集成验证

执行：

```bash
node --test tests/desktop-trellis-runtime.test.js tests/desktop-package.test.js tests/trellis-agent-tools.test.js agent/test/project-onboarding.test.js tests/onboarding-probe.test.js
```

结果：35 项通过，0 失败，0 跳过。

覆盖内容：

- Pi `EXDEV` 只在约定失败特征下触发补齐，并且只重试一次。
- Pi 补齐不覆盖已有文件，失败时回滚本次创建内容。
- Pi 只有在扩展和 settings 两个完成标记都存在时才识别为已安装。
- 未初始化 Trellis 或首次推送未就绪时，任务预检保持禁用并显示原因。
- `Error`、字符串和带 `message` 的对象错误都能显示具体原因。
- sidecar 打包包含 Pi 补齐脚本，桌面 sidecar 初始化路径保持可用。

## 结论

父任务四条验收标准均满足。当前工作区中 `tests/team-gitless-http.test.js` 和另外两个 active
task 不属于本任务，未纳入本任务改动。
