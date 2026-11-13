/** 平台字段归一化的公共小工具。 */

export function text(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function pick(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function detailOf(raw) {
  return raw?.nextTaskDetail ?? raw ?? {};
}

export function normalizeId(value) {
  return text(value);
}

export function decodeUserId(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8")
    );
    const account = typeof payload.account === "string" ? JSON.parse(payload.account) : payload.account;
    return numberOrNull(account?.id ?? payload.userId ?? payload.uid);
  } catch {
    return null;
  }
}

export function normalizeStatus(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return text(value.name ?? value.label ?? value.value);
  return text(value);
}

const STATUS_NAMES = new Map([
  [0, "草稿中"],
  [1, "待处理"],
  [2, "已完成"],
  [3, "进行中"],
  [4, "已取消"],
  [97, "待提交"],
  [99, "已关闭"]
]);

/** 平台有时返回状态码、有时返回状态名；统一成可读文案。 */
export function statusLabel(value) {
  const code = numberOrNull(value);
  if (code === null) return normalizeStatus(value);
  return STATUS_NAMES.get(code) ?? String(code);
}

export function flattenTree(node, level = 0, output = []) {
  if (!node || typeof node !== "object") return output;
  const id = normalizeId(pick(node, "businessId", "sourceId", "id"));
  output.push({
    id,
    code: text(pick(node, "code", "businessCode")),
    title: text(pick(node, "name", "title")),
    type: numberOrNull(node.type),
    typeName: text(node.typeName),
    status: normalizeStatus(pick(node, "sourceStatusName", "statusName", "status")),
    assignee: text(pick(node, "assignedToUserName", "assigneeName", "assignee")),
    hours: Number(node.inputWorkHour ?? 0) || 0,
    totalHours: Number(node.childrenTotalWorkHour ?? 0) || 0,
    level,
    children: []
  });
  const parent = output.at(-1);
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const before = output.length;
    flattenTree(child, level + 1, output);
    parent.children.push(...output.slice(before));
  }
  return output;
}

export function maskAccount(value) {
  const account = String(value || "");
  if (account.length <= 2) return account ? "***" : "";
  return `${account.slice(0, 1)}***${account.slice(-1)}`;
}

export function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/** 只取公历日期部分（YYYY-MM-DD），解析不出来返回 null。 */
export function calendarDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const raw = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(raw.getTime())) return null;
  const pad = (part) => String(part).padStart(2, "0");
  return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
}

/** 平台/宿主错误里可能带 ANSI 颜色码，展示前清掉。 */
export function stripAnsi(value) {
  return String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}
