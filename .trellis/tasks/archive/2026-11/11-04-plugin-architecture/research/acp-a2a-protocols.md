# ACP 与 A2A 协议事实（调研）

调研时间：2026-11-04。仅记录与 trellis-board 插件设计相关的部分：传输、方法名、状态与版本差异。

## 1. 三个容易混淆的缩写

| 缩写 | 全称 | 提出方 | 解决什么 | 传输 |
| --- | --- | --- | --- | --- |
| **ACP** | Agent Client Protocol | Zed Industries，社区维护 | 编辑器/IDE ↔ 编码 agent | JSON-RPC 2.0 over stdio |
| **ACP** | Agent Communication Protocol | IBM BeeAI 发起，已并入 A2A 项目 | agent ↔ agent | REST over HTTP |
| **A2A** | Agent2Agent Protocol | Google 发起，现由 A2A 项目托管 | 独立 agent 系统互通 | JSON-RPC 2.0 / REST / gRPC |

本设计里提到 ACP 时一律指 **Agent Client Protocol**（编辑器侧），与 A2A 是两套东西。

## 2. Agent Client Protocol（ACP）

- 消息模型：JSON-RPC 2.0，方法（请求-响应）+ 通知（单向）。请求 id 必须是字符串。
- 传输：stdio，newline-delimited JSON；与 MCP 复用类型，便于集成。
- 典型流程：

  | 步骤 | 方向 | 方法 |
  | --- | --- | --- |
  | 初始化 | Client → Agent | `initialize`（协商协议版本与能力） |
  | 认证（可选） | Client → Agent | `authenticate` |
  | 新建/恢复会话 | Client → Agent | `session/new` / `session/load` |
  | 提交提示词 | Client → Agent | `session/prompt` |
  | 流式更新 | Agent → Client | `session/update` 通知 |
  | 工具授权 | Agent → Client | `session/request_permission` |
  | 结束 | Client → Agent | `session/close` / 取消 |

- `session/prompt` 返回 `stopReason`（`end_turn` / `max_tokens` / `cancelled` / `refusal`）。
- `session/update` 的 `sessionUpdate` 变体包括 `agent_message_chunk`、`tool_call`、
  `tool_call_update`、`plan`、`available_commands_update`。
- 权限请求的选项由 agent 给出（`allow_once` / `allow_always` / `reject_once` /
  `reject_always`），客户端按策略回答；无人值守场景通常固定为拒绝或选第一个 allow。

对 trellis-board 的意义：`acp-dispatch` 插件就是 ACP **client**，按任务起一个 agent 进程，
把 PRD 摘要作为 prompt 发过去，消费 `session/update` 只用于观测，最终结果仍以仓库文件变化为准。

## 3. Agent2Agent Protocol（A2A）

- 发现：Agent Card 发布在站点根路径 `GET /.well-known/agent-card.json`；部分早期客户端探测
  `/.well-known/agent.json`，两个路径返回相同内容作为兼容。
- 调用：JSON-RPC 2.0，`POST /a2a`（或 REST/gRPC 绑定）。

  | v0.3 方法 | v1.0 方法 | 说明 |
  | --- | --- | --- |
  | `message/send` | `SendMessage` | 发送消息，返回 `Task` 或 `Message` |
  | `message/stream` | `SendStreamingMessage` | SSE 流式 |
  | `tasks/get` | `GetTask` | 查询任务状态、产物、历史 |
  | `tasks/cancel` | `CancelTask` | 取消 |
  | `tasks/pushNotificationConfig/*` | — | 推送通知配置 |

- `Task` 状态：`submitted`、`working`、`input-required`、`completed`、`canceled`、`failed`、
  `rejected`、`auth-required`、`unknown`。
- 消息由 `parts` 组成（`text` / `file` / `data`），产物放在 `artifacts`。

对 trellis-board 的意义：`a2a-intake` 插件是 A2A **server**，`message/send` 落成 Trellis 任务，
把 `taskKey` 当作 A2A `taskId` 返回；`tasks/get` 用看板缓存映射状态。方法名两套都接，避免客户端
版本差异导致不可用。

## 4. 与本设计的关系

- A2A 决定入站插件必须能占用根路径（`/.well-known/agent-card.json`、`/a2a`），因此需要
  `http:root` 权限与冲突检查。
- ACP 决定出站插件是"每次 run 一个子进程"的模型，因此需要 run 幂等键、硬超时、idle 超时与
  权限策略配置。
- 两者都用 JSON-RPC 2.0，插件宿主协议沿用同一套错误码语义，降低实现成本。

## 5. 参考链接

- https://agentclientprotocol.com/get-started/introduction
- https://agentclientprotocol.com/protocol/v2/overview
- https://a2a-protocol.org/latest/specification/
- https://a2a-protocol.org/latest/whats-new-v1/
- https://github.com/a2aproject/A2A
- https://www.ibm.com/think/topics/agent-communication-protocol
