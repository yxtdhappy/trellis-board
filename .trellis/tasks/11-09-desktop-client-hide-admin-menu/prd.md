# 客户端登录后隐藏团队管理入口

## Goal

Tauri 桌面客户端登录后，头像菜单中不显示“团队管理”入口；浏览器登录后的团队管理与管理员访问保持不变。

## Background

- 当前 Board 页面无条件向 `TopBar` 传入 `adminHref="/admin.html"`，因此 Tauri 客户端和浏览器都会显示“团队管理”菜单：[BoardPage.tsx](../../../web/src/pages/BoardPage.tsx:118)。
- Tauri 客户端已经通过 `window.__TAURI__?.core?.invoke` 识别桌面运行时，并只在客户端启用本地项目关联：[ProjectRail.tsx](../../../web/src/components/layout/ProjectRail.tsx:45)。
- 产品要求桌面客户端只提供日常任务协作入口，不提供团队管理入口。

## Requirements

- Tauri 桌面客户端登录后，头像菜单不出现“团队管理”。
- 普通浏览器登录后，有管理权限的用户仍显示“团队管理”，并可进入现有团队管理台。
- 客户端识别必须复用现有 Tauri 运行时特征，不新增服务端角色或权限模型。
- 本任务不改变服务端管理员权限，也不改变浏览器直接访问 `/admin.html` 的行为。

## Acceptance Criteria

- [ ] 在 Tauri 桌面客户端登录后打开头像菜单，看不到“团队管理”。
- [ ] 在普通浏览器以有管理权限的账号登录后，头像菜单仍显示“团队管理”，点击可进入 `/admin.html`。
- [ ] 无管理权限的浏览器用户行为保持现状，不因本改动额外获得团队管理入口。
- [ ] 现有前端测试和类型检查通过。

## Notes

- 这是桌面客户端 UI 范围修正，不包含服务端授权变更。
- 轻量任务保持 PRD-only。
