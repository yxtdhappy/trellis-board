#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const DEFAULTS = {
  listenHost: "127.0.0.1",
  listenPort: 8099,
  healthPath: "/__local_gateway/health",
  originMode: "target",
  rewriteCookies: true,
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HELP = `
本地全链路 E2E 转发代理

用法：
  node local-gateway-proxy.mjs [参数]

核心参数：
  --listen-host <host>         监听地址，默认 127.0.0.1
  --listen-port <port>         监听端口，默认 8099
  --remote-url <url>           未匹配请求的远端网关 origin，例如 http://mom3.fat.weintdata.cn
  --route <prefix=url>         本地路由，可重复；最长前缀优先
  --config <file>              JSON 配置文件
  --health-path <path>         健康检查路径，默认 /__local_gateway/health
  --origin-mode <mode>         target、client、remove，默认 target
  --[no-]rewrite-cookies       是否移除 Domain、Secure 并把 SameSite=None 改为 Lax，默认开启
  --header <name:value>        额外转发请求头，可重复
  --help                       显示帮助

示例：
  node local-gateway-proxy.mjs \\
    --listen-port 8099 \\
    --remote-url http://mom3.fat.weintdata.cn \\
    --route "/appgw/mdp-backend-service=http://127.0.0.1:8855/mdp-backend-service"

环境变量：
  LOCAL_GATEWAY_CONFIG
  LOCAL_GATEWAY_HOST
  LOCAL_GATEWAY_PORT
  LOCAL_GATEWAY_REMOTE_URL
  LOCAL_GATEWAY_ROUTES          JSON 数组，元素为 "prefix=url" 或配置对象
  LOCAL_GATEWAY_HEADERS         JSON 对象
  LOCAL_GATEWAY_ORIGIN_MODE
  LOCAL_GATEWAY_REWRITE_COOKIES true/false
`.trim();

const fail = (message) => {
  throw new Error(message);
};

const parseBoolean = (value, label) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  fail(`${label} 必须是 true/false，当前值：${value}`);
};

const readArgumentValue = (argv, index, inlineValue, name) => {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`参数 ${name} 缺少值`);
  }
  return { value, nextIndex: index + 1 };
};

const parseHeader = (raw, label = "请求头") => {
  const separator = raw.indexOf(":");
  if (separator <= 0) fail(`${label}格式应为 name:value，当前值：${raw}`);
  return [
    raw.slice(0, separator).trim(),
    raw.slice(separator + 1).trim(),
  ];
};

const parseArgs = (argv) => {
  const options = {
    routes: [],
    headers: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    const [name, inlineValue] = argument.includes("=")
      ? argument.split(/=(.*)/s, 2)
      : [argument, undefined];

    if (name === "--route") {
      const parsed = readArgumentValue(argv, index, inlineValue, name);
      options.routes.push(parsed.value);
      options.routesProvided = true;
      index = parsed.nextIndex;
      continue;
    }
    if (name === "--header") {
      const parsed = readArgumentValue(argv, index, inlineValue, name);
      const [headerName, headerValue] = parseHeader(parsed.value);
      options.headers[headerName] = headerValue;
      index = parsed.nextIndex;
      continue;
    }

    const valueOptions = new Map([
      ["--config", "configPath"],
      ["--listen-host", "listenHost"],
      ["--listen-port", "listenPort"],
      ["--remote-url", "remoteUrl"],
      ["--health-path", "healthPath"],
      ["--origin-mode", "originMode"],
    ]);
    const optionKey = valueOptions.get(name);
    if (optionKey) {
      const parsed = readArgumentValue(argv, index, inlineValue, name);
      options[optionKey] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (name === "--rewrite-cookies") {
      options.rewriteCookies = true;
      continue;
    }
    if (name === "--no-rewrite-cookies") {
      options.rewriteCookies = false;
      continue;
    }

    fail(`未知参数：${argument}`);
  }

  return options;
};

const readJsonFile = async (filePath) => {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    fail(`无法读取配置文件 ${filePath}：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`配置文件不是有效 JSON：${filePath}，${error.message}`);
  }
};

const readJsonEnvironmentValue = (name) => {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`环境变量 ${name} 不是有效 JSON：${error.message}`);
  }
};

const normalizePrefix = (raw) => {
  let prefix = String(raw || "").trim();
  if (!prefix.startsWith("/")) fail(`本地路由前缀必须以 / 开头：${raw}`);
  if (prefix.length > 1) prefix = prefix.replace(/\/+$/, "");
  return prefix || "/";
};

const normalizeUrl = (raw, label) => {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    fail(`${label}不是有效 URL：${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    fail(`${label}只支持 http/https：${raw}`);
  }
  if (url.username || url.password) {
    fail(`${label}不能包含用户名或密码`);
  }
  if (url.search) fail(`${label}不能包含查询参数：${raw}`);
  if (url.hash) fail(`${label}不能包含 hash：${raw}`);
  return url;
};

const normalizeHeaders = (raw, label) => {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((item) => parseHeader(item, label)));
  }
  if (typeof raw !== "object") fail(`${label}必须是对象或 name:value 数组`);
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [
      String(name).trim(),
      String(value),
    ]),
  );
};

