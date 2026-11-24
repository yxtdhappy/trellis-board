import fs from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 桌面客户端内嵌的 Pi / OMP 模板补齐 helper。
// 由 trellis_cli.rs 以 `node --input-type=module -` 从 stdin 执行：所有参数来自命令行，
// 不写入任何临时脚本。repair 只做直写（openSync "wx"），不经过原子写用的临时文件 + rename，
// 因为 Windows DLP 会以 EXDEV 拦截 Node 的该组合。
const MODES = new Set(["snapshot", "repair", "hash", "developer"]);
const USAGE =
  "用法: node --input-type=module - <trellis.js> <repo> <snapshot|repair|hash|developer> [...]";
const WINDOWS_DRIVE = /^[A-Za-z]:/;

// Node 的 JS 版 realpathSync 会先 lstat 盘符根（Windows 上是 "D:"），部分 DLP/网络盘会以
// EISDIR 拦截；Node 24 的 ESM resolver 在入口执行前已解构缓存 JS 版 realpathSync，
// 因此同时注册 registerHooks 拦截本地模块路径，改用 native 版解析。
const nativeRealpath = fs.realpathSync.native;
if (typeof nativeRealpath === "function") {
  fs.realpathSync = nativeRealpath;
  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBuiltin(specifier)) {
          return nextResolve(specifier, context);
        }
        let target = null;
        if (specifier.startsWith("file:")) {
          target = fileURLToPath(specifier);
        } else if (
          (specifier.startsWith("./") ||
            specifier.startsWith("../") ||
            specifier.startsWith("/")) &&
          context.parentURL?.startsWith("file:")
        ) {
          target = fileURLToPath(new URL(specifier, context.parentURL));
        }
        if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
          return {
            url: pathToFileURL(nativeRealpath(target)).href,
            shortCircuit: true,
          };
        }
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (error?.code === "EISDIR" && context.parentURL?.startsWith("file:")) {
            const fallback = createRequire(context.parentURL).resolve(specifier);
            return {
              url: pathToFileURL(nativeRealpath(fallback)).href,
              shortCircuit: true,
            };
          }
          throw error;
        }
      },
    });
  }
}

function fail(message) {
  throw new Error(message);
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function normalizeRepoPath(raw) {
  let value = raw;
  // 裸盘符是 Windows 的驱动器相对路径；补成盘符根，避免 realpath/lstat 对 "D:" 报 EISDIR。
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(value)) {
    value += path.sep;
  }
  return path.resolve(value);
}

function isDriveRoot(value) {
  return process.platform === "win32" && /^[A-Za-z]:\\$/.test(value);
}

