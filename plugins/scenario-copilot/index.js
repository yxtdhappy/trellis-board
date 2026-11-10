import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPlugin } from "../../server/plugins/sdk.js";

const PLUGIN_ID = "scenario-copilot";
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.join(PLUGIN_DIR, "panel");
const LOG_LIMIT = 240_000;

const DEFAULTS = {
  scenarioRoot: "",
  workspaceDir: "",
  outlinesDir: "",
  knowledgePath: "",
  targetUrl: "",
  orgName: "",
  username: "",
  password: "",
  llmApiKey: "",
  llmBaseUrl: "",
  llmModel: "",
  defaultOutline: "",
  timeoutMs: 15 * 60_000,
  maxRuns: 20
};

const ASSETS = new Map([
  ["/panel", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]]
]);

function normalizeConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    timeoutMs: Number.isFinite(Number(raw.timeoutMs)) ? Math.max(60_000, Number(raw.timeoutMs)) : DEFAULTS.timeoutMs,
    maxRuns: Number.isFinite(Number(raw.maxRuns)) ? Math.max(1, Math.min(100, Number(raw.maxRuns))) : DEFAULTS.maxRuns
  };
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function slugify(value) {
  return String(value || "scenario")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "scenario";
}

function testVersionStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function taskNumbers(task, taskKey) {
  const meta = task.meta && typeof task.meta === "object" ? task.meta : {};
  const witops = text(meta.witops_task_id) || text(meta.platform_task_id) || text(meta.requirement_id) || "WIT-NA";
  const base = path.basename(task.relativeDir || "") || text(task.id) || "trellis-NA";
  const uid = createHash("sha1").update(taskKey).digest("hex").slice(0, 6);
  return { witops, trellis: `${base}-${uid}` };
}

