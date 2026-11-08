import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pythonCommandCandidates } from "./python.js";
import { getRepositories } from "./repositories.js";
import {
  slugifyTaskTitle,
  TASK_SLUG_PATTERN
} from "../shared/slug.js";

const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

function cleanText(value, label, maxLength) {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串`);
  const clean = value.trim();
  if (!clean) throw new Error(`${label}不能为空`);
  if (clean.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return clean;
}

function isPathInside(target, parent) {
  const relative = path.relative(parent, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function runTaskPython(repoPath, args) {
  const script = path.join(repoPath, ".trellis", "scripts", "task.py");
  if (!fs.existsSync(script)) throw new Error("仓库没有 .trellis/scripts/task.py");
  return new Promise((resolve, reject) => {
    const candidates = pythonCommandCandidates(process.env);
    let index = 0;
    const attempt = () => {
      const command = candidates[index];
      const child = spawn(command, [script, ...args], {
        cwd: repoPath,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONUTF8: "1" }
      });
      let stdout = "";
      let stderr = "";
      let failed = false;
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        failed = true;
        if (error.code === "ENOENT" && index + 1 < candidates.length) {
          index += 1;
          attempt();
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        if (failed) return;
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr.trim() || stdout.trim() || `task.py 退出码 ${code}`));
      });
    };
    attempt();
  });
}

export async function createTask(input, { listRepositories = getRepositories } = {}) {
  const repositoryId = cleanText(input.repositoryId, "仓库", 200);
  const title = cleanText(input.title, "任务标题", 200);
  const description = cleanText(input.description, "任务描述", 3000);
  const assignee = cleanText(input.assignee, "负责人", 100);
  const priority = cleanText(input.priority || "P2", "优先级", 2);
  if (!ALLOWED_PRIORITIES.has(priority)) throw new Error("优先级只能是 P0、P1、P2、P3");
  const requestedSlug = input.slug == null || input.slug === ""
    ? ""
    : cleanText(input.slug, "任务标识", 100);
  const slug = requestedSlug || slugifyTaskTitle(title);
  if (!slug) {
    throw new Error("当前标题没有可用的英文标识，请填写任务标识，例如 board-task-export");
  }
  if (!TASK_SLUG_PATTERN.test(slug)) {
    throw new Error("任务标识只能包含英文字母、数字和单个中划线，例如 T100001 或 board-task-export");
  }
  const repo = listRepositories().find((candidate) => candidate.id === repositoryId);
  if (!repo) throw new Error(`仓库不在白名单中: ${repositoryId}`);
  if (!fs.existsSync(path.join(repo.path, ".trellis", "tasks"))) {
    throw new Error("目标目录不是有效的 Trellis 仓库");
  }
  const workspace = path.join(repo.path, ".trellis", "workspace", assignee);
  if (!fs.existsSync(workspace)) {
    throw new Error(`负责人 ${assignee} 尚未初始化 Trellis workspace；请先在目标仓库运行 init_developer.py ${assignee}`);
  }

  const args = [
    "create",
    title,
    "--description",
    description,
    "--assignee",
    assignee,
    "--priority",
    priority,
    "--slug",
    slug,
    "--no-start"
  ];
  if (input.baseBranch) args.push("--base-branch", cleanText(input.baseBranch, "目标分支", 200));
  if (input.packageName) args.push("--package", cleanText(input.packageName, "包名", 100));

  const output = await runTaskPython(repo.path, args);
  return { repository: repo, output };
}

export async function assignTask(input, { listRepositories = getRepositories } = {}) {
  const taskPath = cleanText(input.taskDir, "任务目录", 1000);
  const repositoryId = cleanText(input.repositoryId, "仓库", 200);
  const assignee = cleanText(input.assignee, "负责人", 100);
  const repo = listRepositories().find((candidate) => candidate.id === repositoryId);
  if (!repo) throw new Error(`仓库不在白名单中: ${repositoryId}`);
  if (!fs.existsSync(path.join(repo.path, ".trellis", "workspace", assignee))) {
    throw new Error(`负责人 ${assignee} 尚未初始化 Trellis workspace`);
  }
  const fullTaskPath = path.resolve(repo.path, taskPath);
  const tasksRoot = path.resolve(repo.path, ".trellis", "tasks");
  if (!isPathInside(fullTaskPath, tasksRoot)) {
    throw new Error("任务目录必须在目标仓库的 .trellis/tasks 下");
  }
  if (isPathInside(fullTaskPath, path.join(tasksRoot, "archive"))) {
    throw new Error("归档任务只读，不能更新派发");
  }

  const taskJsonPath = path.join(fullTaskPath, "task.json");
  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 task.json: ${error.message}`);
  }
  task.assignee = assignee;
  const temporaryPath = `${taskJsonPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, taskJsonPath);
  return { taskPath, assignee };
}
