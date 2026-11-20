import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 桌面客户端内嵌的 Pi / OMP 模板补齐 helper。
// 由 trellis_cli.rs 以 `node --input-type=module -` 从 stdin 执行：所有参数来自命令行，
// 不写入任何临时脚本。repair 只做直写（openSync "wx"），不经过原子写用的临时文件 + rename，
// 因为 Windows DLP 会以 EXDEV 拦截 Node 的该组合。
const MODES = new Set(["snapshot", "repair", "hash"]);
const USAGE =
  "用法: node --input-type=module - <trellis.js> <repo> <snapshot|repair|hash> [...]";
const WINDOWS_DRIVE = /^[A-Za-z]:/;

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

function requireDirectoryInsideRoot(realRoot, directory, relativePath) {
  const stats = lstatOrNull(directory);
  if (stats) {
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      fail(`模板目录不是目录: ${relativePath}`);
    }
    const realDirectory = fs.realpathSync(directory);
    if (!isInsideRoot(realRoot, realDirectory)) {
      fail(`模板路径越界: ${relativePath}`);
    }
    return realDirectory;
  }
  fs.mkdirSync(directory);
  const realDirectory = fs.realpathSync(directory);
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
    const realDirectory = fs.realpathSync(next);
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

  const realRoot = fs.realpathSync(normalizeRepoPath(repoPath));
  if (!fs.statSync(realRoot).isDirectory()) {
    fail("仓库路径不是目录");
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