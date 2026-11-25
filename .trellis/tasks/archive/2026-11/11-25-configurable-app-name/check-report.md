---
mode: inline-self-check
agent: main-session
session: a4ec1741-f2b9-406d-9d42-197f6d098033
commit: ""
---

# Check Report: 应用与页面名称支持环境变量配置

## 检查范围与结论

- **去硬编码检查**：确认 HTML 模板（`{{APP_NAME}}`）、前端 JS/TSX（`app-name.js`、`BoardPage`、`AdminPage`、`LoginPage`、`LoginApp`、`TopBar`、`TrellisLogo`）、服务端（`config.js`、`common.js`、`context.js`）、桌面端（`tauri.conf.json`、`build.rs`、`main.rs`、`tray.rs`、`update.rs`、`agent_service.rs`）及打包脚本均不再硬编码品牌文案，统一从 `TRELLIS_BOARD_APP_NAME` / `.env` 获取或由服务端运行时下发。
- **Spec 合规**：已同步更新 `.trellis/spec/desktop/tauri-commands/index.md`；`main.rs` 行数 1160 ≤ 1200，无新增内联 `mod tests`。
- **独立校验说明**：本会话在 inline 模式下完成自检，尚未提交代码；归档前如需通过 `task.py verify --strict`，需由任务负责人确认 `meta.check_override` 或执行独立 check。
