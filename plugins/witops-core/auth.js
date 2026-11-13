/**
 * 平台会话：账号密码为主路径，token 为应急通道。
 *
 * - 配置里有 password：启动即登录；
 * - 配置里没有 password：面板 POST /login 换 token，密码默认不落盘（A）；
 * - 勾选「记住密码」时才写 secrets（宿主 AES-256-GCM 加密落盘，C）。
 */
import { ApiError } from "./witops-client.js";
import { decodeUserId, maskAccount, numberOrNull, text } from "./util.js";

export const PASSWORD_SECRET_KEY = "witops-core/password";

export function resolveAuthMode(credentials = {}) {
  const explicit = text(credentials.mode);
  if (explicit === "token" || explicit === "password") return explicit;
  if (text(credentials.token)) return "token";
  return "password";
}

export function createSession({ ctx, config, client }) {
  const credentials = config.credentials ?? {};
  const mode = resolveAuthMode(credentials);
  const persistSession = config.session?.persist !== false;
  const state = {
    token: null,
    account: text(credentials.account) || null,
    password: text(credentials.password) || null,
    userId: numberOrNull(config.userId),
    source: null,
    obtainedAt: null,
    status: config.baseUrl ? "anonymous" : "unconfigured"
  };

  async function persistSessionRecord(record) {
    if (!persistSession) return;
    try {
      await ctx.store.set("session", record);
    } catch (error) {
      ctx.log.warn("会话持久化失败", { message: error.message });
    }
  }

  async function loadStoredSession() {
    if (!persistSession) return null;
    try {
      return await ctx.store.get("session");
    } catch {
      return null;
    }
  }

  async function login({ account, password, remember = false, source = "panel" } = {}) {
    const useAccount = text(account) || state.account || text(credentials.account);
    let usePassword = text(password) || state.password || text(credentials.password);
    if (useAccount && !usePassword) {
      // 「记住密码」写入的加密 secret 可以直接复用，不用再手输。
      try {
        usePassword = text(await ctx.secrets.get(PASSWORD_SECRET_KEY));
      } catch {
        usePassword = "";
      }
    }
    if (!useAccount || !usePassword) {
      const configToken = text(credentials.token);
      if (configToken) {
        state.token = configToken;
        state.source = "config";
        state.status = "authenticated";
        state.obtainedAt = state.obtainedAt ?? new Date().toISOString();
        state.userId = state.userId ?? decodeUserId(configToken);
        return configToken;
      }
      state.status = "anonymous";
      throw ctx.error(1001, "未登录：请在面板输入平台账号与密码", {
        reason: "missing-credentials"
      });
    }
    const data = await client.login(useAccount, usePassword);
    const token = typeof data === "string"
      ? data
      : data?.token || data?.accessToken || data?.Authorization;
    if (!token || typeof token !== "string") throw ctx.error(1001, "登录成功但响应中没有 token");
    state.token = token;
    state.account = useAccount;
    state.password = usePassword;
    state.userId = numberOrNull(data?.user?.id ?? data?.userId ?? data?.id) ??
      decodeUserId(token) ??
      state.userId;
    state.source = source;
    state.obtainedAt = new Date().toISOString();
    state.status = "authenticated";
    await persistSessionRecord({
      token,
      account: useAccount,
      userId: state.userId,
      obtainedAt: state.obtainedAt
    });
    if (remember) {
      try {
        await ctx.secrets.set(PASSWORD_SECRET_KEY, usePassword);
        ctx.log.info("已记住平台密码", { account: maskAccount(useAccount) });
      } catch (error) {
        ctx.log.warn("记住密码失败", { message: error.message });
      }
    }
    ctx.log.info("平台登录成功", {
      account: maskAccount(useAccount),
      source,
      remember
    });
    return token;
  }

  async function ensureToken() {
    if (state.token) return state.token;
    const stored = await loadStoredSession();
    if (stored?.token) {
      state.token = stored.token;
      state.account = state.account ?? text(stored.account) ?? null;
      state.userId = state.userId ?? numberOrNull(stored.userId);
      state.obtainedAt = stored.obtainedAt ?? null;
      state.source = "stored";
      state.status = "authenticated";
      return stored.token;
    }
    return login({ source: text(credentials.password) ? "config" : "panel" });
  }

  async function authorized(handler) {
    const token = await ensureToken();
    try {
      return await handler(token);
    } catch (error) {
      if (!(error instanceof ApiError) || !error.authExpired) throw error;
      if (mode === "token" && !state.password) {
        state.token = null;
        state.status = "token-expired";
        throw ctx.error(1001, "平台 token 已失效，请更新 credentials.token", {
          platformCode: error.code ?? null
        });
      }
      ctx.log.warn("平台会话过期，重新登录", { platformCode: error.code ?? null });
      state.token = null;
      state.status = "expired";
      return handler(await login({ source: "relogin" }));
    }
  }

  async function logout() {
    state.token = null;
    state.status = "anonymous";
    state.source = null;
    state.obtainedAt = null;
    if (persistSession) {
      try {
        await ctx.store.delete("session");
      } catch {
        // 忽略：会话已经失效。
      }
    }
    return { ok: true };
  }

  async function resolveUserId() {
    const configured = numberOrNull(config.userId);
    if (configured !== null) return configured;
    if (state.userId !== null && state.userId !== undefined) return numberOrNull(state.userId);
    const token = await ensureToken();
    const decoded = decodeUserId(token);
    if (decoded !== null) {
      state.userId = decoded;
      return decoded;
    }
    const data = await authorized((value) => client.findUser({ token: value }));
    const id = numberOrNull(data?.id ?? data?.userId ?? data?.user?.id);
    if (id === null) throw ctx.error(1001, "无法确定当前用户，请配置 userId");
    state.userId = id;
    return id;
  }

  function status() {
    return {
      mode,
      status: state.status,
      source: state.source,
      account: state.account ? maskAccount(state.account) : null,
      userId: state.userId ?? null,
      obtainedAt: state.obtainedAt,
      hasToken: Boolean(state.token || (mode === "token" && text(credentials.token))),
      hasConfigPassword: Boolean(text(credentials.password)),
      hasStoredPassword: false,
      rememberEnabled: Boolean(ctx.secrets?.set)
    };
  }

  return {
    mode,
    state,
    login,
    logout,
    ensureToken,
    authorized,
    resolveUserId,
    status,
    async hasStoredPassword() {
      try {
        return Boolean(await ctx.secrets.get(PASSWORD_SECRET_KEY));
      } catch {
        return false;
      }
    }
  };
}
