/**
 * Python 解释器解析。
 *
 * 仓库的自定义工具统一按 `python` 调用；部分 Linux 环境只装了 `python3`，
 * 这里给出候选顺序，调用方在 spawn 收到 ENOENT 时按顺序回退。
 * `TRELLIS_PYTHON` 可显式指定解释器路径。
 */
export function pythonCommandCandidates(env = process.env) {
  const explicit = String(env.TRELLIS_PYTHON || "").trim();
  return explicit ? [explicit] : ["python", "python3"];
}
