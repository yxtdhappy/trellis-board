import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
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
  const current = options.find((option) => option.value === value) ?? null

  return (
    <Combobox
      items={options}
      value={current}
      onValueChange={(next: SelectOption | null) => onChange(next ? next.value : '')}
      itemToStringLabel={(option: SelectOption) => option.label}
      isItemEqualToValue={(a: SelectOption, b: SelectOption) => a.value === b.value}
    >
      <ComboboxInput
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={cn('h-8 text-xs', className)}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          {(option: SelectOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
