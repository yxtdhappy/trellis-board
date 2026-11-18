import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type SelectOption = { value: string; label: string }

type SelectFieldProps = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  id?: string
  ariaLabel?: string
  disabled?: boolean
}

export function SelectField({
  value,
  options,
  onChange,
  placeholder = '请选择',
  className,
  id,
  ariaLabel,
  disabled,
}: SelectFieldProps) {
  const current = options.find((option) => option.value === value)
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(String(next ?? ''))}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn('w-full rounded-md', className)}>
        <SelectValue>
          {current ? current.label : <span className="text-muted-foreground">{placeholder}</span>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
