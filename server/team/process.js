import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 64 * 1024;
const ALLOWED_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "COMSPEC"
];

export function minimalEnvironment(extra = {}) {
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

export function sanitizeProcessOutput(value) {
  return String(value || "")
    .replace(/(?:https?|ssh):\/\/[^/\s@]+@/gi, (match) =>
      match.replace(/[^/]+@$/, "***@")
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
    .slice(0, OUTPUT_LIMIT);
}

function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // 进程可能已结束。
      }
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 进程可能已结束。
  }
}

export function runProcess(command, args, {
  cwd,
  env = minimalEnvironment(),
  timeoutMs = 30_000,
  allowFailure = false
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateTree(child);
      reject(new Error(`${command} 执行超过 ${timeoutMs}ms，已终止`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: sanitizeProcessOutput(stdout),
        stderr: sanitizeProcessOutput(stderr)
      };
      if (code === 0 || allowFailure) {
        resolve(result);
        return;
      }
      reject(new Error(
        result.stderr.trim() ||
        result.stdout.trim() ||
        `${command} 退出码 ${code}`
      ));
    });
  });
}
