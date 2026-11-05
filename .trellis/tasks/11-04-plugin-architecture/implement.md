# 执行计划：插件机制设计

本任务（`11-04-plugin-architecture`）交付 `prd.md`（需求 + 技术设计合并）与 P1~P5 实现：
协议层、supervisor、SDK、DB v5、插件 API、两个内置参考插件与前端插件页。
`prd.md` 已由用户审核通过；代码已实现并通过最终检查，等待提交。

## 变更文件清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `.trellis/tasks/11-04-plugin-architecture/prd.md` | 新增 | 需求、约束、验收标准 + 技术设计（协议/权限/生命周期/存储/配置/参考插件/安全/分期/测试） |
| `.trellis/tasks/11-04-plugin-architecture/research/dsh-plugin-mechanism.md` | 新增 | 上游插件机制调研（Cordis、bundle/patch、ACP provider） |
| `.trellis/tasks/11-04-plugin-architecture/research/acp-a2a-protocols.md` | 新增 | ACP / A2A 协议事实与版本差异 |
| `.trellis/tasks/11-04-plugin-architecture/implement.md` | 新增 | 本文件 |
| `.trellis/tasks/11-04-plugin-architecture/implement.jsonl` / `check.jsonl` | 待补 | 评审通过后、`task.py start` 之前再填 |

实际修改：`server/`（plugins、index、database、actions、config、metadata、watcher）、`public/`（index、app、styles、plugins.js）、
`tests/`（plugin-*、team-release 基线修正）、`package.json`（0.2.0）、`README.md`、`data/` 运行时文件。
`agent/`、`scripts/`、`.trellis/scripts/` 未改。

## 阶段 0：文档评审（本任务）

- [x] 0.1 需求与技术设计合并进 `prd.md`，共 24 节
- [x] 0.2 结构校验：代码围栏均有语言标注、表格列数一致、围栏闭合
- [x] 0.3 评审确认第 1 节的 10 条关键决策（D1~D10）
- [x] 0.4 评审确认第 23 节的 10 个未决问题（方向见 `prd.md` §22 与实现取舍）
- [x] 0.5 补 `implement.jsonl` / `check.jsonl` 并 `task.py start`（status=in_progress）

### 验证命令

```bash
# 1) markdown 结构（围栏语言 + 表格列数 + 围栏闭合）
python3 - <<'PY'
import re, pathlib, sys
def check(p):
    lines = pathlib.Path(p).read_text().split("\n")
    errs, in_fence, table = [], False, None
    for i, line in enumerate(lines, 1):
        m = re.fullmatch(r"```([A-Za-z0-9_+-]*)", line)
        if m:
            if not in_fence:
                in_fence = True
                if not m.group(1): errs.append(f"{i}: 围栏缺少语言")
            else:
                in_fence = False
            table = None
            continue
        if in_fence: continue
        if line.strip().startswith("|"):
            cells = line.count("|")
            if table is None: table = (i, cells)
            elif cells != table[1]: errs.append(f"{i}: 表格列数不一致")
        else:
            table = None
    if in_fence: errs.append("围栏未闭合")
    return errs
bad = 0
for p in [".trellis/tasks/11-04-plugin-architecture/prd.md"]:
    e = check(p); bad += len(e)
    print(("OK   " if not e else "FAIL ") + p)
    for x in e: print("   ", x)
sys.exit(1 if bad else 0)
PY

# 2) 锚点存在性（第 24 节引用的位置）
rg -n "function handleApi|export async function createTask|export async function assignTask|export function setManualStage|export function createWatchRuntime|DATABASE_SCHEMA_VERSION|function createRequestHandler|function terminateTree|function minimalEnvironment|function repositoryPathKey" \
  server/index.js server/actions.js server/metadata.js server/watcher.js server/database.js server/team/http.js server/team/process.js server/config.js

