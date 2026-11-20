# a2a-intake

通过 A2A JSON-RPC 接收消息并创建 Trellis 任务，同时以标准 capability 桥接宿主能力。

## 零配置

- `plugin.json` 的 `config` 为空；首次启动自动生成 24 字节本地 Bearer Token 并持久化到插件 store。
- `/a2a` 由插件自身校验 `Authorization: Bearer <token>`；面板「A2A 接入」可复制地址与 Token。
- `repositoryId` / `defaultAssignee` 缺省从 `trellis.projects` 推导（负责人读 `.trellis/.developer`）。
- 桌面宿主在 loopback 根路径暴露 `/a2a` 与 `/.well-known/agent-card.json`。
