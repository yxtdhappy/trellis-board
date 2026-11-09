import { useEffect } from 'react'
import { MonitorSmartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import { formatTime } from '@/lib/admin-shared'
import { EmptyRow, Panel, Row, StatusPill } from './shared'

export function DevicesTab({ console: consoleApi }: { console: AdminConsole }) {
  const {
    devices,
    reloadDevices,
    revokeDevice,
    pairingCode,
    createPairingCode,
    desktopToken,
    createDesktopEnrollToken,
  } = consoleApi

  useEffect(() => {
    void reloadDevices()
  }, [reloadDevices])

  return (
    <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel
        kicker="DEVICES / HEARTBEATS"
        title="我的设备"
        description="设备凭证只在 Agent 本机加密保存。撤销后该设备的绑定和待执行命令立即失效。"
        action={
          <Button variant="outline" size="sm" type="button" onClick={() => void reloadDevices()}>
            刷新设备列表
          </Button>
        }
      >
        <div className="flex flex-col">
          {devices.length === 0 ? (
            <EmptyRow>暂无已注册 Agent。</EmptyRow>
          ) : (
            devices.map((device) => (
              <Row
                key={device.id}
                actions={
                  device.status === 'revoked' ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                      已撤销 {formatTime(device.revokedAt)}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      className="text-destructive"
                      onClick={() => void revokeDevice(device)}
                    >
                      撤销设备
                    </Button>
                  )
                }
              >
                <div className="flex items-center gap-2">
                  <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <strong className="truncate text-xs font-medium">{device.deviceName}</strong>
                      <StatusPill value={device.status} />
                    </div>
                    <p className="truncate text-[10px] text-muted-foreground">
                      所有者 {device.displayName || device.username || '未知'} ·{' '}
                      {device.platform || '平台未知'} · 最近在线 {formatTime(device.lastSeenAt)}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      Agent {device.agentVersion || '未知版本'} · 协议 v{device.protocolVersion}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      设备 ID <code>{device.id}</code> · 创建 {formatTime(device.createdAt)}
                    </p>
                  </div>
                </div>
              </Row>
            ))
          )}
        </div>
      </Panel>

      <div className="flex flex-col gap-3.5">
        <Panel
          kicker="DESKTOP CLIENT"
          title="桌面客户端登录接力"
          description="用当前登录会话签发一次性设备令牌，桌面客户端据此换取设备凭证；令牌 5 分钟内有效且只能使用一次。"
        >
          {desktopToken ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  一次性设备令牌
                </span>
                <input
                  readOnly
                  value={desktopToken.token}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full rounded-lg border border-border bg-transparent px-2.5 py-2 font-mono text-[11px]"
                />
              </label>
              <p className="text-[11px] text-muted-foreground">
                {desktopToken.expiresAt
                  ? `有效期至 ${formatTime(desktopToken.expiresAt)}，使用后立即失效。`
                  : '仅显示一次，使用后立即失效。'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(desktopToken.token)}
                >
                  复制令牌
                </Button>
                <a
                  className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                  href={`trellisboard://enroll?token=${encodeURIComponent(desktopToken.token)}&server=${encodeURIComponent(window.location.origin)}`}
                >
                  打开桌面客户端
                </a>
              </div>
            </div>
          ) : (
            <EmptyRow>尚未生成桌面设备令牌。</EmptyRow>
          )}
          <Button
            size="sm"
            type="button"
            className="self-start"
            onClick={() => void createDesktopEnrollToken()}
          >
            生成桌面设备令牌
          </Button>
        </Panel>

        <Panel
          kicker="PAIRING"
          title="管理员兜底：生成配对码"
          description="配对码只在响应中显示一次，到期或完成配对后失效。"
        >
          {pairingCode ? (
            <div className="flex flex-col gap-1">
              <code className="text-2xl font-semibold tracking-[0.18em] break-all text-primary">
                {pairingCode.code}
              </code>
              <p className="text-[11px] text-muted-foreground">
                {pairingCode.expiresAt
                  ? `有效期至 ${formatTime(pairingCode.expiresAt)}`
                  : '仅显示一次，请立即完成 Agent 配对。'}
              </p>
            </div>
          ) : (
            <EmptyRow>尚未生成配对码。</EmptyRow>
          )}
          <Button
            size="sm"
            type="button"
            className="self-start"
            onClick={() => void createPairingCode()}
          >
            生成我的配对码
          </Button>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">在 Agent 本机执行</span>
            <pre className="overflow-x-auto rounded-lg bg-muted px-2.5 py-2 text-[11px] text-muted-foreground">
              {`.\\trellis-agent.cmd pair --server ${window.location.origin} --name $env:COMPUTERNAME`}
            </pre>
          </div>
        </Panel>
      </div>
    </div>
  )
}