// Node 的 JS 版 realpathSync 会先 binding.lstat 盘符根（Windows 上即 "D:"），
// 部分 DLP/网络盘会以 EISDIR 拦截；native 版走系统 API，不经过该 lstat。
function realpathSync(target) {
  return nativeRealpath ? nativeRealpath(target) : fs.realpathSync(target);
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail("模板路径为空");
  }
  if (relativePath.includes("\0") || relativePath.includes("\\")) {
    fail(`模板路径非法: ${relativePath}`);
  }
  if (path.isAbsolute(relativePath) || WINDOWS_DRIVE.test(relativePath)) {
    fail(`模板路径不能是绝对路径: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes(":")) {
      fail(`模板路径含非法段: ${relativePath}`);
    }
  }
  return segments;
}

function isInsideRoot(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeIfMissing(target, content) {
  try {
    fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

function readDeveloperName(devFile) {
  let content;
  try {
    content = fs.readFileSync(devFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("name=")) {
      const value = line.slice("name=".length).trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function validateDeveloperName(raw) {
  if (typeof raw !== "string") {
    fail("developer 名称无效");
  }
  const name = raw.trim();
  if (!name) {
    fail("developer 名称不能为空");
  }
  if (name.length > 120) {
    fail("developer 名称不能超过 120 个字符");
  }
  if (name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    fail(`developer 名称含非法字符: ${name}`);
  }
  if (/[. ]$/.test(name)) {
    fail(`developer 名称不能以点或空格结尾: ${name}`);
  }
  return name;
}

function journalContent(name) {
  return `# Journal - ${name} (Part 1)

> AI development session journal
> Started: ${new Date().toISOString().slice(0, 10)}

---

`;
}

function indexContent(name) {
  return `# Workspace Index - ${name}

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

// 与 Trellis 0.6.17 的 .trellis/scripts/common/developer.py 保持一致：
// 有效 .developer 已存在时不覆盖；只补缺失的 journal-1.md 与 index.md。
function initializeDeveloper(realRoot, args) {
  if (args.length !== 1) {
    fail("developer 模式需要一个名称");
  }
  const name = validateDeveloperName(args[0]);
  const trellisDir = path.join(realRoot, ".trellis");
  const trellisStats = lstatOrNull(trellisDir);
  if (!trellisStats || (!trellisStats.isDirectory() && !trellisStats.isSymbolicLink())) {
    fail("Trellis 目录不存在，无法初始化 developer");
  }
  const realTrellis = realpathSync(trellisDir);
  if (!isInsideRoot(realRoot, realTrellis)) {
    fail("Trellis 目录越界");
  }

  const devFile = path.join(realTrellis, ".developer");
  const devStats = lstatOrNull(devFile);
  if (devStats) {
    if (!devStats.isFile() && !devStats.isSymbolicLink()) {
      fail(".developer 不是普通文件");
    }
    if (devStats.isSymbolicLink()) {
      const realDev = realpathSync(devFile);
      if (!isInsideRoot(realRoot, realDev)) {
        fail(".developer 路径越界");
      }
    }
    const existing = readDeveloperName(devFile);
    if (existing) {
      writeJson({ developer: existing, created: false });
      return;
    }
  }

  const workspaceRoot = requireDirectoryInsideRoot(
    realRoot,
    path.join(realTrellis, "workspace"),
    ".trellis/workspace",
  );
  const workspaceDir = path.join(workspaceRoot, name);
  const workspaceStats = lstatOrNull(workspaceDir);
  if (workspaceStats && !workspaceStats.isDirectory() && !workspaceStats.isSymbolicLink()) {
    fail("developer workspace 不是目录");
  }
  if (!workspaceStats) {
    fs.mkdirSync(workspaceDir);
  }
  const realWorkspaceDir = realpathSync(workspaceDir);
  if (!isInsideRoot(realRoot, realWorkspaceDir)) {
    fail("developer workspace 路径越界");
  }

  writeIfMissing(path.join(realWorkspaceDir, "journal-1.md"), journalContent(name));
  writeIfMissing(path.join(realWorkspaceDir, "index.md"), indexContent(name));
  // .developer 最后写：前面任一步失败时下次仍会重新进入并补齐。
  fs.writeFileSync(
    devFile,
    `name=${name}\ninitialized_at=${new Date().toISOString()}\n`,
    "utf8",
  );
  writeJson({
    developer: name,
    created: true,
    workspace: path.relative(realRoot, realWorkspaceDir).replaceAll("\\", "/"),
  });
}

function requireDirectoryInsideRoot(realRoot, directory, relativePath) {
  const stats = lstatOrNull(directory);
  if (stats) {
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      fail(`模板目录不是目录: ${relativePath}`);
    }
    const realDirectory = realpathSync(directory);
    if (!isInsideRoot(realRoot, realDirectory)) {
      fail(`模板路径越界: ${relativePath}`);
    }
    return realDirectory;
  }
  fs.mkdirSync(directory);
  const realDirectory = realpathSync(directory);
  if (!isInsideRoot(realRoot, realDirectory)) {
    fail(`模板路径越界: ${relativePath}`);
  }
  return realDirectory;
}

function resolveRepairTarget(realRoot, relativePath) {
  const segments = validateRelativePath(relativePath);
  let current = realRoot;
  for (const segment of segments.slice(0, -1)) {
    current = requireDirectoryInsideRoot(
      realRoot,
      path.join(current, segment),
      relativePath,
    );
  }
  const target = path.join(current, segments[segments.length - 1]);
  if (!isInsideRoot(realRoot, target)) {
    fail(`模板路径越界: ${relativePath}`);
  }
  return target;
}

// 只读定位：任一段缺失、不是目录、或解析到仓库根外时返回 null，由调用方跳过。
function resolveExistingFile(realRoot, relativePath) {
  const segments = validateRelativePath(relativePath);
  let current = realRoot;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(current, segment);
    const stats = lstatOrNull(next);
    if (!stats) {
      return null;
    }
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      return null;
    }
    const realDirectory = realpathSync(next);
    if (!isInsideRoot(realRoot, realDirectory)) {
      return null;
    }
    current = realDirectory;
  }
  const target = path.join(current, segments[segments.length - 1]);
  if (!isInsideRoot(realRoot, target)) {
    return null;
  }
  const stats = lstatOrNull(target);
  if (!stats || !stats.isFile()) {
    return null;
  }
  return target;
}

