import { ChevronDownIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type MultiSelectOption = {
  value: string
  label: string
}

export function MultiSelectField({
  value,
  lockedValues = [],
  options,
  onChange,
  placeholder = '请选择',
  ariaLabel,
  disabled,
  className,
}: {
  value: string[]
  lockedValues?: string[]
  options: MultiSelectOption[]
  onChange: (value: string[]) => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  className?: string
}) {
  const selectedValues = new Set([...value, ...lockedValues])
  const selected = options.filter((option) => selectedValues.has(option.value))
  const summary =
    selected.length === 0
      ? placeholder
      : selected.length <= 2
        ? selected.map((option) => option.label).join('、')
        : `${selected
            .slice(0, 2)
            .map((option) => option.label)
            .join('、')} +${selected.length - 2}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          'flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-input/20 px-2.5 text-left text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
          className,
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            selected.length === 0 && 'text-muted-foreground',
          )}
          title={selected.map((option) => option.label).join('、')}
        >
          {summary}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Agent 工具</DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={selectedValues.has(option.value)}
              closeOnClick={false}
              disabled={lockedValues.includes(option.value)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selectedValues, option.value]
                    : [...selectedValues].filter((item) => item !== option.value),
                )
              }
            >
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate">{option.label}</span>
                {lockedValues.includes(option.value) ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">已接入</span>
                ) : null}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
