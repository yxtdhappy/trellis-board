import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultAgentRoot } from "./config-store.js";
import { normalizeServerUrl } from "./protocol.js";
import { extractZipEntries, readZipEntries, ZipError } from "./zip.js";

const TEMPLATE_MANIFEST = "template-manifest.json";
const DEVELOPER_FILE = ".trellis/.developer";
const TEMPLATE_HASHES_FILE = ".trellis/.template-hashes.json";
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOP_LEVEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const WORKSPACE_ERROR_CODE = Object.freeze({
  PATH_INVALID: "WORKSPACE_PATH_INVALID",
  PATH_UNWRITABLE: "WORKSPACE_PATH_UNWRITABLE",
  USERNAME_INVALID: "WORKSPACE_USERNAME_INVALID",
  TEMPLATE_UNAVAILABLE: "TEMPLATE_UNAVAILABLE",
  TEMPLATE_AUTH_FAILED: "TEMPLATE_AUTH_FAILED",
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  TEMPLATE_HTTP_ERROR: "TEMPLATE_HTTP_ERROR",
  TEMPLATE_HASH_MISMATCH: "TEMPLATE_HASH_MISMATCH",
  TEMPLATE_INVALID: "TEMPLATE_INVALID",
  DEVELOPER_CONFLICT: "DEVELOPER_CONFLICT",
  DEVELOPER_INIT_FAILED: "DEVELOPER_INIT_FAILED"
});

export class WorkspaceBootstrapError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WorkspaceBootstrapError";
    this.code = code;
    if (options.status != null) this.status = options.status;
    if (options.details != null) this.details = options.details;
  }
}

function fail(code, message, options) {
  return new WorkspaceBootstrapError(code, message, options);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeFileAtomic(file, data) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function normalizeVersion(value, label = "模板版本") {
  const version = String(value || "").trim();
  if (!VERSION_PATTERN.test(version)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `${label}格式无效`);
  }
  return version;
}

function normalizeToolList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板清单 ${label} 必须是非空数组`);
  }
  const tools = [];
  for (const item of value) {
    const tool = String(item || "");
    if (!TOOL_PATTERN.test(tool)) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板清单 ${label} 包含无效工具目录`);
    }
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools;
}

function normalizeTopLevelList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板清单 ${label} 必须是非空数组`);
  }
  const files = [];
  for (const item of value) {
    const file = String(item || "");
    if (!TOP_LEVEL_PATTERN.test(file) || file === "." || file === "..") {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板清单 ${label} 包含无效路径`);
    }
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