const normalizeRoute = (raw, index) => {
  let prefix;
  let targetRaw;
  let headers;
  let name;

  if (typeof raw === "string") {
    const separator = raw.indexOf("=");
    if (separator <= 0) {
      fail(`--route 格式应为 prefix=url，当前值：${raw}`);
    }
    prefix = raw.slice(0, separator);
    targetRaw = raw.slice(separator + 1);
  } else if (raw && typeof raw === "object") {
    prefix = raw.prefix;
    targetRaw = raw.target;
    headers = raw.headers;
    name = raw.name;
  } else {
    fail(`第 ${index + 1} 条本地路由格式无效`);
  }

  return {
    name: name ? String(name) : undefined,
    prefix: normalizePrefix(prefix),
    target: normalizeUrl(targetRaw, `本地路由 ${prefix} 的 target `),
    headers: normalizeHeaders(headers, `本地路由 ${prefix} 的 headers `),
  };
};

const normalizeRoutes = (rawRoutes) => {
  if (!Array.isArray(rawRoutes)) fail("routes 必须是数组");
  const routes = rawRoutes.map(normalizeRoute).sort(
    (left, right) => right.prefix.length - left.prefix.length,
  );
  const prefixes = new Set();
  for (const route of routes) {
    if (prefixes.has(route.prefix)) {
      fail(`本地路由前缀重复：${route.prefix}`);
    }
    prefixes.add(route.prefix);
  }
  return routes;
};

