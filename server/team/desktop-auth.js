import crypto from "node:crypto";
import { appendAuditEvent } from "./audit.js";
import { ERROR_CODES, teamError } from "./errors.js";

export const DESKTOP_ENROLL_TOKEN_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_DESKTOP_ENROLL_TOKENS = 5;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function invalidToken(reason) {
  const messages = {
    used: "设备令牌已使用，请在 Board 重新生成",
    expired: "设备令牌已过期，请在 Board 重新生成",
    invalid: "设备令牌无效，请在 Board 重新生成"
  };
  return teamError(
    401,
    ERROR_CODES.DESKTOP_TOKEN_INVALID,
    messages[reason] || messages.invalid,
    { details: { reason } }
  );
}

function optionalDeviceName(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "设备名称格式无效");
  }
  const name = value.trim();
  if (
    Array.from(name).length < 1 ||
    Array.from(name).length > 80 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "设备名称格式无效");
  }
  return name;
}

/**
 * 一次性桌面设备令牌只在当前进程内存中保存哈希；重启后全部失效，适合单进程部署。
 */
export function createDesktopAuthService({
  db,
  now = () => Date.now(),
  ttlMs = DESKTOP_ENROLL_TOKEN_TTL_MS,
  maxPending = MAX_PENDING_DESKTOP_ENROLL_TOKENS
}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError("桌面设备令牌 TTL 必须是正整数");
  }
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError("桌面设备令牌并发上限必须是正整数");
  }
  const tokens = new Map();
  const pendingByUser = new Map();

  function drop(hash) {
    const record = tokens.get(hash);
    if (!record) return;
    tokens.delete(hash);
    const pending = pendingByUser.get(record.userId);
    if (!pending) return;
    pending.delete(hash);
    if (pending.size === 0) pendingByUser.delete(record.userId);
  }

  function prune(nowMs) {
    for (const [hash, record] of tokens) {
      if (record.expiresAtMs <= nowMs) drop(hash);
    }
  }

  function readToken(value) {
    if (typeof value !== "string") throw invalidToken("invalid");
    const token = value.trim();
    if (!TOKEN_PATTERN.test(token)) throw invalidToken("invalid");
    return token;
  }

  function issue(actor, input = {}) {
    if (!actor?.userId) {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, "需要登录");
    }
    const nowMs = now();
    prune(nowMs);
    const pending = pendingByUser.get(actor.userId)?.size || 0;
    if (pending >= maxPending) {
      throw teamError(
        429,
        ERROR_CODES.RATE_LIMITED,
        "未使用的设备令牌过多，请等待过期后再试"
      );
    }
    const name = optionalDeviceName(input.deviceName);
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = sha256(token);
    const id = crypto.randomUUID();
    const expiresAtMs = nowMs + ttlMs;
    const record = {
      id,
      userId: actor.userId,
      deviceName: name,
      expiresAtMs,
      usedAtMs: null
    };
    tokens.set(hash, record);
    if (!pendingByUser.has(actor.userId)) pendingByUser.set(actor.userId, new Set());
    pendingByUser.get(actor.userId).add(hash);
    const expiresAt = new Date(expiresAtMs).toISOString();
    appendAuditEvent(db, {
      actorUserId: actor.userId,
      teamId: null,
      action: "desktop_enroll_token_issued",
      targetType: "desktop_enroll_token",
      targetId: id,
      detail: { expiresAt, deviceName: name }
    });
    return { token, expiresAt };
  }

  function verify(value) {
    const token = readToken(value);
    const record = tokens.get(sha256(token));
    if (!record) throw invalidToken("invalid");
    if (record.usedAtMs != null) throw invalidToken("used");
    if (record.expiresAtMs <= now()) throw invalidToken("expired");
    return {
      userId: record.userId,
      deviceName: record.deviceName
    };
  }

  /**
   * 兑换成功后才标记已使用；调用方必须在 verify 与 consume 之间保持同步执行。
   */
  function consume(value) {
    const token = readToken(value);
    const record = tokens.get(sha256(token));
    if (!record || record.usedAtMs != null) throw invalidToken("invalid");
    record.usedAtMs = now();
    const pending = pendingByUser.get(record.userId);
    pending?.delete(sha256(token));
    if (pending?.size === 0) pendingByUser.delete(record.userId);
  }

  return { issue, verify, consume };
}
