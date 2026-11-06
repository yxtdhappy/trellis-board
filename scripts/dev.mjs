import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const webDir = path.join(rootDir, "web");
const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

function run(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
  child.on("exit", (code) => stop(code ?? 0));
  children.push(child);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run(["--watch", "server/index.js"], rootDir);
run([path.join(webDir, "node_modules", "vite", "bin", "vite.js")], webDir);
