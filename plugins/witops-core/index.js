import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlugin } from "@trellis-board/server/plugins/sdk.js";
import { createWitopsClient } from "./witops-client.js";
import { createSession, resolveAuthMode } from "./auth.js";
import { createLinkIndex } from "./links.js";
import { createDispatch } from "./dispatch.js";
import { resolveRequirement } from "./mapper.js";
import {
  asPositiveInt,
  calendarDate,
  detailOf,
  flattenTree,
  normalizeId,
  normalizeStatus,
  numberOrNull,
  pick,
  statusLabel,
  text
} from "./util.js";

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  baseUrl: "",
  gatewayPrefix: "/appgw",
  taskServicePrefix: "/weint-witops-service",
  adminServicePrefix: "/system-mng",
  webRoot: "weint-witops-web",
  platform: "MOM_WEB",
  path: "/weint-witops-web/dashboard/mine",
  repositoryId: "",
  userId: null,
  assignedToUserId: null,
  assignee: "",
  developerMap: {},
  skipIfNoAssignee: true,
  types: [3, 4],
  type: 4,
  status: "1,3",
  pageSize: 50,
  maxItems: 200,
  maxPerSync: 50,
  cacheTtlMs: 60_000,
  requestIntervalMs: 200,
  retries: 2,
  timeoutMs: 20_000,
  keepRaw: false,
  agentId: null,
  credentialSource: "auto",
  accountSystemId: "witops",
  credentials: { mode: "password", account: "", password: "", token: "" },
  session: { persist: true },
  poll: { enabled: false, intervalMs: 1_800_000 }
};

function normalizeConfig(raw = {}) {
  const credentials = { ...DEFAULTS.credentials, ...(raw.credentials ?? {}) };
  credentials.mode = resolveAuthMode(credentials);
  return {
    ...DEFAULTS,
    ...raw,
    credentials,
    session: { ...DEFAULTS.session, ...(raw.session ?? {}) },
    poll: { ...DEFAULTS.poll, ...(raw.poll ?? {}) },
    developerMap: raw.developerMap && typeof raw.developerMap === "object" ? raw.developerMap : {}
  };
}

