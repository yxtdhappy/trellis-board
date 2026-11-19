import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StatusPill } from '@/components/ui/status-pill'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppearance } from '@/app/theme'
import type { FontSize, NotifyMode, ThemePreference } from '@/lib/appearance.js'
import { cn } from '@/lib/utils'

const THEME_CHOICES: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

const FONT_CHOICES: { value: FontSize; label: string }[] = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '标准' },
  { value: 'lg', label: '大' },
  { value: 'xl', label: '特大' },
]

const NOTIFY_CHOICES: { value: NotifyMode; label: string }[] = [
  { value: 'never', label: '从不' },
  { value: 'unfocused', label: '仅在未聚焦时' },
  { value: 'always', label: '始终' },
]

function ThemePreview({ mode }: { mode: ThemePreference }) {
  if (mode === 'system') {
    return (
      <div className="flex h-11 w-full overflow-hidden rounded-md border border-border">
        <div className="flex-1 bg-white p-1">
          <div className="h-1 w-full rounded-full bg-neutral-300" />
          <div className="mt-1 h-2 rounded-sm bg-neutral-200" />
        </div>
        <div className="flex-1 bg-neutral-900 p-1">
          <div className="h-1 w-full rounded-full bg-neutral-700" />
          <div className="mt-1 h-2 rounded-sm bg-neutral-800" />
        </div>
      </div>
    )
  }
  const dark = mode === 'dark'
  return (
    <div
      className={cn(
        'h-11 w-full rounded-md border border-border p-1',
        dark ? 'bg-neutral-900' : 'bg-white',
      )}
    >
      <div className={cn('h-1 w-full rounded-full', dark ? 'bg-neutral-700' : 'bg-neutral-300')} />
      <div className="mt-1 flex gap-1">
        <div className={cn('h-2 flex-1 rounded-sm', dark ? 'bg-neutral-700' : 'bg-neutral-200')} />
        <div className={cn('h-2 flex-1 rounded-sm', dark ? 'bg-neutral-700' : 'bg-neutral-200')} />
        <div className={cn('h-2 flex-1 rounded-sm', dark ? 'bg-neutral-700' : 'bg-neutral-200')} />
      </div>
    </div>
  )
}

export function PreferencesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    theme,
    fontSize,
    fontPixels,
    notifyMode,
    setTheme,
    setFontSize,
    setNotifyMode,
    resetAppearance,
  } = useAppearance()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-130">
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border px-5 pt-4.5 pb-3.5">
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-sm font-semibold">偏好设置</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              外观与通知设置保存在本机，随时可以更改。
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenChange(false)}
            aria-label="关闭"
          >
            <XIcon />
          </Button>
        </DialogHeader>

        <DialogBody className="mx-0 flex flex-col gap-5.5 px-5 pt-4.5 pb-5">
          <section className="flex flex-col gap-2.5">
            <span className="text-xs font-semibold text-foreground">主题</span>
            <ToggleGroup
              value={[theme]}
              onValueChange={(value: string[]) => {
                const next = THEME_CHOICES.find((choice) => choice.value === value[0])?.value
                if (next) setTheme(next)
              }}
              aria-label="主题"
              className="grid w-full grid-cols-3 items-stretch gap-2.5"
            >
              {THEME_CHOICES.map(({ value, label }) => {
                const active = theme === value
                return (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className="h-auto flex-col items-stretch gap-2 rounded-lg border border-border p-2 text-left aria-pressed:border-primary aria-pressed:bg-card"
                  >
                    <ThemePreview mode={value} />
                    <span
                      className={cn(
                        'text-xs',
                        active ? 'font-semibold text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {label}
                    </span>
                  </ToggleGroupItem>
                )
              })}
            </ToggleGroup>
          </section>

          <section className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">字体大小</span>
              <span className="text-2xs text-muted-foreground">当前 {fontPixels}px</span>
            </div>
            <ToggleGroup
              value={[fontSize]}
              onValueChange={(value: string[]) => {
                const next = FONT_CHOICES.find((choice) => choice.value === value[0])?.value
                if (next) setFontSize(next)
              }}
              spacing={0.75}
              aria-label="字体大小"
              className="flex h-8 w-full items-stretch rounded-lg bg-muted p-0.75"
            >
              {FONT_CHOICES.map(({ value, label }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  variant="primary"
                  className="h-full flex-1 rounded-md text-xs text-muted-foreground"
                >
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex flex-col gap-1.5 rounded-lg bg-muted p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">任务流水线</span>
                <StatusPill tone="success" size="xs" className="py-0.5 font-medium">
                  进行中
                </StatusPill>
              </div>
              <p className="text-xs text-muted-foreground">
                调整后文字与间距一起等比缩放，界面整体随之放大。
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <span className="text-xs font-semibold text-foreground">同步通知</span>
            <ToggleGroup
              value={[notifyMode]}
              onValueChange={(value: string[]) => {
                const next = NOTIFY_CHOICES.find((choice) => choice.value === value[0])?.value
                if (next) setNotifyMode(next)
              }}
              spacing={0.75}
              aria-label="同步通知"
              className="flex h-8 w-full items-stretch rounded-lg bg-muted p-0.75"
            >
              {NOTIFY_CHOICES.map(({ value, label }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  variant="primary"
                  className="h-full flex-1 rounded-md text-xs text-muted-foreground"
                >
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              只影响系统通知，点击通知可把窗口带回前台；应用内的差异弹窗不受影响。
            </p>
          </section>
        </DialogBody>

        <DialogFooter className="mt-0 border-t border-border px-5 py-3.5 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={resetAppearance}>
            恢复默认
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
