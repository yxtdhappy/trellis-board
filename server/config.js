import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(serverDir, "..");
export const dataDir = path.join(appDir, "data");
export const databaseFile = path.join(dataDir, "board.sqlite");
export const metadataFile = path.join(dataDir, "task-metadata.json");
export const scanCacheFile = path.join(dataDir, "scan-cache.json");
export const stateFile = path.join(dataDir, "board-state.json");
export const repositoriesFile = path.join(dataDir, "repos.json");

export const defaultRepositories = [
  "D:/wit/mdp-management-web",
  "D:/wit/mdp-report-service",
  "D:/wit/mdp-report-config-agent-service",
  "D:/wit/mdp-backend-service",
  "D:/wit/mdp-backend-web"
];

export function normalizeRepositoryEntry(repo) {
  const rawPath = String(repo?.path || "").trim();
  if (!rawPath) throw new Error("仓库配置中存在缺少 path 的项目");
  const repoPath = path.resolve(rawPath);
  const basename = path.basename(repoPath);
  return {
    id: String(repo.id || basename).trim() || basename,
    name: String(repo.name || basename).trim() || basename,
    path: repoPath.replaceAll("\\", "/")
  };
}

export function repositoryPathKey(repoPath) {
  const resolved = path.resolve(repoPath).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
