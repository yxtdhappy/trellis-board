import { FILTER_STAGES } from "./execution-filter.js";

const REVIEW_STAGE_INDEX = FILTER_STAGES.findIndex((stage) => stage.id === "review");
const PLANNING_STAGES = new Set([
  ...FILTER_STAGES.slice(0, REVIEW_STAGE_INDEX + 1).map((stage) => stage.id)
]);

const START_RULES = [
  {
    matches: (label) => label.startsWith("PRD 的"),
    stageId: "prd",
    stageLabel: "需求",
    nextAction: "补齐需求与验收内容"
  },
  {
    matches: (label) => label.includes("Design"),
    stageId: "design",
    stageLabel: "设计",
    nextAction: "补设计文档"
  },
  {
    matches: (label) => label.includes("Implement"),
    stageId: "implementPlan",
    stageLabel: "实施计划",
    nextAction: "补实施计划"
  },
  {
    matches: (label) => label.includes("规划评审"),
    stageId: "review",
    stageLabel: "规划评审",
    nextAction: "补规划评审"
  }
];

const COMPLETION_RULES = [
  {
    matches: (label) => label.startsWith("实施报告"),
    stageId: "implement",
    stageLabel: "实现",
    nextAction: "补实施证据"
  },
  {
    matches: (label) => label.startsWith("检查报告"),
    stageId: "check",
    stageLabel: "检查",
    nextAction: "完成检查"
  },
  {
    matches: (label) => label.startsWith("PRD 验收项"),
    stageId: "prd",
    stageLabel: "需求",
    nextAction: "勾选验收项"
  },
  {
    matches: (label) => label.startsWith("工作提交"),
    stageId: "commit",
    stageLabel: "工作提交",
    nextAction: "登记提交号"
  },
  {
    matches: (label) => label.startsWith("归档记录"),
    stageId: "archive",
    stageLabel: "归档",
    nextAction: "完成归档"
  }
];

const UNKNOWN_RULE = {
  stageId: null,
  stageLabel: "其他",
  nextAction: "补齐证据"
};

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function conditionMode(task) {
  if (task?.archived) return "archived";
  return PLANNING_STAGES.has(task?.derivedStage) ? "planning" : "closeout";
}

export function conditionBadges(task) {
  const risk = task?.execution?.risk || {};
  const start = count(risk.dorMissingCount);
  const completion = count(risk.dodMissingCount);
  const mode = conditionMode(task);
  const badges = [];
  if (mode === "planning") {
    if (start) badges.push({ kind: "start", label: `开工条件缺 ${start}` });
    return badges;
  }
  if (completion) {
    badges.push({ kind: "completion", label: `完成条件缺 ${completion}` });
  }
  if (start) {
    badges.push({ kind: "start", label: `开工条件仍缺 ${start}` });
  }
  return badges;
}

export function conditionRows(labels, stages, kind) {
  const rules = kind === "completion" ? COMPLETION_RULES : START_RULES;
  const stageMap = new Map(
    (Array.isArray(stages) ? stages : []).map((stage) => [stage.id, stage])
  );
  return (Array.isArray(labels) ? labels : []).map((value) => {
    const label = String(value);
    const rule = rules.find((candidate) => candidate.matches(label)) || UNKNOWN_RULE;
    const stage = rule.stageId ? stageMap.get(rule.stageId) : null;
    return {
      label,
      stageId: rule.stageId,
      stageLabel: stage?.label || rule.stageLabel,
      evidence: stage?.evidence || (rule.stageId ? `等待${rule.stageLabel}证据` : "当前证据未归类"),
      nextAction: rule.nextAction
    };
  });
}
