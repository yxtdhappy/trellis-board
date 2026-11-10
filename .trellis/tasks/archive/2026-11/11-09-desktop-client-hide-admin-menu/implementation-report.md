# 客户端登录后隐藏团队管理入口实施报告

## 实施结果

- `BoardPage` 在页面组合层读取现有 `window.__TAURI__?.core?.invoke` 运行时特征。
- Tauri 客户端不向 `TopBar` 传递 `adminHref`，头像菜单不渲染“团队管理”。
- 普通浏览器继续向 `TopBar` 传递 `/admin.html`，管理入口与服务端权限不变。
- `TopBar`、管理台和服务端均未修改。

## 验证

- `npm --prefix web run lint`：通过，0 error，仅既有 warning。
- `npm run build`：通过，包含 TypeScript 类型检查与 Vite 构建。
- `git diff --check`：通过。
- Vite 浏览器双模式验证：普通浏览器保留“团队管理”，Tauri 运行时模拟隐藏该入口。

## 未验证

- 未启动真实 Tauri WebView2 安装包；本地团队服务当前不可连接。
- 全量 `npm test` 因 ACP 插件、桌面实时同步等无关用例超时被主动终止。