# 3) 无本机路径泄漏
rg -n "/opt/|/home/|/Users/" .trellis/tasks/11-04-plugin-architecture/ || echo "clean"
```

### 回滚点

- 文档回滚：删除本任务目录即可，无运行时影响。
- 本任务不触碰数据库与运行时，无数据回滚需求。

## 实现结果（P1~P5）

| 阶段 | 交付 | 主要文件 | 测试 |
| --- | --- | --- | --- |
| P1 | 帧协议、错误码、版本校验 | `server/plugins/protocol.js`、`server/plugins/version.js` | `tests/plugin-protocol.test.js`（11）、`tests/plugin-version.test.js`（8） |
| P1 | supervisor、SDK、任务 facade | `server/plugins/supervisor.js`、`server/plugins/sdk.js`、`server/plugins/task-service.js` | `tests/plugin-supervisor.test.js`（11）、`tests/plugin-sdk.test.js`（7） |
| P1 | DB v5 与插件状态/审计 | `server/database.js`、`server/plugins/store.js` | `tests/plugin-store.test.js`（7） |
| P1 | `/api/plugins` 与命名空间 | `server/plugins/runtime.js`、`server/index.js` | `tests/plugin-http.test.js`（11） |
| P2 | 私有业务插件（不随仓库分发） | 本地插件目录（ignored） | 本地 fixture 测试（不入库） |
| P3 | `acp-dispatch` | `plugins/acp-dispatch/*`、`plugins/acp-dispatch/test/fixtures/fake-agent.js` | `plugins/acp-dispatch/test/index.test.js`（14） |
| P4 | `a2a-intake` | `plugins/a2a-intake/*` | `plugins/a2a-intake/test/index.test.js`（9） |
| P5 | 前端「插件」页 | `public/plugins.js`、`public/index.html`、`public/styles.css`、`public/app.js` | Playwright 验收记录 `tests/artifacts/plugin-ui.md` + 截图 `tests/artifacts/plugin-ui.png` |

### 实现取舍

- 版本双轨：`apiVersion` 整数协议版本 + `version` semver + `engines.board`（只支持 `>=`、`<=`、`^`、`~`、精确、`*`）。
- 路由冲突：插件根路径不得占用 `/`、`/api` 前缀；冲突插件标记 `blocked` 且不启动。
- 公开端点鉴权：缺少 token 返回 `401`，token 不符返回 `403`；`http.openPaths` 可声明无需 token 的只读路径（用于 A2A Agent Card）。
- 插件运行记录统一走宿主 `plugin_run`：SDK 暴露 `ctx.runs.start/progress/finish/list`，`runId = <pluginId>:<taskKey>:<attempt>`，`attempt` 由历史 run 数自增；`plugin_run` 上建有部分唯一索引 `plugin_run_active_task`，保证同一插件同一任务最多一条活动 run。插件停止或崩溃时宿主把活动 run 收敛为 `failed`。
- 私有业务插件不内置环境地址，服务前缀、页面根路径与凭据全部由配置提供。
- `acp-dispatch` 只做 ACP client；权限按 `toolCall.kind` 决策，选项只认 `options[].kind`。

### 线上冒烟

- 重启后 `GET /api/plugins` 返回两个内置插件与 `runs:read/write` 权限；`GET /api/plugins/acp-dispatch/runs` 正常返回空数组。
- 插件路由在未启动时返回 `503`，`GET /api/plugins/<id>/runs` 能读到 `plugin_run` 记录。

### 验证命令与结果

```bash
# Node 24（engines 要求；只跑仓库内测试，私有插件测试不入库）
node --test tests/*.test.js plugins/*/test/*.test.js
# 276 tests / 275 pass / 1 skipped / 0 fail

# Node 22（兼容性回归）
node --test tests/*.test.js plugins/*/test/*.test.js
# 276 tests / 275 pass / 1 skipped / 0 fail

# 文档结构 + 代码索引行号（也包含在默认套件里）
node --test tests/plugin-docs.test.js
# 2 tests / 2 pass / 0 fail

# 真实 ACP agent（默认不跑，需本机 opencode 已登录）
TRELLIS_REAL_ACP=1 node --test plugins/acp-dispatch/test/real.test.js
# 1 test / 1 pass / 0 fail

# 敏感词扫描：真实域名、平台子应用名、网关前缀、任务号、产品名、人名、内网 IP、本机路径
# 关键词表不写入仓库（避免二次泄漏）；已按审核清单逐项 grep，0 命中。
```

### 真实脚本与运行记录验证

- `tests/plugin-real-task.test.js` 用临时 Trellis 仓库 + 真实 `.trellis/scripts/task.py` 验证 `taskService.create/assign` 的参数、`prd.md`、`meta` 合并与重复创建报错；顺带修正了 `assign` 传参（`taskDir` 需为 `.trellis/tasks/<dir>`）。
- 插件测试（a2a / acp）同样复制仓库内真实 `.trellis/scripts/` 运行，不再用假 `task.py`；`server/actions.js` 在 `python` 不存在时回退 `python3`，因此测试不需要 PATH shim。
- 既有基线 `tests/team-release.test.js:139` 的 approve 500 已修复（同一 `python`/`python3` 回退问题），不再是已知失败。
- `plugins/acp-dispatch/test/index.test.js` 断言宿主 `GET /api/plugins/acp-dispatch/runs` 返回 `acp-dispatch:<taskKey>:1` 且 `status=succeeded`。

### 真实 ACP 联调

- 命令：`TRELLIS_REAL_ACP=1 node --test plugins/acp-dispatch/test/real.test.js`
- 环境：`opencode v2.2.5`，ACP 入口 `opencode acp`，`permission.default = allow`。
- 结果：1 test / 1 pass，耗时约 10–13s；插件完成 `initialize → session/new → session/prompt → end_turn`，
  `plugin_run.status = succeeded`，agent 在临时仓库写出 `REAL_ACP_OK` 且内容为 `OK`。
- 该测试默认跳过（需 `TRELLIS_REAL_ACP=1`），避免 CI 真实调用模型；入口保留在 `plugins/acp-dispatch/test/real.test.js`。

### watcher 阶段推进

- `plugins/acp-dispatch/test/index.test.js` 新增用例：任务预置 `prd.md`（含 `## Requirements` / `## Acceptance Criteria`）、`research/`、`design.md`、`implement.md`、`implement.jsonl`、`check.jsonl`，`derivedStage = implement`；
  fake agent 在 `session/prompt` 时写入 `check-report.md`（`npm test: 261 pass`），`createWatchRuntime` 收到文件事件后重扫，`derivedStage` 推进到 `spec`。
- 该用例同时验证 `FAKE_ACP_WRITE_FILE` / `FAKE_ACP_WRITE_CONTENT` 的 agent 产物写入路径。

### 插件页 Playwright 验收

- 环境：standalone `http://127.0.0.1:4317/`，视口 1440x1080，浏览器 Chromium。
- 步骤：打开首页 → 点击「插件」→ 等待 `.plugin-card` → 读取内置插件卡片 → 点击 `acp-dispatch` 的「日志」→ 读取 `#plugin-logs` → 截图。
- 结果：`a2a-intake` / `acp-dispatch` 均显示「运行中」、`v1.0.0`、`api 1`、`pid`；日志 2 行，含「启动插件进程」与「acp-dispatch 已启动」。
- 记录与截图：`tests/artifacts/plugin-ui.md`、`tests/artifacts/plugin-ui.png`。
- `/api/runtime` 404 是 standalone 的预期回退，不影响插件页。

### 验证范围决策记录

- 2026-11-04 用户通过结构化提问确认：本轮验证范围为 **只跑 fixture 单测**，不连接真实平台、不需要真实凭据；
  实现范围 **P1~P5 全量**；执行方式 **一路做完再汇报**。该决定是本轮不执行 `prd.md` §18.12 真实账号导入与 §21 P3 真实 ACP agent 端到端的原因。
- 记录位置：本文件；对应 goal `mw1xqm9r-kjaxqz` 的任务清单与用户确认。
- 后续如需要真实联调，按下方“已知限制”中的手动入口执行，不需要改代码。

### 已知限制

- 私有业务插件不在仓库内，联调由本地维护者执行，不进入公开测试与文档。
- ACP 已用真实 `opencode acp`（v2.2.5）跑通 `plugins/acp-dispatch/test/real.test.js`；Cursor / Claude / Codex 适配器未逐一验证，但它们走同一 ACP 协议，差异只在 `command` / `args` 与权限选项。
  其他 agent 的验证方式：在 `data/plugins.json` 把 `acp-dispatch.command` 指向已安装的 ACP 入口，
  给任务写入 `meta.agent` 并 `task.py start`，观察 `GET /api/plugins/acp-dispatch/runs` 与 watcher 阶段推进。
- 插件无沙箱：ACP agent 的 `session/request_permission` 是协商不是强制，默认放行编辑与执行，只应在受信仓库启用。
- 代码待提交；提交后按 Trellis 流程归档任务并记录 journal。

## 最终检查（2026-11-05）

- 插件测试已按插件归位：`plugins/a2a-intake/test/`、`plugins/acp-dispatch/test/`；共享 harness 仍在 `tests/helpers/`。
- 新增 `tests/plugin-secrets.test.js`，覆盖 `secret:` 引用、0600 权限、缺失密钥与脱敏。
- 新增 `.trellis/spec/backend/plugin-testing.md`，把协议契约、插件功能、真实组合分层，并加入 `.trellis/spec/backend/index.md`。
- witops 导入命名回到「平台 `code` 优先」：有 `code` 用 `T/R/B/W` 编号，没有 `code` 回退 `witops-<type>-<id>`；宿主只校验 slug 与日期前缀，不内置平台前缀规则。
- `npm test`：276 tests / 275 pass / 1 skipped / 0 fail。
- `task.py validate`：通过；仅提示 `prd.md` 超过 32 KiB 注入上限（会截断，不阻断）。
