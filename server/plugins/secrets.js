import fs from "node:fs";
import path from "node:path";

export const SECRETS_VERSION = 1;
export const SECRETS_FILENAME = "plugins.secrets.json";
const SECRET_KEY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SECRET_REF_PATTERN = /^secret:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/;
const ENV_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const INLINE_SENSITIVE_PATTERN = /(password|passwd|token|secret|api[_-]?key|private[_-]?key|authorization|cookie|credential)/i;

export function defaultSecretsFile(configFile) {
  return path.join(path.dirname(configFile), SECRETS_FILENAME);
}

function parseJsonWithoutLeak(text, file) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(file)} 不是合法 JSON`);
  }
}

function assertOwnerOnly(file) {
  if (process.platform === "win32") return;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `${path.basename(file)} 权限过宽（${mode.toString(8)}），请执行 chmod 600 ${file}`
    );
  }
}

export function loadSecretsFile(file) {
  if (!file || !fs.existsSync(file)) {
    return { file, refs: new Map(), warnings: [] };
  }
  assertOwnerOnly(file);
  const raw = parseJsonWithoutLeak(fs.readFileSync(file, "utf8"), file);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path.basename(file)} 顶层必须是对象`);
  }
  if (raw.version !== SECRETS_VERSION) {
    throw new Error(`${path.basename(file)} 缺少 version: ${SECRETS_VERSION}`);
  }
  if (!raw.refs || typeof raw.refs !== "object" || Array.isArray(raw.refs)) {
    throw new Error(`${path.basename(file)} 缺少 refs 对象`);
  }
  const refs = new Map();
  for (const [key, value] of Object.entries(raw.refs)) {
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`${path.basename(file)} 的 refs key 必须形如 scope/key: ${key}`);
    }
    if (typeof value !== "string" || value === "") {
      throw new Error(`${path.basename(file)} 的 ${key} 必须是非空字符串`);
    }
    refs.set(key, value);
  }
  const warnings = [];
  const unknown = Object.keys(raw).filter((key) => key !== "version" && key !== "refs");
  if (unknown.length) {
    warnings.push({ kind: "unknown-top-level", keys: unknown });
  }
  return { file, refs, warnings };
}

function isSensitivePath(at) {
  const segment = String(at).split(".").at(-1)?.replace(/\[\d+\]$/, "") ?? "";
  return INLINE_SENSITIVE_PATTERN.test(segment);
}

export function resolveConfigReferences(value, {
  env = process.env,
  refs = new Map(),
  missing = [],
  sources = {}
} = {}, at = "") {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const secretMatch = SECRET_REF_PATTERN.exec(trimmed);
    if (secretMatch) {
      const key = secretMatch[1];
      if (!refs.has(key)) {
        missing.push(`secret:${key}`);
        return null;
      }
      if (at) sources[at] = "secret";
      return refs.get(key);
    }
    if (trimmed.startsWith("secret:")) {
      throw new Error("secret 引用格式错误，应为 secret:scope/key");
    }
    const envMatch = ENV_REF_PATTERN.exec(trimmed);
    if (envMatch) {
      const name = envMatch[1];
      if (at) sources[at] = "env";
      const resolved = env[name];
      if (resolved == null || resolved === "") {
        missing.push(name);
        return null;
      }
      return resolved;
    }
    if (at && value !== "" && isSensitivePath(at)) {
      sources[at] = "inline";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveConfigReferences(item, {
      env,
      refs,
      missing,
      sources
    }, at ? `${at}[${index}]` : `[${index}]`));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = resolveConfigReferences(item, {
        env,
        refs,
        missing,
        sources
      }, at ? `${at}.${key}` : key);
    }
    return result;
  }
  return value;
}

export function summarizeSources(sources) {
  const values = [...new Set(Object.values(sources))];
  if (!values.length) return "none";
  if (values.length === 1) return values[0];
  return "mixed";
}

export function inlineSecretFields(sources) {
  return Object.entries(sources)
    .filter(([, source]) => source === "inline")
    .map(([field]) => field);
}