function parseBundleManifest(source) {
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板清单不是合法 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板清单不是对象");
  }
  const version = normalizeVersion(raw.version);
  const tools = normalizeToolList(raw.tools, "tools");
  const defaultTools = normalizeToolList(raw.defaultTools, "defaultTools");
  if (defaultTools.some((tool) => !tools.includes(tool))) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "默认工具必须包含在 tools 中");
  }
  const files = normalizeTopLevelList(raw.files, "files");
  const baseFiles = Array.isArray(raw.baseFiles)
    ? normalizeTopLevelList(raw.baseFiles, "baseFiles")
    : files.filter((item) => !tools.includes(item));
  if (!files.includes(".trellis")) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板缺少 .trellis");
  }
  for (const item of [...baseFiles, ...defaultTools]) {
    if (!files.includes(item)) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板清单缺少 ${item}`);
    }
  }
  return {
    version,
    tools,
    defaultTools,
    files,
    baseFiles
  };
}

export function loadTemplateBundle(archive, {
  expectedSha256 = null,
  source = "local",
  version = null
} = {}) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板归档为空");
  }
  const actual = sha256(archive);
  if (expectedSha256 && actual !== String(expectedSha256).toLowerCase()) {
    throw fail(
      WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH,
      "模板 SHA-256 校验失败，已中止写入",
      { details: { expected: String(expectedSha256).toLowerCase(), actual } }
    );
  }
  let entries;
  try {
    entries = readZipEntries(archive);
  } catch (error) {
    if (error instanceof ZipError) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, error.message, { cause: error });
    }
    throw error;
  }
  const manifestEntry = entries.find(
    (entry) => !entry.isDirectory && entry.name === TEMPLATE_MANIFEST
  );
  if (!manifestEntry) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板缺少 template-manifest.json");
  }
  const manifest = parseBundleManifest(manifestEntry.data.toString("utf8"));
  if (version && normalizeVersion(version, "响应模板版本") !== manifest.version) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板版本与归档内清单不一致");
  }
  return {
    archive,
    sha256: actual,
    source,
    version: manifest.version,
    manifest,
    entries
  };
}

export function loadTemplateArchive(file, options = {}) {
  let archive;
  try {
    archive = fs.readFileSync(file);
  } catch (error) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE, "无法读取本地模板归档", {
      cause: error
    });
  }
  return loadTemplateBundle(archive, options);
}

export function workspaceTemplateCacheDir(teamId, dataRoot = defaultAgentRoot()) {
  return path.join(path.resolve(dataRoot), "templates", "workspace", normalizeCacheTeamId(teamId));
}

function normalizeCacheTeamId(teamId) {
  const id = String(teamId || "").trim();
  if (!id) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_NOT_FOUND, "缺少团队 ID");
  }
  if (!SAFE_ID_PATTERN.test(id) || id === "." || id === "..") {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "团队 ID 格式无效");
  }
  return id;
}

export function loadCachedWorkspaceTemplate({
  teamId,
  dataRoot = defaultAgentRoot()
} = {}) {
  const cacheDir = workspaceTemplateCacheDir(teamId, dataRoot);
  const latestFile = path.join(cacheDir, "latest.json");
  let latest;
  try {
    latest = readJson(latestFile);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "本地模板缓存索引损坏", {
      cause: error
    });
  }
  const sha = String(latest?.sha256 || "").toLowerCase();
  if (!SHA256_PATTERN.test(sha)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "本地模板缓存哈希无效");
  }
  const archiveFile = path.join(cacheDir, sha, "template.zip");
  let archive;
  try {
    archive = fs.readFileSync(archiveFile);
  } catch (error) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE, "本地模板缓存不完整", {
      cause: error
    });
  }
  const bundle = loadTemplateBundle(archive, {
    expectedSha256: sha,
    source: "cache",
    version: latest.version
  });
  if (latest.version && latest.version !== bundle.manifest.version) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "本地模板缓存版本不一致");
  }
  return bundle;
}

function loadCachedForFallback({ teamId, dataRoot, logger }) {
  try {
    return loadCachedWorkspaceTemplate({ teamId, dataRoot });
  } catch (error) {
    logger?.warn?.("本地模板缓存不可用", {
      code: error?.code || WORKSPACE_ERROR_CODE.TEMPLATE_INVALID
    });
    return null;
  }
}

function cacheTemplate(bundle, teamId, dataRoot) {
  const cacheDir = workspaceTemplateCacheDir(teamId, dataRoot);
  const versionDir = path.join(cacheDir, bundle.sha256);
  fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  const archiveFile = path.join(versionDir, "template.zip");
  if (!fs.existsSync(archiveFile)) {
    writeFileAtomic(archiveFile, bundle.archive);
  } else {
    const existing = fs.readFileSync(archiveFile);
    if (sha256(existing) !== bundle.sha256) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH, "已有模板缓存哈希不一致");
    }
  }
  writeFileAtomic(path.join(versionDir, "manifest.json"), `${JSON.stringify({
    version: bundle.manifest.version,
    sha256: bundle.sha256,
    bytes: bundle.archive.length,
    defaultTools: bundle.manifest.defaultTools,
    tools: bundle.manifest.tools,
    cachedAt: new Date().toISOString()
  }, null, 2)}\n`);
  const latestFile = path.join(cacheDir, "latest.json");
  let latest = null;
  try {
    latest = readJson(latestFile);
  } catch {
    latest = null;
  }
  if (latest?.sha256 !== bundle.sha256 || latest?.version !== bundle.manifest.version) {
    writeFileAtomic(latestFile, `${JSON.stringify({
      version: bundle.manifest.version,
      sha256: bundle.sha256,
      cachedAt: new Date().toISOString()
    }, null, 2)}\n`);
  }
}

function serverBaseUrl(serverUrl) {
  try {
    return normalizeServerUrl(serverUrl);
  } catch (error) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE, "服务端地址无效", {
      cause: error
    });
  }
}

function downloadHeaders({ sessionToken, agentCredential }) {
  if (agentCredential) {
    return { accept: "application/zip", authorization: `Bearer ${agentCredential}` };
  }
  if (sessionToken) {
    return {
      accept: "application/zip",
      cookie: `trellis_team_session=${encodeURIComponent(sessionToken)}`
    };
  }
  throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_AUTH_FAILED, "缺少登录会话或 Agent 凭证");
}

function httpError(status, body) {
  const message = typeof body?.error === "string" && body.error.trim()
    ? body.error.trim().slice(0, 300)
    : `模板服务返回 HTTP ${status}`;
  if (status === 401 || status === 403) {
    return fail(WORKSPACE_ERROR_CODE.TEMPLATE_AUTH_FAILED, message, { status });
  }
  if (status === 404) {
    return fail(WORKSPACE_ERROR_CODE.TEMPLATE_NOT_FOUND, message, { status });
  }
  return fail(WORKSPACE_ERROR_CODE.TEMPLATE_HTTP_ERROR, message, { status });
}

async function readResponseBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板归档超过大小限制");
  }
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE, "模板下载中断", { cause: error });
  }
  if (buffer.length > maxBytes) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板归档超过大小限制");
  }
  return buffer;
}

export async function downloadWorkspaceTemplate({
  serverUrl,
  teamId,
  sessionToken = null,
  agentCredential = null,
  dataRoot = defaultAgentRoot(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null
} = {}) {
  const id = normalizeCacheTeamId(teamId);
  const headers = downloadHeaders({ sessionToken, agentCredential });
  const base = serverBaseUrl(serverUrl);
  const url = `${base}/api/teams/${encodeURIComponent(id)}/workspace-template`;
  if (typeof fetchImpl !== "function") {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE, "当前环境不支持模板下载");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal
    });
  } catch (error) {
    const cached = loadCachedForFallback({ teamId: id, dataRoot, logger });
    if (cached) {
      logger?.warn?.("服务端不可达，使用缓存模板", {
        version: cached.manifest.version,
        sha256: cached.sha256.slice(0, 12)
      });
      return cached;
    }
    throw fail(
      WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE,
      "无法连接服务端，且本地没有可用的缓存模板",
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status >= 500) {
      await response.arrayBuffer().catch(() => {});
      const cached = loadCachedForFallback({ teamId: id, dataRoot, logger });
      if (cached) {
        logger?.warn?.("模板服务不可用，使用缓存模板", {
          version: cached.manifest.version,
          status: response.status
        });
        return cached;
      }
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // 非 JSON 错误响应只保留状态码。
    }
    throw httpError(response.status, body);
  }

  const headerSha = String(response.headers?.get?.("x-template-sha256") || "").toLowerCase();
  if (!SHA256_PATTERN.test(headerSha)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板响应缺少 SHA-256");
  }
  const headerVersion = String(response.headers?.get?.("x-template-version") || "");
  const archive = await readResponseBody(response, MAX_DOWNLOAD_BYTES);
  const actual = sha256(archive);
  if (actual !== headerSha) {
    throw fail(
      WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH,
      "模板下载哈希校验失败，已中止写入",
      { details: { expected: headerSha, actual } }
    );
  }
  const bundle = loadTemplateBundle(archive, {
    expectedSha256: headerSha,
    source: "network",
    version: headerVersion || null
  });
  cacheTemplate(bundle, id, dataRoot);
  logger?.info?.("workspace 模板下载并校验完成", {
    version: bundle.manifest.version,
    sha256: bundle.sha256.slice(0, 12),
    bytes: bundle.archive.length
  });
  return bundle;
}

function systemDirectories() {
  const values = new Set();
  if (process.platform === "win32") {
    for (const candidate of [
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramData,
      process.env.USERPROFILE,
      "C:\\Windows",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\ProgramData",
      "C:\\Users"
    ]) {
      if (candidate) values.add(path.resolve(candidate));
    }
    return values;
  }
  for (const candidate of [
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/Library",
    "/media",
    "/mnt",
    "/opt",
    "/private",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/System",
    "/tmp",
    "/usr",
    "/var",
    "/Volumes"
  ]) {
    values.add(path.resolve(candidate));
  }
  return values;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function assertWorkspaceDirectory(target) {
  if (typeof target !== "string" || target.trim().length === 0) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "workspace 路径不能为空");
  }
  if (!path.isAbsolute(target)) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "workspace 必须使用绝对路径");
  }
  const resolved = path.resolve(target);
  if (comparablePath(resolved) === comparablePath(path.parse(resolved).root)) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "不能把文件系统根目录作为 workspace");
  }
  if (systemDirectories().has(comparablePath(resolved))) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "不能把系统目录作为 workspace");
  }
  let stat;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "workspace 目录不存在");
  }
  if (stat.isSymbolicLink()) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "workspace 不能是符号链接或重解析点");
  }
  if (!stat.isDirectory()) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "workspace 必须是目录");
  }
  let real;
  try {
    real = await fs.promises.realpath(resolved);
  } catch {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "无法解析 workspace 真实路径");
  }
  const canonicalParent = await fs.promises.realpath(path.dirname(resolved)).catch(() => null);
  const canonical = canonicalParent ? path.join(canonicalParent, path.basename(resolved)) : resolved;
  if (comparablePath(real) !== comparablePath(canonical)) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "workspace 路径包含符号链接或重解析点");
  }
  const probe = path.join(
    resolved,
    `.trellis-write-test-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  try {
    const handle = await fs.promises.open(probe, "wx", 0o600);
    await handle.writeFile("ok");
    await handle.close();
  } catch {
    throw fail(WORKSPACE_ERROR_CODE.PATH_UNWRITABLE, "workspace 目录不可写");
  } finally {
    await fs.promises.rm(probe, { force: true }).catch(() => {});
  }
  return resolved;
}