function collectTemplates(configurators, platformId) {
  const templates = configurators.collectPlatformTemplates(platformId);
  if (!templates || typeof templates.keys !== "function" || templates.size === 0) {
    fail(`Trellis 平台 ${platformId} 没有可补齐的模板`);
  }
  return templates;
}

function validatePlatforms(configurators, requested) {
  if (!Array.isArray(requested) || requested.length === 0) {
    fail(USAGE);
  }
  const unique = new Set(requested);
  if (unique.size !== requested.length) {
    fail("Agent 平台不能重复选择");
  }
  const unknown = [...unique].filter(
    (platformId) => !configurators.PLATFORM_IDS.includes(platformId),
  );
  if (unknown.length > 0) {
    fail(`Trellis 不支持的 Agent 平台: ${unknown.join(", ")}`);
  }
  return [...requested];
}

function collectPlatformTemplates(configurators, platforms) {
  const templates = new Map();
  for (const platformId of platforms) {
    for (const [relativePath, content] of collectTemplates(configurators, platformId)) {
      validateRelativePath(relativePath);
      if (typeof content !== "string") {
        fail(`模板内容非法: ${relativePath}`);
      }
      if (templates.has(relativePath)) {
        if (templates.get(relativePath) !== content) {
          fail(`多个平台的模板内容冲突: ${relativePath}`);
        }
        continue;
      }
      templates.set(relativePath, content);
    }
  }
  return templates;
}

