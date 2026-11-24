import { useRef } from 'react'
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
import { renderMarkdown } from '@/lib/markdown.js'
import type { ArtifactEntry } from './task-detail-artifacts.ts'

export function TaskDetailArtifactViewer({
  artifact,
  onClose,
}: {
  artifact: { label: string; entry?: ArtifactEntry } | null
  onClose: () => void
}) {
  const headerRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={Boolean(artifact)} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-205" initialFocus={headerRef}>
        <DialogHeader ref={headerRef} tabIndex={-1} className="outline-none">
          <DialogTitle>工件查看 · {artifact?.label}</DialogTitle>
          <DialogDescription className="break-all">{artifact?.entry?.path}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            className="markdown-body max-w-none bg-transparent! break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_img]:max-w-full"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(artifact?.entry?.content || '（无可预览内容）'),
            }}
          />
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose()}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
