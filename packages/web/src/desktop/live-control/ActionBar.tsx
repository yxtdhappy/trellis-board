import { Button } from '@/components/ui/button'
import type { Action } from './control-event.ts'

export function ActionBar({
  actions,
  busy,
  onAction,
}: {
  actions: Action[]
  busy: boolean
  onAction: (action: string) => void
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {actions.map((item) => (
        <Button
          key={`${item.action}:${item.label}`}
          size="sm"
          variant={item.variant ?? 'outline'}
          disabled={busy && item.action !== 'close'}
          onClick={() => onAction(item.action)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}