export function validateWorkspaceUsername(value) {
  const username = String(value || "").trim();
  if (!USERNAME_PATTERN.test(username) || username === "." || username === "..") {
    throw fail(WORKSPACE_ERROR_CODE.USERNAME_INVALID, "登录用户名不能用于初始化 developer");
  }
  return username;
}

function readDeveloperName(file) {
  if (!fs.existsSync(file)) return null;
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const match = /^name=(.*)$/m.exec(content);
  return match ? match[1].trim() : "";
}

function journalContent(username, now) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  return `# Journal - ${username} (Part 1)\n\n` +
    "> AI development session journal\n" +
    `> Started: ${date}\n\n---\n\n`;
}

function indexContent(username) {
  return `# Workspace Index - ${username}

> Journal tracking for AI development sessions.

---

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: \`journal-1.md\`
- **Total Sessions**: 0
- **Last Active**: -
<!-- @@@/auto:current-status -->

---

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| \`journal-1.md\` | ~0 | Active |
<!-- @@@/auto:active-documents -->

---

## Session History

<!-- @@@auto:session-history -->
| # | Date | Title | Commits | Branch |
|---|------|-------|---------|--------|
<!-- @@@/auto:session-history -->

---

## Notes

- Sessions are appended to journal files
- New journal file created when current exceeds 2000 lines
- Use \`add_session.py\` to record sessions
`;
}

