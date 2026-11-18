import { StatTile } from './StatTile.tsx'

type OverviewProps = {
  active: number
  archived: number
  attention: number
  repositories: number
}

export function Overview({ active, archived, attention, repositories }: OverviewProps) {
  const cards = [
    { label: '进行中', value: active, caption: `${repositories} 个仓库` },
    { label: '归档任务', value: archived, caption: '全部仓库' },
    { label: '需要关注', value: attention, caption: '逾期、截止、停滞与阶段信号' },
  ]
  return (
    <section className="grid grid-cols-2 gap-2 lg:grid-cols-3">
      {cards.map((card) => (
        <StatTile
          key={card.label}
          {...card}
          className="gap-0.5 rounded-xl border border-border bg-card px-3 py-2"
          valueClassName="tabular-nums"
          captionClassName="truncate"
        />
      ))}
    </section>
  )
}
