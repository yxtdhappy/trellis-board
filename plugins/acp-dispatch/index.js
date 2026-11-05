import { createPlugin } from "../../server/plugins/sdk.js";
import { AcpClient } from "./acp-client.js";

const PLUGIN_ID = "acp-dispatch";

const DEFAULTS = {
  agent: "opencode",
  command: "",
  args: [],
  cwd: "",
  env: {},
  repositoryId: null,
  permission: {
    default: "allow",
    byKind: { delete: "deny", fetch: "deny", switch_mode: "deny" }
  },
  runTimeoutMs: 30 * 60_000,
  idleTimeoutMs: 10 * 60_000,
  maxConcurrent: 1,
  retryFailed: false,
  rerunSucceeded: false,
  promptTemplate: null
};

const DEFAULT_PROMPT = [
  "请执行 Trellis 任务 {relativeDir}（{title}）。",
  "仓库目录：{cwd}。",
  "先阅读 .trellis/tasks/{relativeDir}/prd.md 与同目录下的 implement.md / check.jsonl，",
  "按其中的验收标准实施改动并运行相关测试，最后给出改动摘要与验证结果。"
].join("\n");

function normalizeConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    args: Array.isArray(raw.args) ? raw.args.map(String) : DEFAULTS.args,
    env: raw.env && typeof raw.env === "object" ? raw.env : {},
    permission: {
      ...DEFAULTS.permission,
      ...(raw.permission || {}),
      byKind: { ...DEFAULTS.permission.byKind, ...(raw.permission?.byKind || {}) }
    }
  };
}

function renderPrompt(template, task) {
  const relativeDir = task.relativeDir ?? task.taskKey?.split("::")[1] ?? task.taskKey;
  const cwd = task.projectPath ?? "";
  return String(template)
    .replaceAll("{taskKey}", task.taskKey)
    .replaceAll("{title}", task.title ?? "")
    .replaceAll("{relativeDir}", relativeDir)
    .replaceAll("{cwd}", cwd);
}