const resolveOptions = async (argv) => {
  const cli = parseArgs(argv);
  if (cli.help) return { help: true };

  const configPath =
    cli.configPath ||
    process.env.LOCAL_GATEWAY_CONFIG ||
    undefined;
  const config = configPath ? await readJsonFile(configPath) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("配置文件顶层必须是 JSON 对象");
  }

  const envRoutes = readJsonEnvironmentValue("LOCAL_GATEWAY_ROUTES");
  const envHeaders = readJsonEnvironmentValue("LOCAL_GATEWAY_HEADERS");
  const rawRoutes = cli.routesProvided
    ? cli.routes
    : envRoutes !== undefined
      ? envRoutes
      : config.routes;

  const listenPortRaw =
    cli.listenPort ??
    process.env.LOCAL_GATEWAY_PORT ??
    config.listenPort ??
    DEFAULTS.listenPort;
  const listenPort = Number(listenPortRaw);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    fail(`监听端口无效：${listenPortRaw}`);
  }

  const originMode =
    cli.originMode ??
    process.env.LOCAL_GATEWAY_ORIGIN_MODE ??
    config.originMode ??
    DEFAULTS.originMode;
  if (!["target", "client", "remove"].includes(originMode)) {
    fail(`origin-mode 只能是 target、client 或 remove：${originMode}`);
  }

  const rewriteCookiesRaw =
    cli.rewriteCookies ??
    process.env.LOCAL_GATEWAY_REWRITE_COOKIES ??
    config.rewriteCookies ??
    DEFAULTS.rewriteCookies;

  const remoteUrlRaw =
    cli.remoteUrl ??
    process.env.LOCAL_GATEWAY_REMOTE_URL ??
    config.remoteUrl;
  const remoteUrl = remoteUrlRaw
    ? normalizeUrl(remoteUrlRaw, "remote-url ")
    : null;
  if (remoteUrl && remoteUrl.pathname !== "/") {
    fail("remote-url 只接受 origin；需要基础路径时请使用 catch-all --route");
  }

  return {
    help: false,
    configPath,
    listenHost:
      cli.listenHost ??
      process.env.LOCAL_GATEWAY_HOST ??
      config.listenHost ??
      DEFAULTS.listenHost,
    listenPort,
    healthPath: normalizePrefix(
      cli.healthPath ??
        process.env.LOCAL_GATEWAY_HEALTH_PATH ??
        config.healthPath ??
        DEFAULTS.healthPath,
    ),
    remoteUrl,
    routes: normalizeRoutes(rawRoutes || []),
    headers: {
      ...normalizeHeaders(config.headers, "config.headers "),
      ...normalizeHeaders(envHeaders, "LOCAL_GATEWAY_HEADERS "),
      ...cli.headers,
    },
    originMode,
    rewriteCookies: parseBoolean(rewriteCookiesRaw, "rewriteCookies"),
  };
};

const routeMatches = (route, pathname) =>
  route.prefix === "/" ||
  pathname === route.prefix ||
  pathname.startsWith(`${route.prefix}/`);

const matchRoute = (routes, pathname) =>
  routes.find((route) => routeMatches(route, pathname)) || null;

const joinUrlPath = (left, right) => {
  const normalizedLeft = !left || left === "/" ? "" : left.replace(/\/+$/, "");
  const normalizedRight = !right || right === "/" ? "" : `/${right.replace(/^\/+/, "")}`;
  return `${normalizedLeft}${normalizedRight}` || "/";
};

const redactQueryForLog = (path) => {
  const queryIndex = path.indexOf("?");
  if (queryIndex < 0) return path;
  const keys = [
    ...new Set(new URLSearchParams(path.slice(queryIndex + 1)).keys()),
  ];
  const pathname = path.slice(0, queryIndex);
  return keys.length ? `${pathname}?[${keys.join(",")}]` : pathname;
};

const buildUpstreamPath = (requestUrl, route) => {
  if (!route) return `${requestUrl.pathname || "/"}${requestUrl.search}`;

  const remainingPath =
    route.prefix === "/"
      ? requestUrl.pathname
      : requestUrl.pathname.slice(route.prefix.length);
  const path = joinUrlPath(route.target.pathname, remainingPath);
  return `${path || "/"}${requestUrl.search}`;
};

const targetForRequest = (requestUrl, options) => {
  const route = matchRoute(options.routes, requestUrl.pathname);
  return {
    route,
    target: route ? route.target : options.remoteUrl,
    path: buildUpstreamPath(requestUrl, route),
    local: Boolean(route),
  };
};

const appendForwardedFor = (request) => {
  const existing = request.headers["x-forwarded-for"];
  const remoteAddress = request.socket.remoteAddress || "";
  if (!existing) return remoteAddress;
  return remoteAddress ? `${existing}, ${remoteAddress}` : existing;
};

