import { Bot, FolderGit2, LockKeyhole } from 'lucide-react'
import type { TaskSpace } from '@/api/board'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LocalAssociation, Project } from './types.ts'

type ProjectEntryBranchActionsProps = {
  project: Project
  taskSpace: TaskSpace
  association: LocalAssociation
  viewLabel: string
  onRebind: (association: LocalAssociation) => void
  onQuickAgent: (taskSpaceId: string) => void
}

export function ProjectEntryBranchActions({
  project,
  taskSpace,
  association,
  viewLabel,
  onRebind,
  onQuickAgent,
}: ProjectEntryBranchActionsProps) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
              aria-label={`重新绑定 ${project.name} ${taskSpace.branchName} 的分支`}
              onClick={() => onRebind(association)}
            />
          }
        >
          {association.readOnly ? (
            <LockKeyhole className="size-3.5" aria-hidden="true" />
          ) : (
            <FolderGit2 className="size-3.5" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipContent>重新绑定分支{viewLabel ? ` · ${viewLabel}` : ''}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="mr-1.5 shrink-0 text-muted-foreground"
              aria-label={`初始化 ${project.name} ${taskSpace.branchName} 的编码 Agent`}
              onClick={() => onQuickAgent(taskSpace.id)}
            />
          }
        >
          <Bot className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>初始化编码 Agent</TooltipContent>
      </Tooltip>
    </>
  )
}