export default createPlugin({
  name: PLUGIN_ID,
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["tasks:read", "store", "events", "http:route", "runs:read", "runs:write"],

  async onStart(ctx) {
    const config = normalizeConfig(ctx.config);
    if (!config.command) {
      ctx.log.warn("acp-dispatch 未配置 command，插件保持空闲");
    }

    const active = new Map();
    const queue = [];
    let running = 0;
    let discoveryTimer = null;
    let stopped = false;

    const promptTemplate = config.promptTemplate || DEFAULT_PROMPT;
    const sessionKey = (taskKey) => `session:${taskKey}`;

    async function shouldDispatch(task) {
      if (active.has(task.taskKey)) return false;
      const [previous] = await ctx.runs.list({ taskKey: task.taskKey, limit: 1 });
      if (!previous) return true;
      if (["queued", "starting", "running"].includes(previous.status)) return false;
      if (previous.status === "succeeded") return config.rerunSucceeded;
      return config.retryFailed;
    }

    function enqueue(task) {
      if (active.has(task.taskKey)) return false;
      if (queue.some((item) => item.taskKey === task.taskKey)) return false;
      queue.push(task);
      drain();
      return true;
    }

    async function drain() {
      while (!stopped && running < config.maxConcurrent && queue.length) {
        const task = queue.shift();
        running += 1;
        execute(task)
          .catch((error) => ctx.log.error("任务执行异常", { taskKey: task.taskKey, message: error.message }))
          .finally(() => {
            running -= 1;
            drain();
          });
      }
    }

    async function discover() {
      if (!config.command) return { dispatched: 0, skipped: "no-command" };
      const tasks = await ctx.tasks.list({
        repositoryId: config.repositoryId ?? undefined,
        status: "in_progress",
        agent: config.agent
      });
      let dispatched = 0;
      for (const task of tasks) {
        if (!(await shouldDispatch(task))) continue;
        if (enqueue(task)) dispatched += 1;
      }
      return { dispatched, scanned: tasks.length };
    }

    async function execute(task) {
      const cwd = config.cwd || task.projectPath || process.cwd();
      const started = await ctx.runs.start({
        taskKey: task.taskKey,
        request: { agent: config.agent, command: config.command, cwd }
      });
      if (!started.started) {
        ctx.log.info("任务已有活动 run，跳过", { taskKey: task.taskKey, runId: started.runId });
        return;
      }
      const runId = started.runId;
      const startedAt = new Date().toISOString();
      const record = {
        runId,
        pluginId: PLUGIN_ID,
        taskKey: task.taskKey,
        status: "running",
        agent: config.agent,
        command: config.command,
        cwd,
        startedAt,
        finishedAt: null,
        stopReason: null,
        error: null,
        decisions: [],
        updates: 0
      };
      active.set(task.taskKey, { runId, client: null, record, lastProgressAt: 0 });
      ctx.log.info("开始派发", { taskKey: task.taskKey, runId, cwd });

      const client = new AcpClient({
        command: config.command,
        args: config.args,
        cwd,
        env: config.env,
        permission: config.permission,
        runTimeoutMs: config.runTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        log: (level, message, fields) => ctx.log[level]?.(message, fields),
        onUpdate: (update) => {
          record.updates += 1;
          const now = Date.now();
          const slot = active.get(task.taskKey);
          if (!slot || now - slot.lastProgressAt < 1000) return;
          slot.lastProgressAt = now;
          ctx.runs
            .progress(runId, {
              result: { lastUpdate: update.sessionUpdate ?? null, updateCount: record.updates }
            })
            .catch(() => {});
        }
      });
      active.get(task.taskKey).client = client;

      let status = "failed";
      let error = null;
      try {
        client.start();
        await client.initialize();
        const attempt = Number(String(runId).split(":").pop()) || 1;
        const previousSession = await ctx.store.get(sessionKey(task.taskKey));
        let resumed = false;
        if (client.supportsLoadSession() && previousSession?.sessionId) {
          try {
            await client.loadSession({ sessionId: previousSession.sessionId, cwd });
            resumed = true;
            ctx.log.info("复用 ACP 会话", { taskKey: task.taskKey, sessionId: previousSession.sessionId });
          } catch (failure) {
            ctx.log.warn("session/load 失败，回退 session/new", {
              taskKey: task.taskKey,
              message: failure.message
            });
          }
        }
        if (!resumed) await client.newSession({ cwd });
        await ctx.store.set(sessionKey(task.taskKey), {
          sessionId: client.sessionId,
          updatedAt: new Date().toISOString()
        }).catch(() => {});
        const promptText = resumed
          ? renderPrompt(promptTemplate, task)
          : `${renderPrompt(promptTemplate, task)}${
              attempt > 1 ? `\n\n（这是第 ${attempt} 次尝试，上一次运行未正常结束。）` : ""
            }`;
        const result = await client.prompt(promptText);
        record.stopReason = result?.stopReason ?? null;
        if (client.idleTimedOut) {
          status = "timeout";
          error = `idle 超时（${config.idleTimeoutMs}ms 无 session/update）`;
        } else {
          status = result?.stopReason === "cancelled" ? "cancelled" : "succeeded";
        }
      } catch (failure) {
        error = failure.message;
        if (/超时/.test(failure.message)) {
          status = "timeout";
          client.cancel();
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else if (client.closed) {
          status = "failed";
        }
      } finally {
        record.decisions = client.decisions;
        await client.close().catch(() => {});
      }

      record.status = status;
      record.error = status === "succeeded" ? null : error;
      record.finishedAt = new Date().toISOString();
      await ctx.runs
        .finish(runId, {
          status,
          result: {
            agent: record.agent,
            command: record.command,
            cwd: record.cwd,
            stopReason: record.stopReason,
            error: record.error,
            decisions: record.decisions,
            updateCount: record.updates
          }
        })
        .catch((failure) => ctx.log.warn("回写 run 失败", { runId, message: failure.message }));
      active.delete(task.taskKey);
      ctx.log.info("派发结束", {
        taskKey: task.taskKey,
        runId,
        status,
        stopReason: record.stopReason,
        decisions: record.decisions.length
      });
    }

    function scheduleDiscovery() {
      if (discoveryTimer || stopped) return;
      discoveryTimer = setTimeout(() => {
        discoveryTimer = null;
        discover().catch((error) => ctx.log.error("扫描任务失败", { message: error.message }));
      }, 50);
    }

    ctx.events.on("scan.completed", scheduleDiscovery);
    ctx.events.on("task.assigned", scheduleDiscovery);

    ctx.http.route("GET", "/status", async () => ({
      status: 200,
      body: {
        agent: config.agent,
        command: config.command,
        configured: Boolean(config.command),
        maxConcurrent: config.maxConcurrent,
        active: [...active.values()].map((item) => ({ runId: item.runId, taskKey: item.record.taskKey })),
        queued: queue.map((task) => task.taskKey),
        permission: config.permission
      }
    }));

    ctx.http.route("GET", "/executions", async (request) => {
      const limit = Math.min(100, Number(request.query.limit) || 20);
      const runs = await ctx.runs.list({ limit });
      return { status: 200, body: { runs } };
    });

    async function manualDispatch(request, routeLabel) {
      const body = request.json();
      if (body.taskKey) {
        const [projectId, relativeDir] = String(body.taskKey).split("::");
        const task = await ctx.tasks.get({ repositoryId: projectId, relativeDir });
        if (task.status !== "in_progress") {
          return { status: 409, body: { error: `任务状态为 ${task.status}，只派发 in_progress` } };
        }
        if (!(await shouldDispatch(task))) {
          return { status: 409, body: { error: "该任务已有运行记录", taskKey: task.taskKey } };
        }
        return { status: 202, body: { queued: enqueue(task), taskKey: task.taskKey, route: routeLabel } };
      }
      const result = await discover();
      return { status: 202, body: { ...result, route: routeLabel } };
    }

    ctx.http.route("POST", "/runs", async (request) => manualDispatch(request, "runs"));

    ctx.http.route("POST", "/dispatch", async (request) => {
      const body = request.json();
      if (body.taskKey) {
        const [projectId, relativeDir] = String(body.taskKey).split("::");
        const task = await ctx.tasks.get({ repositoryId: projectId, relativeDir });
        if (task.status !== "in_progress") {
          return { status: 409, body: { error: `任务状态为 ${task.status}，只派发 in_progress` } };
        }
        if (!(await shouldDispatch(task))) {
          return { status: 409, body: { error: "该任务已有运行记录", taskKey: task.taskKey } };
        }
        return { status: 202, body: { queued: enqueue(task), taskKey: task.taskKey } };
      }
      const result = await discover();
      return { status: 202, body: result };
    });

    ctx.http.route("POST", "/cancel", async (request) => {
      const taskKey = request.json()?.taskKey;
      const entry = taskKey ? active.get(taskKey) : [...active.values()][0];
      if (!entry) return { status: 404, body: { error: "没有运行中的任务" } };
      entry.client?.cancel();
      ctx.log.info("收到取消请求", { taskKey: entry.record.taskKey, runId: entry.runId });
      return { status: 200, body: { cancelled: entry.runId } };
    });

    ctx.log.info("acp-dispatch 已启动", {
      agent: config.agent,
      command: config.command,
      maxConcurrent: config.maxConcurrent
    });

    ctx.effect(() => {
      stopped = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      for (const entry of active.values()) entry.client?.cancel();
    });
  }
});
