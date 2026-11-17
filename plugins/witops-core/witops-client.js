export const SUCCESS_CODE = 20000;
export const AUTH_EXPIRED_CODE = 40300;

const DEFAULT_PATHS = {
  login: "/api/sysUser/login",
  findUser: "/api/sysUser/findUser",
  taskPage: "/nodeTask/page",
  storyPage: "/story/page",
  taskDetail: "/task/detail",
  storyDetail: "/story/detail",
  treeChild: "/task/removeAllSiblings",
  workHourList: "/workHourExamine/taskWorkHourList",
  dictionary: "/api/sysDicConfig/getListByKey",
  storyUpdate: "/story/update",
  taskUpdate: "/task/update",
  projectByMaster: "/project/findByMaster",
  projectByParticipant: "/project/findByParticipant",
  projectUserRole: "/projectUserRole/userRole",
  projectTaskPage: "/task/task/page",
  statusBulletin: "/bulletin/statusBulletin"
};

export class ApiError extends Error {
  constructor(message, { code = null, status = null, detail = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  get authExpired() {
    return this.code === AUTH_EXPIRED_CODE || this.status === 401 || this.status === 403;
  }
}

function joinPath(...parts) {
  const joined = parts
    .filter((part) => part !== null && part !== undefined && String(part) !== "")
    .map((part) => String(part))
    .join("/");
  return `/${joined.replace(/^\/+/, "").replace(/\/{2,}/g, "/")}`;
}

export function resolvePaths(config = {}) {
  const gateway = config.gatewayPrefix ?? "/appgw";
  const taskService = config.taskServicePrefix ?? "/weint-witops-service";
  const adminService = config.adminServicePrefix ?? "/system-mng";
  const paths = config.paths ?? {};
  return {
    login: joinPath(gateway, adminService, paths.login ?? DEFAULT_PATHS.login),
    findUser: joinPath(gateway, adminService, paths.findUser ?? DEFAULT_PATHS.findUser),
    taskPage: joinPath(gateway, taskService, paths.taskPage ?? DEFAULT_PATHS.taskPage),
    storyPage: joinPath(gateway, taskService, paths.storyPage ?? DEFAULT_PATHS.storyPage),
    taskDetail: joinPath(gateway, taskService, paths.taskDetail ?? DEFAULT_PATHS.taskDetail),
    storyDetail: joinPath(gateway, taskService, paths.storyDetail ?? DEFAULT_PATHS.storyDetail),
    treeChild: joinPath(gateway, taskService, paths.treeChild ?? DEFAULT_PATHS.treeChild),
    workHourList: joinPath(gateway, taskService, paths.workHourList ?? DEFAULT_PATHS.workHourList),
    dictionary: joinPath(gateway, adminService, paths.dictionary ?? DEFAULT_PATHS.dictionary),
    storyUpdate: joinPath(gateway, taskService, paths.storyUpdate ?? DEFAULT_PATHS.storyUpdate),
    taskUpdate: joinPath(gateway, taskService, paths.taskUpdate ?? DEFAULT_PATHS.taskUpdate),
    projectByMaster: joinPath(gateway, taskService, paths.projectByMaster ?? DEFAULT_PATHS.projectByMaster),
    projectByParticipant: joinPath(
      gateway,
      taskService,
      paths.projectByParticipant ?? DEFAULT_PATHS.projectByParticipant
    ),
    projectUserRole: joinPath(gateway, taskService, paths.projectUserRole ?? DEFAULT_PATHS.projectUserRole),
    projectTaskPage: joinPath(gateway, taskService, paths.projectTaskPage ?? DEFAULT_PATHS.projectTaskPage),
    statusBulletin: joinPath(gateway, taskService, paths.statusBulletin ?? DEFAULT_PATHS.statusBulletin)
  };
}

function buildUrl(baseUrl, routePath) {
  try {
    return new URL(`${baseUrl}${routePath}`);
  } catch {
    throw new ApiError(`witops-core baseUrl 不是合法地址: ${baseUrl}`);
  }
}

export function createWitopsClient(config = {}, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
  const paths = resolvePaths(config);
  const retries = Math.max(0, Number(config.retries ?? 2));
  const backoffMs = Math.max(1, Number(config.retryBackoffMs ?? 300));
  const minIntervalMs = Math.max(0, Number(config.requestIntervalMs ?? 200));
  const timeoutMs = Math.max(1000, Number(config.timeoutMs ?? 20_000));
  const platform = config.platform ?? "MOM_WEB";
  const platformPath = config.path ?? "/weint-witops-web/dashboard/mine";
  let lastRequestAt = 0;

  async function throttle() {
    if (!minIntervalMs) return;
    const elapsed = now() - lastRequestAt;
    if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
    lastRequestAt = now();
  }

  async function request(routePath, { method = "POST", body, query, token = "", headers = {} } = {}) {
    if (!baseUrl) throw new ApiError("witops-core 缺少 baseUrl 配置");
    const url = buildUrl(baseUrl, routePath);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await throttle();
      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(token ? { "Weareint-Token": token } : {}),
            ...(platform ? { "Weareint-Platform": platform } : {}),
            ...(platformPath ? { "Weareint-Path": platformPath } : {}),
            ...headers
          },
          body: body === undefined ? undefined : JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.status >= 500) {
          throw new ApiError(`平台返回 HTTP ${response.status}`, { status: response.status });
        }
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ApiError(`平台返回非 JSON 内容: ${text.slice(0, 120)}`, { status: response.status });
        }
        if (payload?.code !== SUCCESS_CODE) {
          throw new ApiError(payload?.msg || payload?.message || `平台业务码 ${payload?.code}`, {
            code: payload?.code ?? null,
            status: response.status,
            detail: payload?.data ?? null
          });
        }
        return payload.data;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof ApiError) || error.status >= 500 || error.code === null;
        if (!retryable || attempt === retries || error.authExpired) break;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
    throw lastError instanceof ApiError
      ? lastError
      : new ApiError(lastError?.message || "平台请求失败", { detail: String(lastError) });
  }

  return {
    paths,
    post: (routePath, body, options) => request(routePath, { ...options, method: "POST", body }),
    get: (routePath, query, options) => request(routePath, { ...options, method: "GET", query }),
    login: (account, password) => request(paths.login, { method: "POST", body: { account, password } }),
    findUser: (options) => request(paths.findUser, { method: "GET", ...options }),
    page: (params, options) => request(paths.taskPage, { ...options, method: "POST", body: params }),
    storyPage: (params, options) => request(paths.storyPage, { ...options, method: "POST", body: params }),
    detail: (params, options) => request(paths.taskDetail, { ...options, method: "POST", body: params }),
    story: (params, options) => request(paths.storyDetail, { ...options, method: "POST", body: params }),
    tree: (params, options) => request(paths.treeChild, { ...options, method: "POST", body: params }),
    workHours: (params, options) => request(paths.workHourList, { ...options, method: "POST", body: params }),
    dictionary: (params, options) => request(paths.dictionary, { ...options, method: "POST", body: params }),
    storyUpdate: (params, options) => request(paths.storyUpdate, { ...options, method: "POST", body: params }),
    taskUpdate: (params, options) => request(paths.taskUpdate, { ...options, method: "POST", body: params }),
    projectByMaster: (params, options) =>
      request(paths.projectByMaster, { ...options, method: "POST", body: params }),
    projectByParticipant: (params, options) =>
      request(paths.projectByParticipant, { ...options, method: "POST", body: params }),
    projectUserRole: (params, options) =>
      request(paths.projectUserRole, { ...options, method: "POST", body: params }),
    projectTaskPage: (params, options) =>
      request(paths.projectTaskPage, { ...options, method: "POST", body: params }),
    // 任务看板：一次返回按状态分组的全部任务（前端 statusDashboard/4 用的就是这个）。
    statusBulletin: (params, options) =>
      request(paths.statusBulletin, { ...options, method: "POST", body: params })
  };
}
