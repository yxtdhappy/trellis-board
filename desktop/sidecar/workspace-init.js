import { initializeWorkspace } from "../../agent/workspace.js";

const TOOL_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeWorkspaceTools(value) {
  if (value == null) return null;
  const items = Array.isArray(value) ? value : String(value).split(",");
  const tools = items.map((item) => String(item).trim()).filter(Boolean);
  if (!tools.length) {
    throw new Error("--tools 至少需要一个工具目录");
  }
  for (const tool of tools) {
    if (!TOOL_PATTERN.test(tool)) {
      throw new Error(`工具目录格式无效：${tool}`);
    }
  }
  return tools;
}

/**
 * 桌面端 workspace 初始化的唯一入口：只做参数归一化并调用 agent/workspace.js，
 * 不在这里重复路径、备份或 developer 逻辑。
 */
export async function runWorkspaceInit({
  workspacePath,
  tools = null,
  username,
  teamId,
  serverUrl,
  dataRoot,
  agentCredential = null,
  fetchImpl = null,
  initialize = initializeWorkspace,
  logger = null,
} = {}) {
  if (!workspacePath) {
    throw new Error("缺少 workspace 路径");
  }
  const options = {
    workspacePath,
    username,
    tools: normalizeWorkspaceTools(tools),
    teamId,
    serverUrl,
    dataRoot,
    agentCredential,
    logger,
  };
  if (typeof fetchImpl === "function") {
    options.fetchImpl = fetchImpl;
  }
  return initialize(options);
}