export default createPlugin({
  name: "witops-core",
  version: "2.0.0",
  apiVersion: 1,
  permissions: [
    "capabilities:provide",
    "tasks:read",
    "tasks:write",
    "store",
    "events",
    "http:route",
    "panels",
    "schedule",
    "runs:read",
    "runs:write",
    "secrets:read",
    "secrets:write",
    "capabilities:call"
  ],

  async onStart(ctx, rawConfig) {
    const config = normalizeConfig({ ...rawConfig, ...(ctx.config ?? {}) });
    let accountCredential = null;
    let accountsError = "";

    // 统一账号优先：成功则覆盖 config.credentials，失败按 credentialSource 回退本地。
    // 先算结果再一次性提交，避免事件回包期间状态短暂变空。
    let refreshSeq = 0;
    async function refreshAccounts({ reason = "startup" } = {}) {
      const seq = ++refreshSeq;
      let next = null;
      let error = "";
      if (config.credentialSource !== "local") {
        try {
          const result = await ctx.capabilities.call("accounts.credentials", "credential.resolve", {
            system: config.accountSystemId
          });
          next = {
            accountId: text(result?.accountId),
            account: text(result?.username),
            password: text(result?.password),
            baseUrl: text(result?.baseUrl)
          };
        } catch (caught) {
          error = caught?.message || String(caught);
        }
      }
      if (seq !== refreshSeq) return;
      accountCredential = next;
      accountsError = error;
      if (!next) {
        if (error) {
          ctx.log.info("统一账号不可用，按配置回退", {
            source: config.credentialSource,
            error,
            reason
          });
        }
        return;
      }
      config.credentials.account = next.account;
      config.credentials.password = next.password;
      config.credentials.mode = "password";
      if (next.baseUrl) config.baseUrl = next.baseUrl;
      ctx.log.info("统一账号凭据已生效", {
        system: config.accountSystemId,
        account: next.accountId,
        reason
      });
    }

    await refreshAccounts();
    const client = createWitopsClient(config);
    const session = createSession({ ctx, config, client });
    const links = createLinkIndex({ ctx, config });
    const readCache = new Map();
    let dispatch = null;
    let storyIndexCache = null;
    let storyIndexPromise = null;

    // 统一账号变更后重算凭据（下次 ensureToken 用新密码登录），并丢掉旧缓存。
    ctx.events.on("accounts-core/changed", async () => {
      await refreshAccounts({ reason: "accounts-changed" });
      readCache.clear();
    });

    function cached(key) {
      const entry = readCache.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at > Number(config.cacheTtlMs || 0)) {
        readCache.delete(key);
        return null;
      }
      return entry.value;
    }

    function remember(key, value) {
      readCache.set(key, { at: Date.now(), value });
      return value;
    }

    dispatch = createDispatch({
      ctx,
      config,
      client,
      session,
      links,
      onChanged: () => readCache.clear()
    });

    function itemLink(type, id) {
      const webRoot = text(config.webRoot).replace(/^\/+|\/+$/g, "");
      if (!config.baseUrl) return "";
      return `${String(config.baseUrl).replace(/\/+$/, "")}/#/${webRoot}/commonDetail/nodeTaskDetail/${type}/${id}`;
    }

    function normalizeItem(record) {
      const type = numberOrNull(record?.type) ?? 4;
      const id = normalizeId(pick(record, "businessId", "sourceId", "id"));
      const requirement = resolveRequirement(record);
      return {
        kind: type === 3 ? "requirement" : "task",
        type,
        id,
        code: text(pick(record, "code", "businessCode")) || id,
        title: text(pick(record, "name", "title")),
        status: statusLabel(pick(record, "sourceStatusName", "statusName", "sourceStatus", "status")),
        priority: text(pick(record, "priorityDicConfigCode", "priorityName", "priority")),
        assignee: text(pick(record, "assignedToUserName", "assigneeName", "assignee")),
        dueDate: calendarDate(
          pick(record, "expectCompleteTime", "expectFinishTime", "expectEndTime", "deadline", "planEndTime")
        ),
        storyId: requirement ? requirement.id : null,
        storyCode: requirement ? requirement.code : null,
        storyName: requirement && requirement.name ? requirement.name : null,
        storyUrl: requirement ? itemLink(3, requirement.id) : "",
        url: itemLink(type, id)
      };
    }

    async function mine({ types, force = false } = {}) {
      const key = "mine";
      if (!force) {
        const hit = cached(key);
        if (hit) return hit;
      }
      const wanted = Array.isArray(types) && types.length
        ? types.map(Number).filter((value) => value === 3 || value === 4)
        : config.types;
      const items = [];
      for (const type of wanted.length ? wanted : [3, 4]) {
        let current = 1;
        let pages = 1;
        while (current <= pages && items.length < Number(config.maxItems || 200)) {
          const page = await dispatch.fetchPage({ type, page: current });
          pages = Math.max(1, page.pages);
          for (const record of page.records) {
            if (items.length >= Number(config.maxItems || 200)) break;
            items.push(normalizeItem(record));
          }
          current += 1;
        }
      }
      for (const item of items) item.trellisTasks = await links.forItem(item);
      return remember(key, {
        userId: await session.resolveUserId(),
        items,
        fetchedAt: new Date().toISOString()
      });
    }

    function normalizeRequirement(detail, fallbackId) {
      const id = normalizeId(pick(detail, "businessId", "sourceId", "id")) || fallbackId;
      return {
        id,
        code: text(pick(detail, "code", "businessCode")) || id,
        title: text(pick(detail, "name", "title")),
        status: normalizeStatus(pick(detail, "sourceStatusName", "statusName", "sourceStatus", "status")),
        priority: text(pick(detail, "priorityDicConfigCode", "priorityName", "priority")),
        assignee: text(pick(detail, "assignedToUserName", "assigneeName", "assignee")),
        description: text(pick(detail, "description", "content")),
        url: itemLink(3, id)
      };
    }

    function normalizeStory(record, fallbackCode = "") {
      const id = normalizeId(pick(record, "businessId", "sourceId", "id"));
      const value = normalizeRequirement(record, id);
      value.id = id;
      value.code = text(pick(record, "code", "businessCode")) || fallbackCode || id;
      return value;
    }

    function storyRecords(data) {
      return Array.isArray(data) ? data : data?.records ?? data?.list ?? [];
    }

    async function loadStoryIndex() {
      if (storyIndexCache && Date.now() - storyIndexCache.at <= Number(config.cacheTtlMs || 0)) {
        return storyIndexCache.value;
      }
      if (storyIndexPromise) return storyIndexPromise;
      storyIndexPromise = (async () => {
        const index = new Map();
        let current = 1;
        let pages = 1;
        while (current <= Math.min(pages, 10)) {
          const data = await session.authorized((token) =>
            client.storyPage({ current, size: 200 }, { token })
          );
          const records = storyRecords(data);
          for (const record of records) {
            const story = normalizeStory(record);
            if (story.id) index.set(story.id, story);
          }
          pages = Math.max(1, Number(data?.pages ?? 1));
          if (records.length < 200) break;
          current += 1;
        }
        storyIndexCache = { at: Date.now(), value: index };
        return index;
      })();
      try {
        return await storyIndexPromise;
      } finally {
        storyIndexPromise = null;
      }
    }

    function codeKey(value) {
      const match = /REQ[-_ ]?(\d+)/i.exec(text(value));
      return match ? `REQ-${Number(match[1])}` : text(value).toUpperCase();
    }

    function titleKey(value) {
      return text(value).replace(/\s+/g, "").toLowerCase();
    }

    function storyMatches(story, code, title) {
      const wantedCode = codeKey(code);
      if (wantedCode && (codeKey(story.code) === wantedCode || codeKey(story.id) === wantedCode)) {
        return true;
      }
      return Boolean(title) && titleKey(story.title) === titleKey(title);
    }

    function storyRank(record, story, code, title) {
      let score = 0;
      const wantedCode = codeKey(code);
      if (wantedCode && (codeKey(story.code) === wantedCode || codeKey(story.id) === wantedCode)) {
        score += 1000;
      }
      if (title && titleKey(story.title) === titleKey(title)) score += 200;
      if (record?.draftSourceId) score -= 500;
      if (/草稿/.test(text(record?.sourceStatusName ?? record?.statusName ?? story.status))) {
        score -= 200;
      }
      if (record?.detailData === true) score += 50;
      if (story.id) score += 20;
      if (story.assignee) score += 10;
      if (record?.flowInstance) score += 10;
      return score;
    }

    async function resolveOne(code, title) {
      const key = `resolve:${text(code).toUpperCase()}:${text(title)}`;
      const hit = cached(key);
      if (hit) return hit;
      const queries = [];
      if (text(title)) queries.push({ name: text(title) });
      else if (text(code)) queries.push({ code: text(code) });
      for (const query of queries) {
        try {
          const data = await session.authorized((token) =>
            client.storyPage({ current: 1, size: 50, ...query }, { token })
          );
          let best = null;
          for (const record of storyRecords(data)) {
            const story = normalizeStory(record, code);
            if (!storyMatches(story, code, title)) continue;
            const rank = storyRank(record, story, code, title);
            if (!best || rank > best.rank) best = { story, rank };
          }
          if (best) return remember(key, best.story);
        } catch (error) {
          if (error?.authExpired) throw error;
          ctx.log.warn("需求查询失败", {
            code,
            query: Object.keys(query).join(","),
            message: error.message
          });
        }
      }
      if (text(title)) return null;
      const index = await loadStoryIndex();
      for (const story of index.values()) {
        if (storyMatches(story, code, title)) return remember(key, story);
      }
      return null;
    }

    function compactRequirement(value) {
      const rest = { ...value };
      delete rest.description;
      return rest;
    }

    async function resolveRequirements(params) {
      const input = (Array.isArray(params?.items) ? params.items : []).slice(0, 100);
      const resolved = input.map(() => null);
      let cursor = 0;
      const worker = async () => {
        while (cursor < input.length) {
          const index = cursor;
          cursor += 1;
          const entry = input[index];
          const code = text(entry?.code);
          const title = text(entry?.title);
          if (!code && !title) {
            resolved[index] = { missing: { code, title, error: "缺少编号或标题" } };
            continue;
          }
          try {
            const story = await resolveOne(code, title);
            resolved[index] = story
              ? { item: { ...compactRequirement(story), sourceCode: code, sourceTitle: title } }
              : { missing: { code, title, error: "未找到 需求" } };
          } catch (error) {
            resolved[index] = { missing: { code, title, error: error.message } };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, input.length) }, worker));
      return {
        items: resolved.filter((entry) => entry?.item).map((entry) => entry.item),
        missing: resolved.filter((entry) => entry?.missing).map((entry) => entry.missing)
      };
    }

    async function requirement(id) {
      const key = `requirement:${id}`;
      const hit = cached(key);
      if (hit) return hit;
      const raw = await session.authorized((token) => client.story({ id, type: 3 }, { token }));
      return remember(key, normalizeRequirement(detailOf(raw), id));
    }

    async function tree(id) {
      const key = `tree:${id}`;
      const hit = cached(key);
      if (hit) return hit;
      const raw = await session.authorized((token) => client.tree({ id, type: 3 }, { token }));
      const root = detailOf(raw);
      const nodes = flattenTree(root);
      const tasks = nodes.slice(1).filter((node) => node.type === 4 || node.type === 3);
      const totalHours = Number(root.childrenTotalWorkHour ?? 0) ||
        tasks.reduce((sum, node) => sum + Number(node.hours || 0), 0);
      const value = {
        requirement: compactRequirement(normalizeRequirement(root, id)),
        tasks,
        totalHours
      };
      return remember(key, value);
    }

    async function taskDetail(id) {
      const raw = await session.authorized((token) => client.detail({ id, type: 4 }, { token }));
      const detail = detailOf(raw);
      const taskId = normalizeId(pick(detail, "businessId", "sourceId", "id")) || id;
      return {
        id: taskId,
        requirementId: normalizeId(pick(detail, "parentId", "storyId", "requirementId")) || null,
        code: text(pick(detail, "code", "businessCode")) || taskId,
        title: text(pick(detail, "name", "title")),
        status: normalizeStatus(pick(detail, "sourceStatusName", "statusName", "sourceStatus", "status")),
        assignee: text(pick(detail, "assignedToUserName", "assigneeName", "assignee")),
        hours: Number(detail.inputWorkHour ?? 0) || 0,
        description: text(pick(detail, "description", "content")),
        url: itemLink(4, taskId)
      };
    }

    async function requirementQuery(ids) {
      const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeId).filter(Boolean))].slice(0, 200);
      const items = [];
      for (const id of wanted) {
        try {
          items.push(compactRequirement(await requirement(id)));
        } catch (error) {
          items.push({ id, error: error.message });
        }
      }
      return { items };
    }

    async function tasksByRequirement(requirementIds) {
      const wanted = [...new Set((Array.isArray(requirementIds) ? requirementIds : []).map(normalizeId).filter(Boolean))].slice(0, 100);
      const items = [];
      for (const id of wanted) {
        try {
          const value = await tree(id);
          items.push({ requirementId: id, tasks: value.tasks });
        } catch (error) {
          items.push({ requirementId: id, tasks: [], error: error.message });
        }
      }
      return { items };
    }

    async function worklogSummary(ids) {
      const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeId).filter(Boolean))].slice(0, 100);
      const items = [];
      for (const id of wanted) {
        try {
          const value = await tree(id);
          items.push({ id, totalHours: value.totalHours });
        } catch (error) {
          items.push({ id, totalHours: 0, error: error.message });
        }
      }
      return { items };
    }

    async function updateRequirementStatus(params) {
      const id = normalizeId(params?.id);
      if (!id) throw ctx.error(1002, "缺少需求 id");
      const status = params?.status;
      const data = await session.authorized((token) => client.storyUpdate({
        id,
        sourceStatus: status,
        status,
        ...(params?.comment ? { comment: params.comment } : {})
      }, { token }));
      readCache.clear();
      return { id, status, result: data ?? null };
    }

    async function updateTaskStatus(params) {
      const id = normalizeId(params?.id);
      if (!id) throw ctx.error(1002, "缺少任务 id");
      const status = params?.status;
      const data = await session.authorized((token) => client.taskUpdate({
        id,
        sourceStatus: status,
        status,
        ...(params?.comment ? { comment: params.comment } : {})
      }, { token }));
      readCache.clear();
      return { id, status, result: data ?? null };
    }

    async function assignTask(params) {
      const id = normalizeId(params?.id);
      if (!id) throw ctx.error(1002, "缺少任务 id");
      const assigneeId = numberOrNull(params?.assigneeId);
      if (assigneeId === null) throw ctx.error(1002, "缺少 assigneeId");
      const data = await session.authorized((token) => client.taskUpdate({
        id,
        assignedToUserId: assigneeId
      }, { token }));
      readCache.clear();
      return { id, assigneeId, result: data ?? null };
    }

    async function previewMany(params = {}) {
      const items = dispatch.normalizeItems(params).slice(0, 50);
      if (!items.length) throw ctx.error(1002, "需要 items / businessIds / businessId");
      const results = [];
      for (const item of items) {
        try {
          results.push({ ...item, ...(await dispatch.previewOne(item)) });
        } catch (error) {
          results.push({ ...item, status: "failed", reason: error.message });
        }
      }
      return { results };
    }

    async function authStatus() {
      return {
        ...session.status(),
        hasStoredPassword: await session.hasStoredPassword(),
        credentialSource: accountCredential ? "accounts" : "local",
        accountSystemId: config.accountSystemId,
        accountsError: accountsError || null
      };
    }

    ctx.capabilities.register("witops.workitems", {
      mine: (params) => mine({ types: params?.types, force: params?.force === true }),
      "requirement.get": (params) => requirement(normalizeId(params?.id)),
      "requirement.query": (params) => requirementQuery(params?.ids),
      "requirement.resolve": (params) => resolveRequirements(params),
      "requirement.tree": (params) => tree(normalizeId(params?.id)),
      "task.listByRequirement": (params) => tasksByRequirement(params?.requirementIds),
      "task.get": (params) => taskDetail(normalizeId(params?.id))
    });

    ctx.capabilities.register("witops.worklogs", {
      summary: (params) => worklogSummary(params?.ids)
    });

    ctx.capabilities.register("witops.actions", {
      "requirement.updateStatus": updateRequirementStatus,
      "task.updateStatus": updateTaskStatus,
      "task.assign": assignTask
    });

    ctx.capabilities.register("witops.dispatch", {
      preview: (params) => previewMany(params),
      "task.create": (params) =>
        dispatch.createOne({
          type: params?.type,
          businessId: normalizeId(params?.businessId ?? params?.id),
          repositoryId: params?.repositoryId
        }),
      "task.batchCreate": (params) =>
        dispatch.createBatch(dispatch.normalizeItems(params ?? {})),
      "task.syncRecent": (params) =>
        dispatch.syncRecent({ size: params?.size, repositoryId: params?.repositoryId }),
      "imported.list": (params) => dispatch.importedList({ limit: params?.limit }),
      "auth.login": async (params) => {
        await session.login({
          account: params?.account,
          password: params?.password,
          remember: params?.remember === true,
          source: "panel"
        });
        return authStatus();
      },
      "auth.logout": () => session.logout(),
      "auth.status": () => authStatus()
    });

    function respond(status, body, type = "application/json; charset=utf-8") {
      return { status, headers: { "content-type": type }, body };
    }

    function failure(error, fallbackStatus = 502) {
      let status = fallbackStatus;
      if (error?.code === 1001) status = 401;
      else if (error?.code === 1002) status = 400;
      return respond(status, { error: error.message, code: error.code ?? null, detail: error.data ?? null });
    }

    function asset(name, type) {
      try {
        return respond(200, fs.readFileSync(path.join(BASE_DIR, "panel", name), "utf8"), type);
      } catch {
        return respond(404, { error: "not found" });
      }
    }

    ctx.http.route("GET", "/panel", () => asset("index.html", "text/html; charset=utf-8"));
    ctx.http.route("GET", "/panel/app.js", () => asset("app.js", "text/javascript; charset=utf-8"));
    ctx.http.route("GET", "/panel/app.css", () => asset("app.css", "text/css; charset=utf-8"));

    ctx.http.route("GET", "/mine", async (request) => {
      try {
        const data = await mine({ force: request.query.refresh === "1" });
        return respond(200, data);
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("GET", "/tasks", async (request) => {
      try {
        const data = await dispatch.tasksPage({
          page: request.query.page,
          size: request.query.size,
          status: request.query.status || config.status,
          type: request.query.type || config.type
        });
        return respond(200, data);
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("POST", "/refresh", async () => {
      readCache.clear();
      links.invalidate();
      storyIndexCache = null;
      await dispatch.loadDictionaries({ force: true });
      return respond(200, { ok: true });
    });

    ctx.http.route("GET", "/auth", async () => respond(200, await authStatus()));

    // 供统一账号小组件使用：只暴露凭据来源与账号名，不暴露密码。
    ctx.http.route("GET", "/credentials", async () =>
      respond(200, {
        source: accountCredential ? "accounts" : "local",
        systemId: config.accountSystemId,
        accountId: accountCredential?.accountId ?? "",
        username: text(config.credentials.account),
        hasPassword:
          Boolean(text(config.credentials.password)) || Boolean(await session.hasStoredPassword()),
        error: accountsError || ""
      })
    );

    ctx.http.route("POST", "/login", async (request) => {
      const body = request.json() ?? {};
      if (!text(body.account) || !text(body.password)) {
        return respond(400, { error: "需要 account 与 password" });
      }
      try {
        await session.login({
          account: body.account,
          password: body.password,
          remember: body.remember === true,
          source: "panel"
        });
        readCache.clear();
        return respond(200, { ok: true, auth: await authStatus() });
      } catch (error) {
        return failure(error, 502);
      }
    });

    ctx.http.route("POST", "/logout", async () => {
      await session.logout();
      return respond(200, { ok: true, auth: await authStatus() });
    });

    ctx.http.route("GET", "/projects", async () => {
      try {
        const result = await ctx.capabilities.call("trellis.projects", "list");
        const projects = (result?.projects ?? []).map((project) => ({
          repositoryId: project.repositoryId,
          name: project.name ?? project.repositoryId,
          path: project.path ?? null
        }));
        return respond(200, {
          projects,
          defaultRepositoryId: text(config.repositoryId) || projects[0]?.repositoryId || null
        });
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("POST", "/dispatch/preview", async (request) => {
      try {
        return respond(200, await previewMany(request.json() ?? {}));
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("POST", "/dispatch", async (request) => {
      try {
        const items = dispatch.normalizeItems(request.json() ?? {});
        const result = await dispatch.createBatch(items);
        return respond(200, result);
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("POST", "/sync", async (request) => {
      try {
        const body = request.json() ?? {};
        const result = await dispatch.syncRecent({
          size: asPositiveInt(body.size, config.maxPerSync),
          repositoryId: body.repositoryId
        });
        return respond(200, result);
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("GET", "/imported", async (request) => {
      try {
        return respond(200, await dispatch.importedList({ limit: request.query.limit }));
      } catch (error) {
        return failure(error);
      }
    });

    ctx.http.route("GET", "/executions", async (request) => {
      const limit = Math.min(100, Number(request.query.limit) || 20);
      const runs = await ctx.runs.list({ limit });
      return respond(200, { runs });
    });

    ctx.http.route("GET", "/status", async () => {
      const auth = await authStatus();
      const imported = await links.listImported({ limit: 500 }).catch(() => []);
      return respond(200, {
        configured: Boolean(config.baseUrl),
        authMode: session.mode,
        credentialSource: accountCredential ? "accounts" : "local",
        accountsError: accountsError || null,
        userId: auth.userId,
        cacheTtlMs: config.cacheTtlMs,
        repositoryId: config.repositoryId || null,
        auth,
        dispatch: {
          repositoryId: config.repositoryId || null,
          assignee: config.assignee || null,
          assignedToUserId: config.assignedToUserId,
          skipIfNoAssignee: config.skipIfNoAssignee !== false,
          keepRaw: Boolean(config.keepRaw),
          maxPerSync: config.maxPerSync,
          poll: config.poll,
          imported: imported.length
        }
      });
    });

    if (config.poll?.enabled) {
      const intervalMs = asPositiveInt(config.poll.intervalMs, 1_800_000);
      const timer = ctx.schedule.every(intervalMs, async () => {
        try {
          const result = await dispatch.syncRecent();
          ctx.log.info("轮询同步完成", { ...result.summary, total: result.total });
        } catch (error) {
          ctx.log.error("轮询同步失败", { message: error.message });
        }
      });
      ctx.effect(() => ctx.schedule.cancel(timer));
    }

    ctx.log.info("witops-core 已启动", {
      baseUrl: config.baseUrl,
      authMode: session.mode,
      repositoryId: config.repositoryId || null,
      poll: config.poll?.enabled ?? false
    });
  }
});