function listOutlines(config) {
  const dir = text(config.outlinesDir) ? path.resolve(config.outlinesDir) : "";
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      title: entry.name.replace(/\.(md|txt)$/i, ""),
      size: fs.statSync(path.join(dir, entry.name)).size
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function tail(textValue, limit = LOG_LIMIT) {
  const value = String(textValue ?? "");
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function summaryOf(run) {
  return {
    id: run.id,
    status: run.status,
    taskKey: run.taskKey,
    taskTitle: run.taskTitle,
    outline: run.outline,
    testVersion: run.testVersion,
    targetUrl: run.targetUrl,
    noRun: run.noRun,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    scriptPath: run.scriptPath,
    error: run.error
  };
}

export default createPlugin({
  name: PLUGIN_ID,
  version: "0.1.0",
  apiVersion: 1,
  permissions: ["tasks:read", "store", "events:emit", "events:publish", "http:route", "panels"],

  async onStart(ctx) {
    const config = normalizeConfig(ctx.config);
    const runs = new Map();
    const children = new Map();
    const maxRuns = config.maxRuns;

    function workspaceDir() {
      return config.workspaceDir || path.join(PLUGIN_DIR, "workspace");
    }

    function persist() {
      const latest = [...runs.values()]
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, maxRuns)
        .map(summaryOf);
      ctx.store.set("runs", latest).catch(() => {});
    }

    function prune() {
      const finished = [...runs.values()]
        .filter((run) => !["queued", "running"].includes(run.status))
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      while (runs.size > maxRuns && finished.length) {
        const oldest = finished.shift();
        runs.delete(oldest.id);
        children.delete(oldest.id);
      }
    }

    function appendLog(run, chunk) {
      run.logs = tail(run.logs + String(chunk ?? ""));
    }

    function finish(run, status, exitCode, error) {
      run.status = status;
      run.exitCode = exitCode;
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - new Date(run.startedAt).getTime();
      run.error = error || run.error || null;
      children.delete(run.id);
      persist();
      ctx.events.publish("scenario-copilot/run.finished", summaryOf(run)).catch(() => {});
    }

    function resolveRoot() {
      const configured = text(config.scenarioRoot);
      if (!configured) throw ctx.error(2001, "未配置 scenarioRoot（scenario-copilot 包目录）");
      const root = path.resolve(configured);
      if (!fs.existsSync(path.join(root, "dist", "bin", "scenario-copilot.js"))) {
        throw ctx.error(2001, `scenario-copilot 不存在: ${root}`);
      }
      return root;
    }

    async function bindingOf(taskKey) {
      const value = await ctx.store.get(`binding:${taskKey}`).catch(() => null);
      return value && typeof value === "object" ? value : {};
    }

    async function listBindings() {
      const entries = await ctx.store.list("binding:").catch(() => []);
      const map = new Map();
      for (const entry of entries) {
        const key = String(entry?.key ?? "");
        if (key.startsWith("binding:") && entry.value && typeof entry.value === "object") {
          map.set(key.slice("binding:".length), entry.value);
        }
      }
      return map;
    }

    function taskTarget(task) {
      return text(task?.meta?.testUrl)
        || text(task?.meta?.scenarioCopilot?.targetUrl)
        || text(task?.meta?.scenario?.targetUrl);
    }

    function outlineForTask(task) {
      const slug = path.basename(task.relativeDir);
      return listOutlines(config).find((outline) => {
        const stem = outline.name.replace(/\.(md|txt)$/i, "");
        return slug.includes(stem) || stem.includes(slug);
      })?.name ?? "";
    }

    async function startRun(input = {}) {
      const taskKey = text(input.taskKey);
      if (!taskKey) throw ctx.error(2005, "下发测试必须指定 Trellis 任务");
      const task = await ctx.tasks.get({ taskKey });
      const binding = await bindingOf(taskKey);
      const outlineName = text(input.outline) || text(binding.outline) || outlineForTask(task) || listOutlines(config)[0]?.name || "";
      const outlineDir = text(config.outlinesDir) ? path.resolve(config.outlinesDir) : "";
      if (!outlineDir) throw ctx.error(2002, "未配置 outlinesDir（测试大纲目录）");
      const outlinePath = path.join(outlineDir, path.basename(outlineName));
      if (!outlineName || !fs.existsSync(outlinePath)) {
        throw ctx.error(2002, `测试大纲不存在: ${outlineName || "(未指定)"}`, { outlineDir });
      }
      const targetUrl = text(input.targetUrl) || text(binding.targetUrl) || taskTarget(task) || config.targetUrl;
      if (!/^https?:\/\//i.test(targetUrl)) {
        throw ctx.error(2003, `任务未配置测试地址: ${taskKey}`, { taskKey, title: task.title });
      }
      const username = text(input.username) || config.username;
      const password = text(input.password) || config.password;
      const noRun = input.noRun === true || (!username && !password);
      const scenarioRoot = resolveRoot();
      const momRoot = path.resolve(scenarioRoot, "../..");
      const modulesLink = path.join(workspaceDir(), "node_modules");
      if (!fs.existsSync(modulesLink)) {
        fs.symlinkSync(path.join(momRoot, "node_modules"), modulesLink, "dir");
      }
      const cliPath = path.join(scenarioRoot, "dist", "bin", "scenario-copilot.js");
      const workspace = workspaceDir();
      const specDir = path.join(workspace, "scripts");
      fs.mkdirSync(specDir, { recursive: true });
      const numbers = taskNumbers(task, taskKey);
      const generation = Number(binding.testGeneration || 0) + 1;
      const version = `v${generation}`;
      const testVersion = `${slugify(`${numbers.witops}-${numbers.trellis}`).slice(0, 80)}-${testVersionStamp()}-${version}`;
      const scriptPath = path.join(specDir, `${slugify(testVersion)}.spec.ts`);
      const knowledgePath = text(config.knowledgePath);
      const args = [
        cliPath,
        "pipeline",
        "--outline", outlinePath,
        "--api-url", targetUrl,
        "--workspace", workspace,
        "--spec-dir", specDir,
        "--output", scriptPath,
        "--test-version", testVersion
      ];
      if (knowledgePath && fs.existsSync(knowledgePath)) args.push("--knowledge", knowledgePath);
      args.push("--max-healing", String(Number(config.maxHealingRetries ?? 1)));
      if (input.resume === true) args.push("--resume");
      if (noRun) args.push("--no-run");
      const env = {
        ...process.env,
        MOM_TARGET_URL: targetUrl,
        MOM_USERNAME: username,
        MOM_PASSWORD: password,
        MOM_ORG_NAME: text(input.orgName) || config.orgName,
        NODE_PATH: [path.join(momRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
        MOM_TEST_TIMEOUT: String(Math.min(config.timeoutMs, 120_000))
      };
      if (config.llmApiKey) env.MOM_LLM_API_KEY = config.llmApiKey;
      if (config.llmBaseUrl) env.MOM_LLM_BASE_URL = config.llmBaseUrl;
      if (config.llmModel) env.MOM_LLM_MODEL = config.llmModel;
      const id = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const run = {
        id,
        status: "running",
        taskKey,
        taskTitle: task.title,
        outline: outlineName,
        witopsTaskNo: numbers.witops,
        trellisTaskNo: numbers.trellis,
        testVersion,
        testGeneration: generation,
        targetUrl,
        noRun,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        scriptPath,
        error: null,
        logs: ""
      };
      runs.set(id, run);
      prune();
      appendLog(run, `$ node ${cliPath} ${args.slice(1).join(" ")}\n`);
      const child = spawn(process.execPath, args, {
        cwd: momRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.set(id, child);
      const timer = setTimeout(() => {
        appendLog(run, `\n[scenario-copilot] 超时 ${config.timeoutMs}ms，终止进程\n`);
        child.kill("SIGTERM");
      }, config.timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (chunk) => appendLog(run, chunk));
      child.stderr.on("data", (chunk) => appendLog(run, chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        appendLog(run, `\n[scenario-copilot] 启动失败: ${error.message}\n`);
        finish(run, "failed", null, error.message);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (run.status !== "running") return;
        const status = code === 0 ? "succeeded" : "failed";
        const error = code === 0 ? null : `scenario-copilot 退出码 ${code ?? signal}`;
        finish(run, status, code, error);
      });
      persist();
      await ctx.store.set(`binding:${taskKey}`, {
        targetUrl,
        outline: outlineName,
        testGeneration: generation,
        testVersion,
        scriptPath,
        updatedAt: new Date().toISOString()
      }).catch(() => {});
      ctx.events.publish("scenario-copilot/run.started", summaryOf(run)).catch(() => {});
      return run;
    }

    ctx.http.route("GET", "/panel", async () => {
      const [file, type] = ASSETS.get("/panel");
      return { status: 200, headers: { "content-type": type }, body: fs.readFileSync(path.join(PANEL_DIR, file), "utf8") };
    });
    for (const [route, [file, type]] of ASSETS) {
      if (route === "/panel") continue;
      ctx.http.route("GET", route, async () => ({
        status: 200,
        headers: { "content-type": type },
        body: fs.readFileSync(path.join(PANEL_DIR, file), "utf8")
      }));
    }

    ctx.http.route("GET", "/defaults", async () => ({
      orgName: config.orgName,
      hasCredentials: Boolean(config.username && config.password),
      defaultOutline: config.defaultOutline,
      workspace: workspaceDir(),
      outlines: listOutlines(config)
    }));

    ctx.http.route("GET", "/tasks", async () => {
      const tasks = await ctx.tasks.list({ includeArchived: true });
      const bindings = await listBindings();
      return {
        tasks: tasks.map((task) => ({
          taskKey: task.taskKey,
          projectId: task.projectId,
          projectName: task.projectName,
          relativeDir: task.relativeDir,
          title: task.title,
          status: task.status,
          archived: task.archived || task.relativeDir.startsWith("archive/"),
          binding: bindings.get(task.taskKey) ?? null
        }))
      };
    });

    ctx.http.route("GET", "/history", async () => ({
      runs: [...runs.values()]
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .map(summaryOf)
    }));

    ctx.http.route("POST", "/runs", async (request) => {
      const run = await startRun(request.json());
      return { status: 202, body: { run: summaryOf(run), noRun: run.noRun } };
    });

    ctx.http.route("GET", "/run", async (request) => {
      const run = runs.get(text(request.query.id));
      if (!run) throw ctx.error(2004, "运行记录不存在");
      return { run: { ...summaryOf(run), logs: run.logs } };
    });

    ctx.http.route("POST", "/cancel", async (request) => {
      const id = text(request.json().id);
      const child = children.get(id);
      const run = runs.get(id);
      if (!run) throw ctx.error(2004, "运行记录不存在");
      if (!child) return { cancelled: false, status: run.status };
      child.kill("SIGTERM");
      appendLog(run, "\n[scenario-copilot] 已请求取消\n");
      return { cancelled: true, status: run.status };
    });

    ctx.effect(() => {
      for (const child of children.values()) child.kill("SIGTERM");
      children.clear();
    });
  }
});
