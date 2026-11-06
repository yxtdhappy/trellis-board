import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

type SelectFieldProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
};

export function SelectField({
  value,
  options,
  onChange,
  placeholder = "请选择",
  className,
  id,
  ariaLabel,
  disabled,
}: SelectFieldProps) {
  const current = options.find((option) => option.value === value);
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(String(next ?? ""))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn("w-full rounded-md text-[13px]", className)}
      >
        <span
          data-slot="select-value"
          className={
            current
              ? "flex flex-1 items-center text-left"
              : "flex flex-1 items-center text-left text-muted-foreground"
          }
        >
          {current?.label ?? placeholder}
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