function parseHashPayload(raw) {
  if (!raw) {
    fail("hash 模式缺少参数");
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail("hash 模式参数不是合法 JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("hash 模式参数必须是对象");
  }
  if (!Array.isArray(payload.platforms) || !Array.isArray(payload.missing)) {
    fail("hash 模式参数缺少 platforms 或 missing");
  }
  return payload;
}

async function main() {
  const [cliPath, repoPath, mode, ...rest] = process.argv.slice(2);
  if (!cliPath || !repoPath || !mode || !MODES.has(mode)) {
    fail(USAGE);
  }

  process.env.TRELLIS_QUIET = "1";

  const packageRoot = path.resolve(path.dirname(cliPath), "..");
  const modules = {
    configurators: path.join(packageRoot, "dist", "configurators", "index.js"),
  };
  if (mode === "repair" || mode === "hash") {
    modules.init = path.join(packageRoot, "dist", "commands", "init.js");
  }
  if (mode === "hash") {
    modules.hashes = path.join(packageRoot, "dist", "utils", "template-hash.js");
  }
  for (const [name, modulePath] of Object.entries(modules)) {
    if (!fs.existsSync(modulePath)) {
      const relativePath = path
        .relative(packageRoot, modulePath)
        .replaceAll("\\", "/");
      fail(`Trellis 运行时缺少模板补齐模块 ${name}: ${relativePath}`);
    }
  }

  const load = (modulePath) => import(pathToFileURL(modulePath).href);
  const configurators = await load(modules.configurators);
  if (
    !Array.isArray(configurators.PLATFORM_IDS) ||
    typeof configurators.collectPlatformTemplates !== "function"
  ) {
    fail("Trellis 运行时缺少模板收集接口");
  }

  let realRoot = normalizeRepoPath(repoPath);
  // 部分 DLP/网络盘会在 realpath/stat 盘符根时内部 lstat "D:" 并报 EISDIR；
  // 盘符根本身已经是绝对目录，跳过这两个调用，后续目标路径仍逐段做 realpath 校验。
  if (!isDriveRoot(realRoot)) {
    realRoot = normalizeRepoPath(realpathSync(realRoot));
  }
  if (!isDriveRoot(realRoot) && !fs.statSync(realRoot).isDirectory()) {
    fail("仓库路径不是目录");
  }

  if (mode === "developer") {
    initializeDeveloper(realRoot, rest);
    return;
  }

  if (mode === "snapshot") {
    const platforms = validatePlatforms(configurators, rest);
    const missing = new Set();
    const existing = new Set();
    for (const platformId of platforms) {
      for (const relativePath of collectTemplates(configurators, platformId).keys()) {
        validateRelativePath(relativePath);
        const target = path.join(realRoot, ...relativePath.split("/"));
        if (lstatOrNull(target)) {
          existing.add(relativePath);
        } else {
          missing.add(relativePath);
        }
      }
    }
    writeJson({ missing: [...missing], existing: [...existing] });
    return;
  }

  const initModule = await load(modules.init);
  if (typeof initModule.resolveSupportedPython !== "function") {
    fail("Trellis 运行时缺少 Python 解析接口");
  }

  if (mode === "repair") {
    const platforms = validatePlatforms(configurators, rest);
    initModule.resolveSupportedPython();
    const templates = collectPlatformTemplates(configurators, platforms);
    const created = [];
    let skipped = 0;
    try {
      for (const [relativePath, content] of templates) {
        const target = resolveRepairTarget(realRoot, relativePath);
        if (lstatOrNull(target)) {
          skipped += 1;
          continue;
        }
        let handle;
        try {
          handle = fs.openSync(target, "wx");
          // 从创建成功起就纳入回滚范围，写入或 close 失败时不能留下半成品。
          created.push({ relativePath, target });
          fs.writeFileSync(handle, content, "utf8");
        } catch (error) {
          if (handle !== undefined) {
            try {
              fs.closeSync(handle);
            } catch {
              // 尽力而为
            }
            handle = undefined;
          }
          if (error && error.code === "EEXIST") {
            skipped += 1;
            continue;
          }
          throw error;
        }
        fs.closeSync(handle);
      }
    } catch (error) {
      for (const entry of created.reverse()) {
        try {
          fs.unlinkSync(entry.target);
        } catch {
          // 尽力而为：只清理本次创建的文件
        }
      }
      throw error;
    }
    writeJson({ created: created.map((entry) => entry.relativePath), skipped });
    return;
  }

  const hashes = await load(modules.hashes);
  if (typeof hashes.initializeHashes !== "function") {
    fail("Trellis 运行时缺少模板哈希接口");
  }
  const payload = parseHashPayload(rest[0]);
  initModule.resolveSupportedPython();
  const platforms = validatePlatforms(configurators, payload.platforms);
  const templates = collectPlatformTemplates(configurators, platforms);
  const hashed = [];
  const skipped = [];
  for (const relativePath of payload.missing) {
    const templateContent =
      typeof relativePath === "string" ? templates.get(relativePath) : undefined;
    if (templateContent === undefined) {
      skipped.push(relativePath);
      continue;
    }
    let target = null;
    try {
      target = resolveExistingFile(realRoot, relativePath);
    } catch {
      target = null;
    }
    if (!target) {
      skipped.push(relativePath);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(target, "utf8");
    } catch {
      skipped.push(relativePath);
      continue;
    }
    if (content !== templateContent) {
      skipped.push(relativePath);
      continue;
    }
    hashed.push(relativePath);
  }
  if (hashed.length > 0) {
    hashes.initializeHashes(realRoot, { trackedPaths: hashed, merge: true });
  }
  writeJson({ hashed, skipped });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}