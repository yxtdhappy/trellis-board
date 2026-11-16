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
import { useAppearance } from '@/app/theme'
import type { FontSize, ThemePreference } from '@/lib/appearance.js'

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
      className={`h-11 w-full rounded-md border border-border p-1 ${dark ? 'bg-neutral-900' : 'bg-white'}`}
    >
      <div className={`h-1 w-full rounded-full ${dark ? 'bg-neutral-700' : 'bg-neutral-300'}`} />
      <div className="mt-1 flex gap-1">
        <div className={`h-2 flex-1 rounded-sm ${dark ? 'bg-neutral-700' : 'bg-neutral-200'}`} />
        <div className={`h-2 flex-1 rounded-sm ${dark ? 'bg-neutral-700' : 'bg-neutral-200'}`} />
        <div className={`h-2 flex-1 rounded-sm ${dark ? 'bg-neutral-700' : 'bg-neutral-200'}`} />
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
  const { theme, fontSize, fontPixels, setTheme, setFontSize, resetAppearance } = useAppearance()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[32.5rem]">
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border px-5 pt-[1.125rem] pb-3.5">
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-[0.9375rem] font-semibold">偏好设置</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              外观设置保存在本机，随时可以更改。
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

        <DialogBody className="flex flex-col gap-[1.375rem] px-5 pt-[1.125rem] pb-5">
          <section className="flex flex-col gap-2.5">
            <span className="text-xs font-semibold text-foreground">主题</span>
            <div role="radiogroup" aria-label="主题" className="grid grid-cols-3 gap-2.5">
              {THEME_CHOICES.map(({ value, label }) => {
                const active = theme === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTheme(value)}
                    className={`flex flex-col gap-2 rounded-[0.5625rem] p-2 text-left transition-colors ${
                      active
                        ? 'border-[0.09375rem] border-primary'
                        : 'border border-border hover:border-foreground/20'
                    }`}
                  >
                    <ThemePreview mode={value} />
                    <span
                      className={`text-[0.6875rem] ${active ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
                    >
                      {label}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">字体大小</span>
              <span className="text-[0.65625rem] text-muted-foreground">当前 {fontPixels}px</span>
            </div>
            <div
              role="radiogroup"
              aria-label="字体大小"
              className="flex gap-[0.1875rem] rounded-lg bg-muted p-[0.1875rem]"
            >
              {FONT_CHOICES.map(({ value, label }) => {
                const active = fontSize === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setFontSize(value)}
                    className={`h-[1.625rem] flex-1 rounded-md text-[0.6875rem] transition-colors ${
                      active
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg bg-muted p-3">
              <div className="flex items-center gap-2">
                <span className="text-[0.8125rem] font-semibold text-foreground">任务流水线</span>
                <span className="rounded-full bg-success-soft px-1.5 py-0.5 text-[0.59375rem] font-medium text-success">
                  进行中
                </span>
              </div>
              <p className="text-[0.71875rem] text-muted-foreground">
                调整后文字与间距一起等比缩放，界面整体随之放大。
              </p>
            </div>
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
