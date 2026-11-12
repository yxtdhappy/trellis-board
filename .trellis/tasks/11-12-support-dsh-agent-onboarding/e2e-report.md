# 项目接入 Agent 列表与搜索 E2E 报告

## 测试拓扑

| 层 | 地址 / 方式 | 说明 |
| --- | --- | --- |
| 页面 | `http://127.0.0.1:4317/` | 当前 team 模式服务，PID `41152` |
| 浏览器 | ego-browser | Chrome DevTools MCP 不可用，按项目规则使用回退浏览器 |
| Tauri IPC | 最小注入 mock | 只模拟仓库预检、关联列表和 sidecar 状态 |

## 验证结果

| 场景 | 结果 |
| --- | --- |
| 打开接入弹窗 | 出现“搜索名称或 ID”，Agent 复选框共 22 项 |
| 搜索 `dsh` | 只保留 DeepSeek Harness |
| 搜索 `DeepSeek` | 只保留 DeepSeek Harness |
| 勾选 DSH 后继续搜索 | DSH 勾选状态保持 |
| 搜索 `not-an-agent` | 显示“没有匹配的 Agent” |
| 清空搜索 | 恢复 22 项，DSH 仍保持勾选 |
| 已有 Codex | 显示“已存在”且不可选择 |
| 520px 窄屏 | 弹窗 488px、单列列表、搜索框占满可用宽度，无横向溢出 |

截图：

- `C:/Users/yuhaojie/ego/trellis-dsh-onboarding-20261112-1425/onboarding.png`
- `C:/Users/yuhaojie/ego/trellis-dsh-onboarding-20261112-1425/onboarding-narrow.png`

## 限制

- 浏览器不提供真实 Tauri IPC，本轮没有操作真实桌面仓库或创建项目绑定。
- 未点击“初始化缺失的 Trellis 与 Agent 工具”，避免触发真实文件初始化。
