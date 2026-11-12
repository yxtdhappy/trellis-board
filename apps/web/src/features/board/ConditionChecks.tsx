import { useState } from 'react'
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ListChecksIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  conditionMode,
  conditionRows,
  type ConditionKind,
  type ConditionRow,
} from '@/lib/condition-checks.js'
import type { BoardTask } from './task-view.ts'

type ConditionChecksProps = {
  task: BoardTask
  loading: boolean
}

type ConditionTableProps = {
  rows: ConditionRow[]
  kind: ConditionKind
}

function ConditionTable({ rows, kind }: ConditionTableProps) {
  const tone =
    kind === 'start' ? 'bg-destructive-soft text-destructive' : 'bg-warning-soft text-warning'

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card">
      <div className="hidden grid-cols-[92px_minmax(220px,1.2fr)_minmax(220px,1fr)_132px] gap-3 border-b border-border/70 bg-muted/50 px-3 py-2 text-[9px] font-semibold text-muted-foreground lg:grid">
        <span>对应阶段</span>
        <span>缺失项</span>
        <span>当前证据</span>
        <span>下一步</span>
      </div>
      {rows.map((row) => (
        <div
          key={`${kind}:${row.label}`}
          className="grid gap-1.5 border-b border-border/60 p-3 text-[10px] last:border-b-0 lg:grid-cols-[92px_minmax(220px,1.2fr)_minmax(220px,1fr)_132px] lg:items-center lg:gap-3 lg:py-2"
        >
          <span className={`w-fit rounded-full px-2 py-0.5 text-[9.5px] font-semibold ${tone}`}>
            {row.stageLabel}
          </span>
          <span className="font-semibold text-foreground">{row.label}</span>
          <span className="min-w-0">
            <span className="mb-0.5 block text-[9px] text-muted-foreground lg:hidden">
              当前证据
            </span>
            <span className="line-clamp-2 text-muted-foreground" title={row.evidence}>
              {row.evidence}
            </span>
          </span>
          <span
            className={`flex items-center gap-1 text-[9.5px] font-semibold ${kind === 'start' ? 'text-destructive' : 'text-warning'}`}
          >
            <span className="mr-1 text-muted-foreground lg:hidden">下一步</span>
            {row.nextAction}
            <ArrowRightIcon className="size-3" aria-hidden="true" />
          </span>
        </div>
      ))}
    </div>
  )
}

function SuccessSummary({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-[10.5px] font-semibold text-success">
      <CircleCheckIcon className="size-3.5" aria-hidden="true" />
      {label}
    </div>
  )
}

function PendingDetails({ loading }: { loading: boolean }) {
  return (
    <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-[10px] text-muted-foreground">
      {loading ? '条件明细正在读取…' : '条件明细暂不可用，请稍后重新打开任务详情。'}
    </p>
  )
}

