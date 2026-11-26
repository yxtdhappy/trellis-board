# E2E Report: 项目成员账号选择器

## 环境拓扑

| 项 | 值 |
| --- | --- |
| 源码 HEAD | `3ca8c7b11e4d9e8fc8dddf62b91b1e79e925c743` |
| 服务端进程 | PID `48272`，启动时间 `2026-11-26 17:33:20`，health `serverStartedAt=2026-11-26T09:33:25.358Z`，version `0.5.15` |
| 前端 dev server | PID `46696`，`http://localhost:5188`，Vite `8.3.8` |
| 服务端端口 | `http://127.0.0.1:4399`，team 模式，basePath `/` |
| 隔离数据目录 | `C:\projects\_trellis-board-e2e\project-member-account-picker\server-data` |
| 浏览器 | 项目现有 Chrome DevTools MCP，使用独立 isolated browser context |
| 生产数据 | 未使用、未修改 |

隔离库包含系统管理员、测试账号 `zsw`（内部 ID 固定为 `58717f60-6995-4c79-b4e1-ca1c352e42df`）、停用账号及项目负责人。前端通过 Vite 将 `/api` 代理到本轮真实服务端。

## 验收结果

### AC1: 管理员账号选择器与 active 候选

通过。

- 管理员登录后进入“项目协作 → E2E 项目”，表单标题显示“用户账号”而不是“用户 ID”。
- 下拉选项为 `E2E 管理员 · e2e-admin`、`项目负责人 · e2e-lead`、`zsw · zsw`。
- 停用账号 `disabled-user` 未进入新成员候选。
- 页面浅色和深色主题均实际打开检查，选择器、说明文本和已有成员列表显示正常。

### AC2: `zsw` 提交内部 UUID 并刷新列表

通过。

- 选择 `zsw · zsw`，填写 developer ID `zsw` 后保存。
- `PUT /api/projects/22222222-2222-4222-8222-222222222222/members` 返回 `200`。
- 请求体：

```json
{"userId":"58717f60-6995-4c79-b4e1-ca1c352e42df","role":"member","trellisDevId":"zsw"}
```

- 保存后实际发出 `GET /api/projects/22222222-2222-4222-8222-222222222222/members`，返回 3 名成员，其中包含：

```json
{"userId":"58717f60-6995-4c79-b4e1-ca1c352e42df","username":"zsw","displayName":"zsw","role":"member","trellisDevId":"zsw"}
```

- 页面成员数保持为 `3`，`zsw` 行仍存在，新增表单已清空。
- 首轮 E2E 在修复前真实复现了“PUT 成功但页面成员变 0”；修复为 PUT 后复用 `fetchMembers()` 后，上述复测通过。

### AC3: 编辑停用成员不丢失当前值

通过。

- 点击项目成员中的停用账号“编辑”后，账号选择器回显 `停用账号 · disabled-user`。
- 角色回显 `只读`，developer ID 输入保持禁用；成员列表未变化。
- 说明文本明确提示：新成员只列 active 账号，当前编辑的停用或目录外成员会保留在选项中。

### AC4: 项目负责人使用手工 UUID 路径

通过。

- 使用非管理员项目负责人登录，进入可管理项目。
- 表单显示“用户 ID”手工输入，没有账号选择器。
- 说明文本为“请填写账号内部 UUID，不是登录名；项目负责人无法加载账号目录。”
- 页面未请求 `/api/admin/users`，用户目录可见范围未扩大。

## 控制台与请求

- 页面控制台出现一条仓库既有的 Base UI `nativeButton` 可访问性错误，定位在 `AdminPage` 顶部头像触发器；本次改动区域未新增控制台错误。
- 验收期间保存流程只产生预期的 `PUT members` 和随后用于权威刷新的 `GET members`，均为 `200`。

## 未覆盖项

- 未人为模拟 `/api/admin/users` 返回 5xx 的目录失败场景；项目负责人无权限路径已验证手工 UUID 回退，但失败 toast 本身未做故障注入。
- Chrome DevTools MCP 的截图持久化因工作区根目录限制被拒绝；截图已在会话内实际查看，本报告以 DOM、网络请求和响应体作为可复核证据。

## 清理

- 验收结束后关闭隔离服务端和 Vite dev server。
- 删除 `C:\projects\_trellis-board-e2e\project-member-account-picker`。
- 不触碰生产服务 `4317` 和用户现有浏览器页面。
