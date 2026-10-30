export const FILTER_STAGES = [
  { id: "prd", label: "需求" },
  { id: "research", label: "调研" },
  { id: "design", label: "设计" },
  { id: "implementPlan", label: "实施计划" },
  { id: "context", label: "上下文编排" },
  { id: "review", label: "规划评审" },
  { id: "implement", label: "实现" },
  { id: "check", label: "检查" },
  { id: "e2e", label: "真实验证" },
  { id: "spec", label: "规范回写" },
  { id: "commit", label: "工作提交" },
  { id: "archive", label: "归档" },
  { id: "journal", label: "会话记录" }
];

export const BUILTIN_VIEWS = [
  { id: "all", name: "全部进行中" },
  {
    id: "today",
    name: "今日焦点",
    matches(task) {
      const reasons = task.execution?.attentionReasons || [];
      return reasons.some((reason) => ["overdue", "due_soon", "priority"].includes(reason)) ||
        task.derivedStage === "check";
    }
  },
  { id: "priority", name: "P0/P1", filter: { priorities: ["P0", "P1"] } },
  { id: "due-soon", name: "临近截止", filter: { dueWithinDays: 3 } },
  { id: "stale", name: "长时间未动", filter: { staleDays: 5 } },
  { id: "implementing", name: "实现中", filter: { stages: ["implement"] } },
  { id: "checking", name: "检查中", filter: { stages: ["check"] } }
];

export const ATTENTION_REASON_LABELS = {
  identity_conflict: "执行身份冲突",
  overdue: "已逾期",
  due_soon: "临近截止",
  priority: "P0/P1",
  stale: "长时间未动",
  implementing: "实现中",
  checking: "检查中"
};

export function normalizeTagsInput(value, { rejectEmpty = false } = {}) {
  const raw = typeof value === "string" ? value.split(/[,，]/) : value;
  if (!Array.isArray(raw)) throw new Error("标签必须是逗号分隔文本或数组");
  const tags = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") throw new Error("每个标签都必须是文本");
    const tag = item.trim();
    if (!tag) {
      if (rejectEmpty) throw new Error("标签不能为空");
      continue;
    }
    if (Array.from(tag).length > 32) throw new Error("单个标签不能超过 32 个字符");
    const key = tag.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > 10) throw new Error("标签最多 10 个");
  return tags;
}

export function taskTagNames(task) {
  return Array.isArray(task.execution?.tags)
    ? task.execution.tags
    : Array.isArray(task.tags)
      ? task.tags
      : [];
}

export function localDaySerial(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const offset = new Date(0);
  offset.setUTCHours(0, 0, 0, 0);
  offset.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(offset.getTime() / 86_400_000);
}

export function dueDateDistance(dueDate, now = new Date()) {
  if (typeof dueDate !== "string") return null;
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const nowSerial = localDaySerial(now);
  if (!match || nowSerial == null) return null;
  const due = new Date(0);
  due.setUTCHours(0, 0, 0, 0);
  due.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const dueSerial = Math.floor(due.getTime() / 86_400_000);
  return dueSerial - nowSerial;
}

function staleDays(task, now) {
  const lastActivity = Date.parse(task.execution?.lastActivityAt || "");
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(lastActivity) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.floor((current - lastActivity) / 86_400_000));
}

export function taskMatchesFilter(task, filter = {}, now = new Date()) {
  const conditions = [];
  if (Array.isArray(filter.priorities) && filter.priorities.length) {
    conditions.push(filter.priorities.includes(task.priority));
  }
  if (Array.isArray(filter.stages) && filter.stages.length) {
    conditions.push(filter.stages.includes(task.derivedStage));
  }
  if (Array.isArray(filter.tags) && filter.tags.length) {
    const taskTags = new Set(taskTagNames(task).map((tag) => tag.toLocaleLowerCase("zh-CN")));
    conditions.push(filter.tags.some((tag) =>
      taskTags.has(String(tag).trim().toLocaleLowerCase("zh-CN"))
    ));
  }
  if (filter.dueWithinDays != null) {
    const distance = dueDateDistance(task.execution?.dueDate, now);
    conditions.push(distance != null && distance <= Number(filter.dueWithinDays));
  }
  if (filter.staleDays != null) {
    const currentStaleDays = staleDays(task, now);
    conditions.push(
      task.execution?.historyStatus === "tracking" &&
      currentStaleDays != null &&
      currentStaleDays >= Number(filter.staleDays)
    );
  }
  return conditions.length > 0 && conditions.every(Boolean);
}

export function taskMatchesView(task, view, now = new Date()) {
  if (!view || view.id === "all") return true;
  if (typeof view.matches === "function") return Boolean(view.matches(task, now));
  return taskMatchesFilter(task, view.filter || {}, now);
}

export function findView(savedViews, id) {
  if (!id || id === "all") return BUILTIN_VIEWS[0];
  return BUILTIN_VIEWS.find((view) => view.id === id) ||
    savedViews?.find((view) => view.id === id) ||
    BUILTIN_VIEWS[0];
}
