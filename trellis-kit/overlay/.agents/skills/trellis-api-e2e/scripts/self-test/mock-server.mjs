#!/usr/bin/env node
// 本地 mock 服务：只用于 trellis-api-e2e 的自测，不连真实后端、不使用真实凭据。
import http from "node:http";
import fs from "node:fs";
import process from "node:process";

const portFileIndex = process.argv.indexOf("--port-file");
const portFile =
  portFileIndex >= 0 && process.argv[portFileIndex + 1]
    ? process.argv[portFileIndex + 1]
    : "";

const json = (response, body, type = "application/json; charset=utf-8") => {
  response.writeHead(200, {
    "Content-Type": type,
    "Connection": "close",
  });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (pathname === "/ok") {
    return json(response, {
      code: 20000,
      ok: true,
      msg: "ok",
      data: {
        id: 1,
        name: "visible",
        accessToken: "AT-SECRET",
        refreshToken: "RT-SECRET",
        cookie: "sid=COOKIE-SECRET",
        nested: { password: "PWD-SECRET" },
        dbPassword: "DB-SECRET",
      },
    });
  }
  if (pathname === "/string-code") {
    return json(response, {
      code: "20000",
      ok: true,
      msg: "ok",
      data: { id: 2 },
    });
  }
  if (pathname === "/bad-code") {
    return json(response, {
      code: "50000",
      ok: false,
      msg: "bad",
      data: null,
    });
  }
  if (pathname === "/no-code") {
    return json(response, { ok: true, msg: "ok", data: { id: 3 } });
  }
  if (pathname === "/html") {
    return json(response, "<html><body>proxy error</body></html>", "text/html; charset=utf-8");
  }
  if (pathname === "/invalid-json") {
    return json(response, "not-json", "text/plain; charset=utf-8");
  }
  if (pathname === "/placeholder") {
    return json(response, {
      code: 20000,
      ok: true,
      msg: "hello %s",
      data: { id: 4 },
    });
  }
  if (pathname === "/clean") {
    return json(response, {
      code: 20000,
      ok: true,
      msg: "hello world",
      data: { id: 5 },
    });
  }
  if (pathname === "/echo") {
    return json(response, {
      code: 20000,
      ok: true,
      msg: "ok",
      data: { url: request.url, query: requestUrl.search },
    });
  }
  return json(response, { code: 404, ok: false, msg: "not found", data: null });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address.port;
  if (portFile) {
    fs.writeFileSync(portFile, String(port));
  }
  console.log(`E2E_SELF_TEST_PORT=${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
