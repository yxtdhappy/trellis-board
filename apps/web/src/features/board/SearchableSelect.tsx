import { useMemo } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SelectOption } from './SelectField'

type SearchableSelectProps = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  className?: string
  emptyLabel?: string
}

export function SearchableSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  className,
  emptyLabel = '没有匹配项',
}: SearchableSelectProps) {
  const items = useMemo(
    () =>
      Combobox.createItems(options, {
        getValue: (option) => option.value,
        getLabel: (option) => option.label,
      }),
    [options],
  )

  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={(next) => onChange(next == null ? '' : String(next))}
    >
      <Combobox.InputGroup
        className={cn(
          'relative flex h-8 items-center rounded-md border border-input bg-input/20 text-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30',
          className,
        )}
      >
        <Search className="pointer-events-none ml-2 size-3.5 shrink-0 text-muted-foreground" />
        <Combobox.Input
          aria-label={ariaLabel}
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent pr-7 pl-1.5 text-xs outline-none placeholder:text-muted-foreground"
        />
        <Combobox.Trigger
          aria-label={`展开${ariaLabel}`}
          className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </Combobox.Trigger>
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50">
          <Combobox.Popup className="max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Combobox.Empty className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyLabel}
            </Combobox.Empty>
            <Combobox.List className="max-h-64 overflow-y-auto overscroll-contain p-1 outline-none data-empty:p-0">
              {(option: SelectOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option.value}
                  className="grid min-h-7 cursor-default grid-cols-[1rem_1fr] items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <Combobox.ItemIndicator className="col-start-1">
                    <Check className="size-3.5" />
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 truncate">{option.label}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
