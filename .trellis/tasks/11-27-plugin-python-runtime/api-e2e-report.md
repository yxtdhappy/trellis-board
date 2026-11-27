# API E2E 报告

- 任务：`11-27-plugin-python-runtime`
- 结论：**not applicable**
- 原因：本次改动只涉及本地 Python 解释器解析（`packages/server/python.js`、插件宿主环境注入、
  Rust 环境门/桌面导航）与面板错误提示，没有新增或修改任何 HTTP 路由、请求/响应结构或鉴权契约。
  唯一涉及的插件下发链路仍是既有 `POST /api/plugins/witops-core/dispatch`，其响应结构未变，
  只是失败项在原有 `status/reason` 之外补了可选 `code` 字段。
- 替代验证（均已真实运行）：
  - `PYTHON=python3 TRELLIS_PYTHON=python3 yarn test --scope=all` → 962 pass / 0 fail / 3 skip。
  - `PYTHON=python3 TRELLIS_PYTHON=python3 yarn test --scope=scripts --file=task-check-binding` → 11/11 pass。
  - `TRELLIS_PYTHON=python3 yarn test --scope=server --file=plugin-real-task` → 3/3 pass（含坏解释器回退）。
  - `TRELLIS_PYTHON=python3 yarn test --scope=plugins --file=index.test.js` → 98/98 pass。
  - `yarn test --scope=rust` → 448 pass / 8 fail（与改动前基线相同的 Windows-only 断言）。
- 未覆盖：Windows 实机 PATH 中的 0 字节 `python.exe` 场景需要真机手工验收（`implement.md` 第 8 步）。
