import { stageSourceLabel, type Stage } from './task-view.ts'

export function StageTape({ stages, current }: { stages: Stage[]; current: string }) {
  return (
    <div
      className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`13 阶段证据：已完成 ${stages.filter((stage) => stage.complete).length} 段，当前 ${current}`}
    >
      {stages.map((stage) => {
        const isCurrent = stage.id === current
        const tone = stage.complete
          ? stage.source === 'manual'
            ? 'bg-primary/60'
            : 'bg-primary'
          : stage.optional
            ? 'bg-border/70'
            : 'bg-border'
        return (
          <span
            key={stage.id}
            className={`h-1 flex-1 ${tone} ${isCurrent ? 'ring-1 ring-primary/60' : ''}`}
            title={`${stage.label} · ${stageSourceLabel(stage)}`}
          />
        )
      })}
    </div>
  )
}
