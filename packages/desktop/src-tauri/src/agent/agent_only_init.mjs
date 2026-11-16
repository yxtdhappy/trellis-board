import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [cliPath, repoPath, ...requestedPlatforms] = process.argv.slice(2);
if (!cliPath || !repoPath || requestedPlatforms.length === 0) {
  throw new Error(
    "用法: node --input-type=module - <trellis.js> <repo> <platform-id...>",
  );
}

process.env.TRELLIS_QUIET = "1";

const packageRoot = path.resolve(path.dirname(cliPath), "..");
const modules = {
  init: path.join(packageRoot, "dist", "commands", "init.js"),
  configurators: path.join(packageRoot, "dist", "configurators", "index.js"),
  writer: path.join(packageRoot, "dist", "utils", "file-writer.js"),
  hashes: path.join(packageRoot, "dist", "utils", "template-hash.js"),
};

for (const [name, modulePath] of Object.entries(modules)) {
  if (!fs.existsSync(modulePath)) {
    const relativePath = path.relative(packageRoot, modulePath).replaceAll("\\", "/");
    throw new Error(
      `Trellis 运行时缺少 Agent 配置模块 ${name}: ${relativePath}`,
    );
  }
}

const load = (modulePath) => import(pathToFileURL(modulePath).href);
const [initModule, configurators, writer, hashes] = await Promise.all([
  load(modules.init),
  load(modules.configurators),
  load(modules.writer),
  load(modules.hashes),
]);

const requested = new Set(requestedPlatforms);
if (requested.size !== requestedPlatforms.length) {
  throw new Error("Agent 平台不能重复选择");
}
const unknown = [...requested].filter(
  (platformId) => !configurators.PLATFORM_IDS.includes(platformId),
);
if (unknown.length > 0) {
  throw new Error(`Trellis 不支持的 Agent 平台: ${unknown.join(", ")}`);
}
const platformIds = configurators.PLATFORM_IDS.filter((platformId) =>
  requested.has(platformId),
);

initModule.resolveSupportedPython();
writer.setWriteMode("skip");
const writtenPaths = writer.startRecordingWrites(repoPath);
try {
  for (const platformId of platformIds) {
    await configurators.configurePlatform(platformId, repoPath, {
      withStatusline: false,
    });
  }
} finally {
  writer.stopRecordingWrites();
}

hashes.initializeHashes(repoPath, {
  trackedPaths: writtenPaths,
  merge: true,
});