function ensureDeveloperWorkspaceFiles(workspacePath, realRoot, username, now, createdDirs) {
  const workspaceDir = path.join(workspacePath, ".trellis", "workspace", username);
  const journalFile = path.join(workspaceDir, "journal-1.md");
  const indexPath = path.join(workspaceDir, "index.md");
  const created = [];
  ensureDirectoryTracked(workspacePath, realRoot, workspaceDir, createdDirs);
  if (!lstatOrNull(journalFile)) {
    assertSafeWorkspacePath(workspacePath, realRoot, journalFile);
    fs.writeFileSync(journalFile, journalContent(username, now), { flag: "wx" });
    created.push(relativePosix(workspacePath, journalFile));
  }
  if (!lstatOrNull(indexPath)) {
    assertSafeWorkspacePath(workspacePath, realRoot, indexPath);
    fs.writeFileSync(indexPath, indexContent(username), { flag: "wx" });
    created.push(relativePosix(workspacePath, indexPath));
  }
  return created;
}

function initializeDeveloper(workspacePath, realRoot, username, now, createdDirs) {
  const file = path.join(workspacePath, ...DEVELOPER_FILE.split("/"));
  ensureDirectoryTracked(workspacePath, realRoot, path.dirname(file), createdDirs);
  assertSafeWorkspacePath(workspacePath, realRoot, file);
  fs.writeFileSync(
    file,
    `name=${username}\ninitialized_at=${now.toISOString()}\n`,
    { flag: "wx", mode: 0o600 }
  );
}

function backupStamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function createBackupManager(workspacePath, realRoot, now) {
  let directory = null;
  const files = [];
  function ensureDirectory() {
    if (directory) return directory;
    const base = `.trellis-backup-${backupStamp(now)}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${base}-${crypto.randomBytes(3).toString("hex")}`;
      try {
        fs.mkdirSync(path.join(workspacePath, candidate), { mode: 0o700 });
        directory = candidate;
        return directory;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw fail(WORKSPACE_ERROR_CODE.DEVELOPER_INIT_FAILED, "无法创建备份目录");
  }
  return {
    backup(relativePath) {
      const target = path.join(workspacePath, relativePath);
      assertSafeWorkspacePath(workspacePath, realRoot, target);
      const stat = lstatOrNull(target);
      if (!stat) return null;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "备份目标不是普通文件");
      }
      const dir = ensureDirectory();
      const destination = path.join(workspacePath, dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(target, destination);
      files.push(relativePath);
      return path.join(dir, relativePath);
    },
    get directory() {
      return directory;
    },
    get files() {
      return [...files];
    }
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathNative(target) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(target)
    : fs.realpathSync(target);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function nearestExistingAncestor(target) {
  let current = target;
  for (;;) {
    if (lstatOrNull(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function assertSafeWorkspacePath(root, realRoot, target) {
  if (!isWithin(root, target)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板条目路径逃逸 workspace");
  }
  const existing = nearestExistingAncestor(target);
  const stat = lstatOrNull(existing);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "目标路径经过符号链接或重解析点");
  }
  let real;
  try {
    real = realpathNative(existing);
  } catch (error) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "无法解析目标路径真实位置", { cause: error });
  }
  if (!isWithin(realRoot, real)) {
    throw fail(WORKSPACE_ERROR_CODE.PATH_INVALID, "目标路径经符号链接逃逸 workspace");
  }
}

function safeRemove(root, realRoot, relative) {
  const target = path.join(root, relative);
  try {
    assertSafeWorkspacePath(root, realRoot, target);
  } catch {
    return;
  }
  const stat = lstatOrNull(target);
  if (!stat || stat.isSymbolicLink()) return;
  fs.rmSync(target, { force: true });
}

function safeRestore(root, realRoot, source, target) {
  try {
    assertSafeWorkspacePath(root, realRoot, source);
    assertSafeWorkspacePath(root, realRoot, target);
  } catch {
    return;
  }
  const sourceStat = lstatOrNull(source);
  if (!sourceStat || !sourceStat.isFile()) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function relativeTemplatePath(workspacePath, entryName) {
  const target = path.join(workspacePath, ...String(entryName).split("/"));
  if (!isWithin(workspacePath, target)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板条目路径逃逸 workspace");
  }
  return { target, relative: relativePosix(workspacePath, target) };
}

function ensureDirectoryTracked(workspacePath, realRoot, directory, createdDirs) {
  if (!isWithin(workspacePath, directory)) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板条目路径逃逸 workspace");
  }
  assertSafeWorkspacePath(workspacePath, realRoot, directory);
  const stat = lstatOrNull(directory);
  if (stat) {
    if (!stat.isDirectory()) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "目标路径已被文件占用");
    }
    return;
  }
  const missing = [];
  let current = directory;
  while (!lstatOrNull(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(directory, { recursive: true });
  assertSafeWorkspacePath(workspacePath, realRoot, directory);
  for (const item of missing.reverse()) createdDirs.push(item);
}

function fileHash(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function resolveTools(manifest, tools) {
  if (tools == null) return [...manifest.defaultTools];
  if (!Array.isArray(tools) || tools.length === 0) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "工具选择必须是非空数组");
  }
  const selected = [];
  for (const item of tools) {
    const tool = String(item || "");
    if (!manifest.tools.includes(tool)) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板不支持工具目录 ${tool}`);
    }
    if (!selected.includes(tool)) selected.push(tool);
  }
  return selected;
}

function templateHashesPayload(bundle, tools, workspacePath, realRoot) {
  const selectedTop = new Set([...bundle.manifest.baseFiles, ...tools]);
  const files = {};
  for (const entry of bundle.entries) {
    if (entry.isDirectory) continue;
    if (!selectedTop.has(entry.name.split("/")[0])) continue;
    if (entry.name === TEMPLATE_HASHES_FILE) continue;
    const target = path.join(workspacePath, ...entry.name.split("/"));
    assertSafeWorkspacePath(workspacePath, realRoot, target);
    const hash = fileHash(target);
    if (!hash) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板文件写入后无法读取");
    }
    files[entry.name] = hash;
  }
  return `${JSON.stringify({
    schemaVersion: 1,
    templateVersion: bundle.manifest.version,
    templateSha256: bundle.sha256,
    tools,
    files
  }, null, 2)}\n`;
}

export async function applyWorkspaceTemplate({
  workspacePath,
  username,
  bundle,
  tools = null,
  mode = "initialize",
  confirmDeveloperSwitch = false,
  logger = null,
  now = new Date()
} = {}) {
  const root = await assertWorkspaceDirectory(workspacePath);
  const realRoot = realpathNative(root);
  const developerName = validateWorkspaceUsername(username);
  if (!bundle || !Array.isArray(bundle.entries) || !bundle.manifest) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板 bundle 无效");
  }
  if (bundle.version && bundle.version !== bundle.manifest.version) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "模板 bundle 版本不一致");
  }
  if (mode !== "initialize" && mode !== "repair") {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "未知初始化模式");
  }
  const selectedTools = resolveTools(bundle.manifest, tools);
  for (const tool of selectedTools) {
    const hasFile = bundle.entries.some(
      (entry) => !entry.isDirectory && entry.name.split("/")[0] === tool
    );
    if (!hasFile) {
      throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, `模板归档缺少 ${tool}`);
    }
  }

  const developerFile = path.join(root, ...DEVELOPER_FILE.split("/"));
  const developerWorkspace = path.join(root, ".trellis", "workspace", developerName);
  assertSafeWorkspacePath(root, realRoot, developerFile);
  assertSafeWorkspacePath(root, realRoot, developerWorkspace);
  const developerStat = lstatOrNull(developerFile);
  const existingDeveloper = readDeveloperName(developerFile);
  const developerExisted = Boolean(developerStat);
  const developerWorkspaceExisted = Boolean(lstatOrNull(developerWorkspace));
  let developerState = "missing";
  if (developerExisted) {
    if (existingDeveloper === developerName) {
      developerState = "same";
    } else {
      developerState = "conflict";
    }
  }
  if (developerState === "conflict" && !confirmDeveloperSwitch) {
    throw fail(
      WORKSPACE_ERROR_CODE.DEVELOPER_CONFLICT,
      "workspace 已绑定其他 developer；请显式确认后再切换"
    );
  }
  const developerNeedsInit = developerState !== "same";

  const selectedTop = new Set([...bundle.manifest.baseFiles, ...selectedTools]);
  const selectedEntries = bundle.entries.filter(
    (entry) => selectedTop.has(entry.name.split("/")[0])
  );
  const tempDir = fs.mkdtempSync(path.join(root, ".trellis-bootstrap-"));
  const createdDirs = [];
  const createdFiles = [];
  const updatedFiles = [];
  const skippedFiles = [];
  const backups = createBackupManager(root, realRoot, now);
  let developerInitialized = false;
  let developerSwitched = false;

  function rollback() {
    for (const relative of [...createdFiles].reverse()) {
      safeRemove(root, realRoot, relative);
    }
    for (const relative of backups.files) {
      const backup = path.join(root, backups.directory, relative);
      safeRestore(root, realRoot, backup, path.join(root, relative));
    }
    for (const directory of [...createdDirs].reverse()) {
      try {
        assertSafeWorkspacePath(root, realRoot, directory);
        fs.rmdirSync(directory);
      } catch {
        // 目录非空、被并发使用或经符号链接逃逸时保留。
      }
    }
    if (!developerExisted) {
      safeRemove(root, realRoot, DEVELOPER_FILE);
    }
    if (!developerWorkspaceExisted) {
      try {
        assertSafeWorkspacePath(root, realRoot, developerWorkspace);
        if (lstatOrNull(developerWorkspace)) {
          fs.rmSync(developerWorkspace, { recursive: true, force: true });
        }
      } catch {
        // 逃逸路径不删除。
      }
    }
    if (backups.directory) {
      try {
        const directory = path.join(root, backups.directory);
        assertSafeWorkspacePath(root, realRoot, directory);
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // 逃逸路径不删除。
      }
    }
  }

  try {
    extractZipEntries(selectedEntries, tempDir);
    const directories = selectedEntries
      .filter((entry) => entry.isDirectory)
      .sort((left, right) => left.name.length - right.name.length);
    for (const entry of directories) {
      const { target } = relativeTemplatePath(root, entry.name);
      ensureDirectoryTracked(root, realRoot, target, createdDirs);
    }

    const files = selectedEntries
      .filter((entry) => !entry.isDirectory)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of files) {
      const { target, relative } = relativeTemplatePath(root, entry.name);
      assertSafeWorkspacePath(root, realRoot, target);
      const source = path.join(tempDir, ...entry.name.split("/"));
      const sourceHash = sha256(entry.data);
      const targetStat = lstatOrNull(target);
      if (targetStat) {
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
          throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_INVALID, "目标路径已被非普通文件占用");
        }
        if (fileHash(target) === sourceHash) {
          skippedFiles.push(relative);
          continue;
        }
        const top = entry.name.split("/")[0];
        if (mode === "repair" && selectedTools.includes(top)) {
          backups.backup(relative);
          assertSafeWorkspacePath(root, realRoot, target);
          fs.copyFileSync(source, target);
          updatedFiles.push(relative);
          continue;
        }
        skippedFiles.push(relative);
        continue;
      }
      ensureDirectoryTracked(root, realRoot, path.dirname(target), createdDirs);
      try {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code === "EEXIST") {
          skippedFiles.push(relative);
          continue;
        }
        throw error;
      }
      createdFiles.push(relative);
    }

    const hashesRelative = TEMPLATE_HASHES_FILE;
    const hashesTarget = path.join(root, ...TEMPLATE_HASHES_FILE.split("/"));
    assertSafeWorkspacePath(root, realRoot, hashesTarget);
    const hashesPayload = templateHashesPayload(
      bundle,
      selectedTools,
      root,
      realRoot
    );
    const existingHashes = lstatOrNull(hashesTarget)
      ? fs.readFileSync(hashesTarget, "utf8")
      : null;
    if (existingHashes !== hashesPayload) {
      ensureDirectoryTracked(root, realRoot, path.dirname(hashesTarget), createdDirs);
      if (existingHashes != null) {
        backups.backup(hashesRelative);
        fs.writeFileSync(hashesTarget, hashesPayload);
        updatedFiles.push(hashesRelative);
      } else {
        fs.writeFileSync(hashesTarget, hashesPayload, { flag: "wx" });
        createdFiles.push(hashesRelative);
      }
    } else {
      skippedFiles.push(hashesRelative);
    }

    if (developerState === "conflict") {
      backups.backup(DEVELOPER_FILE);
      safeRemove(root, realRoot, DEVELOPER_FILE);
      developerSwitched = true;
    }
    if (developerNeedsInit) {
      initializeDeveloper(root, realRoot, developerName, now, createdDirs);
      developerInitialized = true;
      if (!developerExisted) {
        createdFiles.push(DEVELOPER_FILE);
      }
    }
    const actualDeveloper = readDeveloperName(developerFile);
    if (actualDeveloper !== developerName) {
      throw fail(WORKSPACE_ERROR_CODE.DEVELOPER_INIT_FAILED, "developer 名称校验失败");
    }
    const developerWorkspaceFiles = ensureDeveloperWorkspaceFiles(
      root,
      realRoot,
      developerName,
      now,
      createdDirs
    );
    createdFiles.push(...developerWorkspaceFiles);
    for (const fileName of ["journal-1.md", "index.md"]) {
      if (!lstatOrNull(path.join(developerWorkspace, fileName))) {
        throw fail(WORKSPACE_ERROR_CODE.DEVELOPER_INIT_FAILED, "developer workspace 文件缺失");
      }
    }

    const result = {
      workspace: path.basename(root),
      templateVersion: bundle.manifest.version,
      templateSha256: bundle.sha256,
      source: bundle.source,
      developer: developerName,
      tools: [...selectedTools],
      createdFiles: [...createdFiles].sort(),
      updatedFiles: [...updatedFiles].sort(),
      skippedFiles: [...skippedFiles].sort(),
      backupDir: backups.directory,
      developerInitialized,
      developerSwitched,
      changed: createdFiles.length > 0 ||
        updatedFiles.length > 0 ||
        developerInitialized
    };
    logger?.info?.("workspace 初始化完成", {
      version: result.templateVersion,
      sha256: result.templateSha256.slice(0, 12),
      source: result.source,
      created: result.createdFiles.length,
      updated: result.updatedFiles.length,
      skipped: result.skippedFiles.length,
      developer: result.developer,
      switched: result.developerSwitched
    });
    return result;
  } catch (error) {
    rollback();
    logger?.error?.("workspace 初始化失败，已回滚", {
      code: error?.code || "WORKSPACE_FAILED",
      version: bundle.manifest.version
    });
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function initializeWorkspace(options = {}) {
  const workspacePath = await assertWorkspaceDirectory(options.workspacePath);
  let bundle = options.bundle || null;
  if (!bundle && options.archive) {
    bundle = loadTemplateBundle(options.archive, {
      expectedSha256: options.expectedSha256 || null,
      version: options.templateVersion || null
    });
  }
  if (!bundle && options.archivePath) {
    bundle = loadTemplateArchive(options.archivePath, {
      expectedSha256: options.expectedSha256 || null,
      version: options.templateVersion || null
    });
  }
  if (!bundle) {
    bundle = await downloadWorkspaceTemplate(options);
  }
  if (options.expectedSha256 &&
      bundle.sha256 !== String(options.expectedSha256).toLowerCase()) {
    throw fail(WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH, "模板 SHA-256 校验失败");
  }
  return applyWorkspaceTemplate({
    ...options,
    workspacePath,
    bundle
  });
}
