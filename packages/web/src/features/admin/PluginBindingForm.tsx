import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/features/board/SelectField'
import { cn } from '@/lib/utils'

export type BindingDraft = {
  projectId?: string
  externalProjectId: string
  externalProjectName: string
}

type PluginBindingFormProps = {
  draft: BindingDraft
  onChange: (next: BindingDraft) => void
  onSubmit: () => void
  submitLabel?: string
  disabled?: boolean
  projectOptions?: { value: string; label: string }[]
  submitProps?: Pick<ComponentProps<typeof Button>, 'size' | 'className'>
  className?: string
}

export function PluginBindingForm({
  draft,
  onChange,
  onSubmit,
  submitLabel = '添加绑定',
  disabled,
  projectOptions,
  submitProps,
  className,
}: PluginBindingFormProps) {
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-lg bg-muted/40 p-2.5', className)}>
      {projectOptions ? (
        <SelectField
          ariaLabel="选择 Board 项目"
          placeholder="选择 Board 项目"
          value={draft.projectId ?? ''}
          options={projectOptions}
          disabled={disabled}
          onChange={(next) => onChange({ ...draft, projectId: next })}
        />
      ) : null}
      <Input
        className="text-xs"
        maxLength={200}
        placeholder="插件侧项目 ID"
        disabled={disabled}
        value={draft.externalProjectId}
        onChange={(event) => onChange({ ...draft, externalProjectId: event.target.value })}
      />
      <Input
        className="text-xs"
        maxLength={200}
        placeholder="插件侧项目名称（可选）"
        disabled={disabled}
        value={draft.externalProjectName}
        onChange={(event) => onChange({ ...draft, externalProjectName: event.target.value })}
      />
      <Button
        {...submitProps}
        className={cn('self-start', submitProps?.className)}
        type="button"
        disabled={
          disabled || (projectOptions ? !draft.projectId : false) || !draft.externalProjectId.trim()
        }
        onClick={onSubmit}
      >
        {submitLabel}
      </Button>
    </div>
  )
}
