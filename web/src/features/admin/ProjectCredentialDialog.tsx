import { useState } from 'react'
import type { GitCredential, TeamProject } from '@/api/admin'
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
import { SelectField } from '@/features/board/SelectField'

export function ProjectCredentialDialog({
  project,
  credentials,
  busy,
  onSave,
  onClose,
}: {
  project: TeamProject
  credentials: GitCredential[]
  busy: boolean
  onSave: (credentialId: string | null) => Promise<boolean>
  onClose: () => void
}) {
  const [credentialId, setCredentialId] = useState(project.credential?.id || '')

  const projectCredentials = credentials.filter(
    (credential) => credential.teamId === project.teamId,
  )
  const options = [
    { value: '', label: '无需凭据（公开仓库）' },
    ...projectCredentials.map((credential) => ({
      value: credential.id,
      label: `${credential.name} · ${credential.host} · ${credential.authType === 'https_token' ? 'HTTPS' : 'SSH'}`,
    })),
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>更换项目 Git 凭据</DialogTitle>
          <DialogDescription>
            {`${project.name} 当前使用 ${project.credential?.name || '无需凭据'}。保存前会重新验证远端访问。`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <SelectField
            value={credentialId}
            options={options}
            disabled={busy}
            ariaLabel="项目 Git 凭据"
            onChange={setCredentialId}
          />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void onSave(credentialId || null)}>
            {busy ? '验证中…' : '验证并保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
