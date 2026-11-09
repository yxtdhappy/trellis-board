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
  options,
  onChange,
  placeholder = '请选择',
  ariaLabel,
  disabled,
  className,
}: {
  value: string[]
  options: MultiSelectOption[]
  onChange: (value: string[]) => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  className?: string
}) {
  const selected = options.filter((option) => value.includes(option.value))
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
        <DropdownMenuLabel>Agent 工具</DropdownMenuLabel>
        <DropdownMenuGroup>
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={value.includes(option.value)}
              closeOnClick={false}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...value, option.value]
                    : value.filter((item) => item !== option.value),
                )
              }
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