const buildRequestHeaders = (
  request,
  target,
  route,
  options,
  forUpgrade = false,
) => {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const keepUpgradeHeader =
      forUpgrade && (name === "connection" || name === "upgrade");
    if (HOP_BY_HOP_HEADERS.has(name) && !keepUpgradeHeader) continue;
    headers[name] = value;
  }

  Object.assign(
    headers,
    options.headers,
    route?.headers || {},
  );

  headers.host = target.host;
  headers["x-forwarded-for"] = appendForwardedFor(request);
  headers["x-forwarded-host"] =
    request.headers.host || `${options.listenHost}:${options.listenPort}`;
  headers["x-forwarded-proto"] = "http";
  if (route?.prefix) headers["x-forwarded-prefix"] = route.prefix;

  if (options.originMode === "remove") {
    delete headers.origin;
  } else if (options.originMode === "target") {
    headers.origin = target.origin;
  }

  if (forUpgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade || "websocket";
  }

  return headers;
};

const reverseRewriteLocalPath = (pathname, route) => {
  const targetBase =
    route.target.pathname === "/"
      ? ""
      : route.target.pathname.replace(/\/+$/, "");
  if (!targetBase) return pathname;
  if (pathname !== targetBase && !pathname.startsWith(`${targetBase}/`)) {
    return pathname;
  }

  const suffix = pathname.slice(targetBase.length);
  if (route.prefix === "/") return suffix || "/";
  return `${route.prefix}${suffix || ""}`;
};

const rewriteLocation = (location, target, route) => {
  if (typeof location !== "string" || !location) return location;
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    return location;
  }
  if (parsed.origin !== target.origin) return location;

  const pathname = route
    ? reverseRewriteLocalPath(parsed.pathname, route)
    : parsed.pathname;
  return `${pathname}${parsed.search}${parsed.hash}`;
};

const rewriteSetCookie = (cookie) =>
  cookie
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*Secure/gi, "")
    .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");

const copyResponseHeaders = (
  upstreamHeaders,
  target,
  route,
  rewriteCookies,
) => {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    headers[name] = value;
  }

  if (headers.location) {
    headers.location = rewriteLocation(headers.location, target, route);
  }

  if (rewriteCookies && headers["set-cookie"]) {
    const cookies = Array.isArray(headers["set-cookie"])
      ? headers["set-cookie"]
      : [headers["set-cookie"]];
    headers["set-cookie"] = cookies.map(rewriteSetCookie);
  }

  return headers;
};

const responseBody = (response, statusCode, body) => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
};

const healthDocument = (options) => ({
  ok: true,
  service: "wit-local-gateway-proxy",
  listen: `${options.listenHost}:${options.listenPort}`,
  remoteUrl: options.remoteUrl?.origin || null,
  healthPath: options.healthPath,
  originMode: options.originMode,
  rewriteCookies: options.rewriteCookies,
  routes: options.routes.map((route) => ({
    name: route.name || null,
    prefix: route.prefix,
    target: `${route.target.origin}${route.target.pathname}`,
  })),
});

const transportFor = (target) =>
  target.protocol === "https:" ? https : http;

const requestOptions = (target, path, headers) => ({
  protocol: target.protocol,
  hostname: target.hostname,
  port: target.port || (target.protocol === "https:" ? 443 : 80),
  method: undefined,
  path,
  headers,
});

