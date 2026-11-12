# Design: 接入本地项目 dialog 即时弹出

## 时序对比

改造前：

```
click ──▶ invoke('inspect_local_project')
          ├─ blocking_pick_folder()   (用户选目录，无 UI 反馈)
          ├─ sidecar inspect_project  (读 git，数秒)
          └─ 返回 ──▶ setOnboardingOpen(true) ──▶ 表单直接出现
```

改造后：

```
click ──▶ invoke('pick_local_project_folder') ──▶ path
          └─▶ setOnboardingOpen(true)  (立即)
                 └─ 弹窗 skeleton
                       └─ invoke('inspect_local_project', { path })
                              └─ 数据返回 ──▶ 表单 / 错误态
```

## Rust 改动（`desktop/src-tauri/src/main.rs`）

新增命令，紧邻现有 `inspect_local_project`（`:389`）：

```rust
#[tauri::command]
async fn pick_local_project_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    ensure_board_caller(&app, &window)?;
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|error| format!("无法读取所选目录：{error}"))?;
    if !path.is_dir() {
        return Err("请选择 Git 仓库根目录，而不是文件。".to_string());
    }
    Ok(Some(path.to_string_lossy().to_string()))
}
```

`inspect_local_project` 改为：

```rust
#[tauri::command]
async fn inspect_local_project(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请选择 Git 仓库根目录。".to_string());
    }
    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return Err(format!("所选目录不存在或不是文件夹：{trimmed}"));
    }
    // 清理旧 pending → sidecar::inspect_project(&app, &root.to_string_lossy(), &config::agent_root()).await?
    // → 写入 pending_project_path → Ok(inspected)
}
```

要点：

- `blocking_pick_folder()` 保持现有调用方式（原实现已在 async 命令里这样用，不要改成事件回调式）。
- 顺序保持不变：**先清 pending 再 inspect**，避免 inspect 失败时残留上一个路径。
- 命令注册：`main.rs:853` 的 `tauri::generate_handler![...]` 增加 `pick_local_project_folder`。
- `inspect_local_project` 返回值类型由 `Result<Option<Value>, String>` 变为 `Result<Value, String>`；前端是唯一调用方（`ProjectRail.tsx`），同步改。

## 权限改动

`desktop/src-tauri/permissions/desktop.toml`，紧跟 `allow-inspect-local-project`：

```toml
[[permission]]
identifier = "allow-pick-local-project-folder"
description = "当前 Board origin 可选择本地 Git 仓库根目录，仅返回路径，不读取仓库内容。"
commands.allow = ["pick_local_project_folder"]
```

`desktop/src-tauri/capabilities/board-local-association.json` 的 `permissions` 数组追加 `"allow-pick-local-project-folder"`（与 `allow-inspect-local-project` 同组，都是 Board origin 的本地项目接入链路）。

## 前端改动

### `web/src/components/layout/ProjectRail.tsx`

- 状态：`onboardingProject` → 改为 `onboardingPath: string | null`。
- `startProjectOnboarding()`：

```ts
if (!invoke || inspectingProject) return
setAssociationError('')
setInspectingProject(true)
try {
  const path = await invoke<string | null>('pick_local_project_folder')
  if (!path) return
  setOnboardingPath(path)
  setOnboardingOpen(true)
} catch (error) {
  setAssociationError(associationErrorMessage(error))
} finally {
  setInspectingProject(false)
}
```

- 渲染传参：`<ProjectOnboardingDialog open onOpenChange path ... />`（去掉 `inspection`）。

### `web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`

- props：`path: string | null` 取代 `inspection`；其余（`teams`/`defaultTeamId`/`defaultDeveloperId`/`invoke`/`onAssociated`）不变。
- 内部态：`loading`、`inspection`（normalize 后的对象）、`loadError`、`reloadToken`。
- 检查 effect：

```ts
useEffect(() => {
  if (!open || !path) return
  let cancelled = false
  setLoading(true); setLoadError(null); setInspection(null)
  void invoke('inspect_local_project', { path })
    .then((raw) => { if (cancelled) return
      const normalized = normalizeInspection(raw)
      if (!normalized) setLoadError('所选目录不是受支持的 Git 仓库（需要 Git 仓库并配置了远端分支）。')
      else setInspection(normalized) })
    .catch((error) => { if (!cancelled) setLoadError(messageOf(error)) })
    .finally(() => { if (!cancelled) setLoading(false) })
  return () => { cancelled = true }
}, [open, path, reloadToken, invoke])
```

- 渲染分支顺序：`loading` → skeleton；`loadError` → 错误块；`inspection == null` → 同错误块；否则现有完整表单（原 JSX 不动）。
- skeleton 用 `animate-pulse rounded bg-muted` 的内联 `div`（不新增 `components/ui/skeleton.tsx`），宽度按原 `dl` 两列布局排版，保证加载完成后布局不跳。
- `handleOpenChange`：`busy` 时维持阻塞；`loading` 时允许关闭，并在关闭时 `void invoke('cancel_pending_project')` 清 pending。关闭后重置 `inspection/loadError/loading`。
- 错误块：「重试」按钮 → `setReloadToken(t => t + 1)`；「取消」→ 关闭。

## 测试

- `tests/desktop-package.test.js`：保持既有断言（`allow-inspect-local-project` 的 `commands.allow = ["inspect_local_project"]` 不变），新增：
  - `desktop/src-tauri/permissions/desktop.toml` 含 `pick_local_project_folder`；
  - `web/src/components/layout/ProjectRail.tsx` 调用 `pick_local_project_folder` 且不再把 `inspect_local_project` 结果作为开窗条件；
  - `web/src/features/board/dialogs/ProjectOnboardingDialog.tsx` 含 `inspect_local_project` 调用与 `loading` skeleton 标记。
- Rust 侧不为命令加单测（命令体是 IO 编排）；`cargo test` 保证既有单测不回归。

## 验证

1. `cargo test --manifest-path desktop/src-tauri/Cargo.toml`、`npm test`。
2. `cargo run --manifest-path desktop/src-tauri/Cargo.toml`（本地无 `cargo tauri` CLI，用 `cargo run` 起 debug 版）→ 登录 → Board → 接入本地项目，观察：选完目录即出弹窗 + skeleton。
3. 制造慢检查：选一个远端不可达的仓库，确认弹窗先出现、可取消。
4. 失败路径：选一个普通（非 git）目录，确认错误文案 + 重试。
