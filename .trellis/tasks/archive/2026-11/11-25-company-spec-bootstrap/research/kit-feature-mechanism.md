# 调研：为什么用 Trellis-kit 可选组件，而不是 Board 插件

## 1. 需求

初始化能力必须可开关：

- 启用：初始化时按项目类型检测并套用公司规范文件。
- 未启用：不检测、不套用、不写公司规范标记，初始化行为与现在一致。

用户明确要求“做成一个插件”，并选择“Trellis-kit 可选组件”形态。

## 2. Board 插件现状（否决依据）

- Board 插件目录是 `plugins/<id>/{plugin.json,index.js,panel/,test/}`；现有内置插件：`witops-core`、`scenario-copilot`、`jenkins-ops`、`accounts-core`、`acp-dispatch`、`a2a-intake`。
- `plugins/README.md:3`：standalone 模式已降级；生产 Team 服务器默认屏蔽插件；内置插件主线目标为桌面 EXE 本机插件宿主；`plugin.json` 应极简、`targets:["desktop"]`。
- `.trellis/spec/backend/plugin-runtime.md:6`：Team 服务端固定关闭插件（`teamPluginsEnabled()` 恒 false）；插件只随桌面 EXE 或独立 `plugin-host/host.mjs` 运行。
- 插件是独立子进程，stdin/stdout NDJSON JSON-RPC；能力清单（`plugin-runtime.md:246-257`）只有生命周期、任务读写、运行记录、事件、store、HTTP、定时器、日志、配置、清理、secrets；**没有文件系统能力、没有项目初始化钩子**。
- 宿主事件只有 `scan.completed`、`task.assigned`、`task.stage.changed`（`plugin-runtime.md:116`），没有 `project.initialized`。
- 桌面初始化走 Rust 直接调用 CLI（`onboarding.rs:490-546`），不经过插件宿主；插件无法拦截 init，也无法写目标仓库文件。
- 桌面插件宿主懒启动：没有 enabled 插件时直接返回；`plugin-state.json` 只存 `enabled/sort`（`plugin_host.rs:414-436`）。

结论：要把初始化做成 Board 插件，必须新增 `project.init` 事件、文件系统能力、宿主/Rust 钩子和权限模型；改动面和攻击面都远大于收益，因此否决。

## 3. Trellis-kit 现状

- `trellis-kit/manifest.json` v0.3.4：`components` 数组，所有组件由 `apply.py` 无条件复制；没有 `optional`/`enabled`/按组件选择字段。
- `trellis-kit/apply.py` 只有 `--target`、`--platform`、`--dry-run`、`--force`、`--agent-only`；主循环对每个 component 复制（`apply.py:176-190`），最后写 `.trellis/.kit-version`（`apply.py:238-253`）。没有按组件启停开关。
- `apply_kit_overlay` 在 `trellis init` 之后执行（`onboarding.rs:524-529`），因此 kit 不能直接影响 init 参数，除非桌面端在 init 前读取 kit 配置。
- `build.rs` 的 `walk_kit` 递归收集 `trellis-kit/`（跳过 `__pycache__`/`.git`），新增 `features/` 文件会自动嵌入，无需改资源清单。
- `kit_assets::ensure_kit` 按「客户端版本 + 内容戳」释放到 `%LOCALAPPDATA%\TrellisBoard\runtime\kit\<version>\<stamp>`；新增文件会改变内容戳，升级后旧目录自然失效。

## 4. 桌面配置/UI 现状

- `packages/desktop/src-tauri/src/config.rs`：`ClientConfig { schema_version:3, server_url, username, password, node_runtime, trellis_runtime, python_runtime }`，`data_dir()` = `%LOCALAPPDATA%/TrellisBoard/data`，`config_path()` = `client.json`；无 feature/settings 字段。
- `packages/web/src/features/settings/PreferencesDialog.tsx` 只有主题/字体/通知等外观设置，走 `useAppearance`，不适合放公司规范开关。
- `packages/web/src/lib/project-inspection.js:9-32` 的 `normalizeProjectInspection` 同时接受 `{project}` 包装或裸 project，未知顶层字段忽略；可在不破坏旧逻辑的前提下增加 `companySpec`。
- `main.rs:541-563 inspect_local_project` 调 `agent_service::inspect_project` 并返回 `{ok, project}`；`main.rs:565-584 initialize_pending_project` 参数为 `developer_id`/`agent_tools`；`agent_service.rs:1097 trellis_kit_root` 解析 kit（`TRELLIS_KIT_ROOT` → `kit_assets::ensure_kit` → resource dir → exe 同级 → 开发路径）；`agent_service.rs:1126-1150` 组装 `InitializeOptions`。

## 5. 选定方案

把公司规范初始化做成 trellis-kit 的可选 feature：

1. `features/company-spec/feature.json`：registry 地址、项目类型→模板 ID 映射、`enabledByDefault`。
2. `manifest.json` 注册 `kind:"feature"` 组件；`apply.py --feature company-spec` 只校验/记录，不复制文件。
3. 桌面端在 init 前读取 feature；FullInit 且选择为 `auto` 或具体模板时检测/传参，选择 `none` 则跳过。
4. init 后校验 `.company-spec.json` + 入口；通过才把 feature 传给 `apply.py`，写入 `.kit-version.features`。
5. 初始化弹窗显示下拉选择（自动识别 / 具体模板 / 不套用），默认取 `enabledByDefault`；选“不套用”则本次不套用。

这样“feature 启用 = 走公司规范逻辑；不启用 = 完全不套用”，且不改变 Board 插件运行时和权限模型。

## 6. 关键取舍

- **feature 文件随 kit 发版**：改 registry 地址/默认开关要发版；改模板内容不需要。可接受。
- **`--feature` 追加语义**：没有 `--feature` 时保留已有 features，避免重新 attach 时抹掉记录；MVP 不提供停用已有项目的入口。
- **verify 后再记录 feature**：CLI 下载失败会回退空白 spec 且退出码 0；必须以 marker 为准，避免 `.kit-version` 记录一个实际没套用的 feature。
- **不删除原生空白 spec**：`trellis init` 总会生成 `.trellis/spec/frontend|backend` 空白模板；feature 关闭只表示不套用公司规范。若要求连空白骨架也不生成，需要改上游 Trellis，MVP 不做。

## 7. 确认结果

- registry 落点：已创建 `prod-mdp/weint-dev-specs`，使用 SSH 地址；`weint-spec-board` 是产品仓库，不能直接作为 registry。详见 `registry-verification.md`。
- `enabledByDefault` 首批默认值：`false`。
- 已有项目补套/更新/换模板：**本期做**，不延后；停用/删除本期不做。
