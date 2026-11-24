# 技术设计：修复管理后台与插件视图对齐、状态色与响应缺陷

## 1. 状态色映射规范（`lib/admin-shared.ts`）

将 `TONE_BY_STATUS` 明确作为**原始英文枚举键**映射表，严禁传入中文翻译文本或自由分支名：
- `success`: `current`, `active`, `approved`, `success`, `running`
- `warning`: `stale`, `pending`, `warning`, `retired`, `starting`, `missing-secret`
- `info`: `syncing`, `importing`, `indexing`
- `destructive`: `needs_repair`, `failed`, `error`, `index_error`, `rejected`, `revoked`, `disabled`, `crashing`, `incompatible`

## 2. 管理后台统一组件规范

1. **Panel 头部 `action` 按钮**：除有特殊需要外，统一使用默认/一致尺寸且不单独使用 `rounded-full`。
2. **表单提交按钮**：全后台表单（`ProjectsTab`、`ArchiveSyncTab`、`UsersTab`、`AccountForm`、`PluginBindingForm`、`DevicesTab`）统一采用默认 `h-8` + `self-start`，取消/辅助按钮同排 `items-center` 且同为 `h-8`。
3. **列表行内操作**：`Row` 内置次级动作按钮统一 `variant="ghost" size="sm"`（删除/停用/移除/移出加 `text-destructive`），展开详情区域避免撑高单行造成右侧按钮垂直漂浮。

## 3. `PluginPanel.tsx` 主题热同步架构

- 将原先混在一个 `useEffect(..., [desktop, panel, theme, projectId, projectName])` 中的连接生命周期与主题/项目上下文同步拆分：
  1. **连接 effect**：仅依赖 `[desktop, panel, projectId]`，负责建立与清理 `EventSource`、监听 `load`/`message` 握手并记录 `readyRef` 与最新 `postInit()` 回调；
  2. **同步 effect**：依赖 `[theme, projectName]`，当 `readyRef.current === true` 且 iframe `contentWindow` 可达时，直接发送 `init` / 主题 Token 更新消息，不重连 `EventSource`。

## 4. 文件范围

- `packages/web/src/pages/admin/AdminPage.tsx`
- `packages/web/src/lib/admin-shared.ts`
- `packages/web/src/features/admin/{ArchiveSyncTab,ArchiveSyncTaskSpaceRow,AuditTab,BranchManagementPanel,DevicesTab,PluginsTab,PluginBindingForm,ProjectsTab,TeamsTab,TeamSwitcher,UsersTab,AccountForm,shared}.tsx`
- `packages/web/src/features/plugins/{DesktopPluginsView,PluginPanel}.tsx`
