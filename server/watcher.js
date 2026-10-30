import fs from "node:fs";
import path from "node:path";

const WATCHED_ROOTS = ["tasks", "workspace"];

function relevantPath(value) {
  const relativePath = normalizeWatchPath(value);
  if (!relativePath) return null;
  if (relativePath === ".developer") return relativePath;
  const root = WATCHED_ROOTS.find((candidate) =>
    relativePath === candidate || relativePath.startsWith(`${candidate}/`)
  );
  return root ? relativePath : null;
}

export function normalizeWatchPath(value) {
  if (value == null) return "";
  return String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

export function isRelevantTrellisChange(value) {
  return Boolean(relevantPath(value));
}

export function createWatchRuntime({
  repositories,
  onChange,
  onError = () => {},
  watch = fs.watch
}) {
  const watchers = [];
  const watchedRepositories = [];
  const errors = new Map();
  let lastEvent = null;
  let eventsSeen = 0;

  for (const repository of repositories) {
    const root = path.join(repository.path, ".trellis");
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;

    try {
      const watcher = watch(
        root,
        { recursive: true, encoding: "utf8", persistent: true },
        (eventType, filename) => {
          // Some platforms may omit the filename; in that case a full scan is
          // safer than silently missing a task status change.
          const relativePath = normalizeWatchPath(filename);
          if (relativePath && !isRelevantTrellisChange(relativePath)) return;
          lastEvent = {
            repositoryId: repository.id,
            repositoryName: repository.name,
            eventType,
            relativePath,
            filePath: relativePath ? path.join(root, ...relativePath.split("/")) : root,
            observedAt: new Date().toISOString()
          };
          eventsSeen += 1;
          onChange(lastEvent);
        }
      );
      watcher.on("error", (error) => {
        const record = {
          repositoryId: repository.id,
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString()
        };
        errors.set(repository.id, record);
        onError(record);
      });
      watchers.push(watcher);
      watchedRepositories.push(repository.id);
    } catch (error) {
      const record = {
        repositoryId: repository.id,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      };
      errors.set(repository.id, record);
      onError(record);
    }
  }

  return {
    watchedRepositories,
    status() {
      return {
        enabled: watchers.length > 0,
        watchedRepositories: [...watchedRepositories],
        watchedRoots: [...WATCHED_ROOTS],
        eventsSeen,
        lastEvent,
        errors: [...errors.values()]
      };
    },
    close() {
      watchers.forEach((watcher) => watcher.close());
      watchers.length = 0;
    }
  };
}
