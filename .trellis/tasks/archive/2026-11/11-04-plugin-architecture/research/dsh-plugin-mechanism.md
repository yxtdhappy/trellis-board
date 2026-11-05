# DeepSeek Harness 插件机制（调研）

调研时间：2026-11-04。来源分两类：上游开源仓库 `deepseek-ai/deepseek-harness`（版本 `0.2.1-rc.2`）
的源码与文档，以及公开文档。下文出现的 `docs/`、`packages/`、`vendor/` 路径均指该上游仓库内的路径。

## 1. 内核模型

- 内核是 **Cordis**（`vendor/cordis/`，包名 `@deepseek-ai/cordis`），"一切皆插件"。
  `docs/architecture.md`：*"plugins contribute services, typed events, and reversible
  effects to a shared context"*。
- 插件形状（`docs/user/develop/basic/index.md`）：

  ```ts
  export const name = "hello-plugin";
  export function apply(ctx: Context) { /* 注册能力 */ }
  ```

  `inject: ['tools']` 声明依赖，Cordis 等服务可用后才 `apply`。
- `ctx` 是服务容器：`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.agents`、`ctx.systemPrompt`
  （`docs/architecture.md` 的 Core packages 表）。
- 注册即 effect：`ctx.effect(() => dispose)`；卸载时自动回滚（教程 "Automatic cleanup"）。
- 事件是扩展点：session events（持久）、agent events（`agent/*`）、capability events
  （`fs/*`、`tools/*`、`telemetry/*`）。

## 2. 组合与清单

- 启动时从空插件树开始，按层叠顺序装配：profile → bundle → `cordis.patch.yml` → home patch
  → `--patch` 覆盖（`docs/architecture.md` "Profiles and bundles"）。
- patch 按 `id` 命中行，**替换整行 config**；`insert` 追加新行。示例见
  `packages/bundle/base/cordis.patch.yml`（`- insert:` + `id`/`name`/`config`/`disabled`）。
- `package.json` 的 `dsh` 字段声明：`dsh.bundle.patch` 指向 bundle 的 patch 文件，
  `dsh.profile.bundles` 列出 profile 的 bundle 顺序
  （`packages/bundle/acp-app/package.json`）。
- 运行形态：`web` / `headless` / `sdk` / `sdk-minimal` / `acp`，`dsh --profile <name>`。

## 3. 插件管理器

`packages/boot/plugin-manager/README.md`：

- `inspect(spec)` 预检（registry / 本地路径 / git），返回 `problem` 分类
  （`invalid-spec`、`already-installed`、`not-found`、`not-a-bundle`、`network`…）。
- `installBundle` 用 pnpm 安装，失败恢复 `package.json` / `pnpm-lock.yaml`；
  安装前做 engines / peerDependencies 兼容校验。
- 开关只改 `disabled`：写回 profile patch 的最后一条匹配覆盖，或追加一条；与 bundle 默认值
  相同则删除该覆盖。
- 构建脚本审批（pnpm 11）单独走 `approvedBuilds`，不随安装自动授权。
- 结论：这套"预检 + 开关 + 兼容校验"值得借鉴，但 pnpm 安装器与 trellis-board 的
  零依赖部署形态冲突，不照搬。

## 4. 与 ACP 相关的两个包

- `packages/acp/acp`（`dsh-acp`）：`dsh --profile acp` 启动 **ACP server**，stdio JSON-RPC，
  支持 create/resume session、选模型与 reasoning effort、挂 MCP、提交/取消任务、收语义更新。
  `packages/bundle/acp-app/README.md`：stdout 只用于 newline-delimited ACP JSON-RPC 帧。
- `packages/subagent/subagent-acp`（`dsh-subagent-acp`）：**ACP client**，每次 run 起一个新
  子进程，配置项：

  | 字段 | 默认 | 含义 |
  | --- | --- | --- |
  | `providerName` | `acp` | 注册到 `ctx.subagents` 的名字 |
  | `command` | 必填 | 子 agent 可执行文件 |
  | `args` | `[]` | 参数，例如 `['--profile','acp']` |
  | `permission` | `reject` | 自动回答权限请求：拒绝，或选第一个 `allow_once` / `allow_always` |
  | `env` | `{}` | 在"已擦除凭证的父环境"上叠加 |
  | `disposeEofGraceMs` | `6000` | stdin EOF 后的宽限 |
  | `disposeGraceMs` | `3000` | 软终止到强制终止的宽限 |

  这段配置形状直接启发了 trellis-board 的 `acp-dispatch` 插件设计。

## 5. 对 trellis-board 的取舍

借鉴：

- `apply(ctx)` + `inject` 的能力注入形状；
- 注册即 effect、卸载自动回滚；
- 事件作为扩展点（领域事件而非通用 hook）；
- 按 `id` 覆盖配置、`disabled` 开关、预检与版本校验。

不借鉴：

- Cordis 的 proxy/fiber 内核（对单进程小项目过重）；
- pnpm 在线安装、HMR（破坏"拷目录就能跑"）；
- "插件完全信任"（trellis-board 要声明式权限）。

## 6. 参考链接

- https://github.com/deepseek-ai/deepseek-harness
- `docs/architecture.md`、`docs/user/develop/basic/index.md`、`docs/capability-seams.md`
- https://deepseekdocs.com/en/docs/learn/core/plugin-anatomy
- https://martianlee.github.io/posts/2026-09-05-deepseek-harness-architecture
