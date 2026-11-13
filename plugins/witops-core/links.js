/**
 * Trellis ↔ WitOps 关联索引。
 *
 * 唯一真源是 `task.json.meta.witops`：businessId 用于任务，storyId 用于需求。
 * 缓存只是加速，丢了可以从 task.json 重建（不再依赖插件私有 store）。
 */
import { normalizeId } from "./util.js";

export function createLinkIndex({ ctx, config }) {
  let cache = null;
  let pending = null;

  function ttl() {
    return Number(config.cacheTtlMs || 0);
  }

  function fresh() {
    return Boolean(cache) && Date.now() - cache.at <= ttl();
  }

  async function load(force = false) {
    if (!force && fresh()) return cache.value;
    if (pending) return pending;
    pending = (async () => {
      const tasks = await ctx.tasks.list({ includeArchived: true });
      const byBusinessId = new Map();
      const byStoryId = new Map();
      for (const task of tasks) {
        const meta = task.meta?.witops;
        if (!meta) continue;
        const link = {
          taskKey: task.taskKey,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          archived: Boolean(task.archived),
          code: meta.code ?? null,
          type: meta.type ?? null,
          businessId: normalizeId(meta.businessId),
          storyId: normalizeId(meta.storyId),
          storyCode: normalizeId(meta.storyCode),
          storyName: meta.storyName ?? null,
          dueDate: meta.dueDate ?? null,
          url: meta.url ?? null
        };
        const businessId = normalizeId(meta.businessId);
        if (businessId) {
          if (!byBusinessId.has(businessId)) byBusinessId.set(businessId, []);
          byBusinessId.get(businessId).push(link);
        }
        const storyId = normalizeId(meta.storyId);
        if (storyId) {
          if (!byStoryId.has(storyId)) byStoryId.set(storyId, []);
          byStoryId.get(storyId).push(link);
        }
      }
      cache = { at: Date.now(), value: { byBusinessId, byStoryId, tasks } };
      return cache.value;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  async function forItem(item) {
    const links = await load();
    const found = [];
    if (item.type === 3) found.push(...(links.byStoryId.get(item.id) ?? []));
    found.push(...(links.byBusinessId.get(item.id) ?? []));
    const unique = new Map();
    for (const link of found) unique.set(link.taskKey, link);
    return [...unique.values()];
  }

  async function find({ type, businessId }) {
    const id = normalizeId(businessId);
    if (!id) return [];
    const links = await load();
    const found = [...(links.byBusinessId.get(id) ?? [])];
    if (Number(type) === 3) found.push(...(links.byStoryId.get(id) ?? []));
    const unique = new Map();
    for (const link of found) unique.set(link.taskKey, link);
    return [...unique.values()];
  }

  async function listImported({ limit = 200 } = {}) {
    const links = await load();
    const seen = new Set();
    const items = [];
    for (const group of links.byBusinessId.values()) {
      for (const link of group) {
        if (seen.has(link.taskKey)) continue;
        seen.add(link.taskKey);
        items.push(link);
      }
    }
    items.sort((left, right) => String(left.taskKey).localeCompare(String(right.taskKey)));
    return items.slice(0, Math.max(1, Number(limit) || 200));
  }

  function invalidate() {
    cache = null;
  }

  return { load, forItem, find, listImported, invalidate };
}
