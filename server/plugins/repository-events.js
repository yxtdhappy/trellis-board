/**
 * 仓库白名单变化事件。插件通过 repository.added / repository.removed
 * 感知新的 cwd，不需要重启宿主。
 */
export function publishRepositoryChange(runtime, action, repositories, now = () => new Date().toISOString()) {
  const name = action === "add" ? "repository.added" : "repository.removed";
  const list = Array.isArray(repositories) ? repositories : [repositories];
  for (const repository of list) {
    if (!repository) continue;
    runtime?.publish?.(name, {
      repositoryId: repository.id,
      name: repository.name,
      occurredAt: now()
    });
  }
}