function riskCount(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function ConditionChecks({ task, loading }: ConditionChecksProps) {
  const mode = conditionMode(task)
  const [startExpanded, setStartExpanded] = useState(mode === 'planning')
  const risk = task.execution?.risk
  const startLabels = Array.isArray(risk?.dorMissing) ? risk.dorMissing : null
  const completionLabels = Array.isArray(risk?.dodMissing) ? risk.dodMissing : null
  const startRiskCount = riskCount(risk?.dorMissingCount)
  const completionRiskCount = riskCount(risk?.dodMissingCount)
  const startKnown = startLabels !== null || startRiskCount !== null
  const completionKnown = completionLabels !== null || completionRiskCount !== null
  const startCount = startLabels?.length ?? startRiskCount ?? 0
  const completionCount = completionLabels?.length ?? completionRiskCount ?? 0
  const startRows = conditionRows(startLabels, task.stages, 'start')
  const completionRows = conditionRows(completionLabels, task.stages, 'completion')
  const showStartTable = mode === 'planning' || startExpanded
  const startTone = !startKnown
    ? 'border-border/70 bg-muted/40'
    : startCount
      ? 'border-destructive/20 bg-destructive-soft/50'
      : 'border-success/20 bg-success-soft/50'
  const completionTone = !completionKnown
    ? 'border-border/70 bg-muted/40'
    : completionCount
      ? 'border-warning/20 bg-warning-soft/50'
      : 'border-success/20 bg-success-soft/50'

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-[11px] font-semibold text-muted-foreground">条件检查</h3>
        <span className="text-[10px] text-muted-foreground">先确认能否开工，再确认是否完成</span>
      </div>

      {mode === 'archived' ? null : (
        <section className={`flex flex-col gap-2 rounded-xl border p-3 ${startTone}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex size-7 items-center justify-center rounded-lg ${
                !startKnown
                  ? 'bg-muted text-muted-foreground'
                  : startCount
                    ? 'bg-destructive-soft text-destructive'
                    : 'bg-success-soft text-success'
              }`}
            >
              {!startKnown ? (
                <ListChecksIcon className="size-4" aria-hidden="true" />
              ) : startCount ? (
                <CircleAlertIcon className="size-4" aria-hidden="true" />
              ) : (
                <CircleCheckIcon className="size-4" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h4 className="text-[12px] font-semibold text-foreground">开工条件</h4>
              <p className="text-[9.5px] text-muted-foreground">
                {!startKnown
                  ? '正在读取开工条件状态。'
                  : startCount
                    ? mode === 'planning'
                      ? '进入实现前需要补齐，不会强制阻止操作。'
                      : `带着 ${startCount} 项缺口进入实现，可能增加返工风险。`
                    : '开工前准备条件已满足。'}
              </p>
            </div>
            {startKnown && startCount ? (
              <span className="ml-auto rounded-full bg-destructive-soft px-2 py-0.5 text-[9.5px] font-semibold text-destructive">
                缺 {startCount} 项
              </span>
            ) : null}
            {mode !== 'planning' && startKnown && startCount ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-destructive"
                aria-expanded={startExpanded}
                disabled={!startLabels}
                onClick={() => setStartExpanded((value) => !value)}
              >
                {startExpanded ? '收起明细' : '查看明细'}
                {startExpanded ? (
                  <ChevronUpIcon className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronDownIcon className="size-3" aria-hidden="true" />
                )}
              </Button>
            ) : null}
          </div>
          {!startKnown ? (
            <PendingDetails loading={loading} />
          ) : startCount === 0 ? (
            <SuccessSummary label="4 项开工条件已全部满足" />
          ) : !startLabels ? (
            <PendingDetails loading={loading} />
          ) : showStartTable ? (
            <ConditionTable rows={startRows} kind="start" />
          ) : null}
        </section>
      )}

      {mode === 'planning' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <ListChecksIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h4 className="text-[11.5px] font-semibold text-foreground">完成条件</h4>
            <p className="text-[9.5px] text-muted-foreground">
              进入实现后开始检查，规划阶段暂不适用。
            </p>
          </div>
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[9.5px] font-semibold text-muted-foreground">
            暂不适用
          </span>
        </div>
      ) : (
        <section className={`flex flex-col gap-2 rounded-xl border p-3 ${completionTone}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex size-7 items-center justify-center rounded-lg ${
                !completionKnown
                  ? 'bg-muted text-muted-foreground'
                  : completionCount
                    ? 'bg-warning-soft text-warning'
                    : 'bg-success-soft text-success'
              }`}
            >
              {!completionKnown ? (
                <ListChecksIcon className="size-4" aria-hidden="true" />
              ) : completionCount ? (
                <CircleAlertIcon className="size-4" aria-hidden="true" />
              ) : (
                <CircleCheckIcon className="size-4" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h4 className="text-[12px] font-semibold text-foreground">完成条件</h4>
              <p className="text-[9.5px] text-muted-foreground">
                {!completionKnown
                  ? '正在读取完成条件状态。'
                  : completionCount
                    ? '任务收尾前需要补齐以下检查项。'
                    : '任务完成条件已全部满足。'}
              </p>
            </div>
            {completionKnown && completionCount ? (
              <span className="ml-auto rounded-full bg-warning-soft px-2 py-0.5 text-[9.5px] font-semibold text-warning">
                缺 {completionCount} 项
              </span>
            ) : null}
          </div>
          {!completionKnown ? (
            <PendingDetails loading={loading} />
          ) : completionCount === 0 ? (
            <SuccessSummary label="5 项完成条件已全部满足" />
          ) : !completionLabels ? (
            <PendingDetails loading={loading} />
          ) : (
            <ConditionTable rows={completionRows} kind="completion" />
          )}
        </section>
      )}
    </section>
  )
}