const handleRequest = (request, response, options) => {
  let requestUrl;
  try {
    requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || `${options.listenHost}:${options.listenPort}`}`,
    );
  } catch {
    responseBody(response, 400, {
      ok: false,
      msg: "无效请求地址",
    });
    return;
  }

  if (requestUrl.pathname === options.healthPath) {
    responseBody(response, 200, healthDocument(options));
    return;
  }

  const resolved = targetForRequest(requestUrl, options);
  if (!resolved.target) {
    responseBody(response, 404, {
      ok: false,
      msg: "请求未匹配本地路由，且未配置 remote-url",
    });
    return;
  }

  const startedAt = Date.now();
  const routeLabel = resolved.route?.name || resolved.route?.prefix || "remote";
  const logPath = redactQueryForLog(resolved.path);
  console.log(
    `[proxy] ${request.method} ${requestUrl.pathname} -> ${routeLabel} ${resolved.target.origin}${logPath}`,
  );

  const headers = buildRequestHeaders(
    request,
    resolved.target,
    resolved.route,
    options,
  );
  const transport = transportFor(resolved.target);
  const upstream = transport.request(
    {
      ...requestOptions(resolved.target, resolved.path, headers),
      method: request.method,
    },
    (upstreamResponse) => {
      const responseHeaders = copyResponseHeaders(
        upstreamResponse.headers,
        resolved.target,
        resolved.route,
        options.rewriteCookies,
      );
      console.log(
        `[proxy] ${upstreamResponse.statusCode || 502} ${request.method} ${requestUrl.pathname} ${Date.now() - startedAt}ms`,
      );
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(response);
      upstreamResponse.on("error", (error) => {
        console.error(`[proxy] 上游响应中断：${error.message}`);
        response.destroy(error);
      });
    },
  );

  upstream.on("error", (error) => {
    console.error(
      `[proxy] ${request.method} ${requestUrl.pathname} -> ${resolved.target.origin} 失败：${error.message}`,
    );
    responseBody(response, 502, {
      ok: false,
      msg: "本地代理无法连接目标服务",
    });
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
};

const rawUpgradeResponse = (upstreamResponse, upstreamHead) => {
  const lines = [
    `HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || "Switching Protocols"}`,
  ];
  for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
    lines.push(
      `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`,
    );
  }
  const head = upstreamHead?.length ? upstreamHead : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"),
    head,
  ]);
};

const handleUpgrade = (request, socket, head, options) => {
  const destroyWithError = (message) => {
    if (!socket.destroyed) {
      socket.end(
        `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`,
      );
    }
  };

  let requestUrl;
  try {
    requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || `${options.listenHost}:${options.listenPort}`}`,
    );
  } catch {
    destroyWithError("无效请求地址");
    return;
  }

  const resolved = targetForRequest(requestUrl, options);
  if (!resolved.target) {
    destroyWithError("请求未匹配本地路由，且未配置 remote-url");
    return;
  }

  const headers = buildRequestHeaders(
    request,
    resolved.target,
    resolved.route,
    options,
    true,
  );
  const transport = transportFor(resolved.target);
  const upstream = transport.request({
    ...requestOptions(resolved.target, resolved.path, headers),
    method: request.method,
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write(rawUpgradeResponse(upstreamResponse, upstreamHead));
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.on("error", (error) => socket.destroy(error));
    socket.on("error", (error) => upstreamSocket.destroy(error));
    upstreamSocket.on("close", () => socket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on("response", (upstreamResponse) => {
    socket.write(rawUpgradeResponse(upstreamResponse));
    upstreamResponse.pipe(socket);
  });
  upstream.on("error", (error) => {
    console.error(`[proxy] WebSocket ${requestUrl.pathname} 失败：${error.message}`);
    destroyWithError("本地代理无法连接目标服务");
  });
  upstream.end();
};

const main = async () => {
  const options = await resolveOptions(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!options.remoteUrl && options.routes.length === 0) {
    fail("至少配置一条 --route，或提供 --remote-url");
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response, options);
  });
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head, options);
  });
  server.on("clientError", (error, socket) => {
    console.error(`[proxy] 客户端请求错误：${error.message}`);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(options.listenPort, options.listenHost, () => {
    console.log(
      `[proxy] listening http://${options.listenHost}:${options.listenPort}${options.healthPath}`,
    );
    for (const route of options.routes) {
      console.log(
        `[proxy] ${route.prefix}/* -> ${route.target.origin}${route.target.pathname}/*`,
      );
    }
    console.log(
      `[proxy] fallback -> ${options.remoteUrl ? options.remoteUrl.origin : "404"}`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((error) => {
  console.error(`[proxy] ${error.message}`);
  process.exitCode = 1;
});
