import { AlertCircle, Check, Circle, Loader2 } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { TrellisLogo } from '@/components/layout/TrellisLogo'
import { Progress } from '@/components/ui/progress'
import { errorMessage, invoke, listen } from './tauri.ts'
import { Alert, AlertDescription } from '@/components/ui/alert'

type StepId =
  | 'node:check'
  | 'trellis:check'
  | 'python:check'
  | 'node:download'
  | 'trellis:install'
  | 'python:download'
  | 'ready'

const STEP_ORDER: StepId[] = [
  'node:check',
  'trellis:check',
  'python:check',
  'node:download',
  'trellis:install',
  'python:download',
  'ready',
]

const STEP_LABELS: Record<StepId, string> = {
  'node:check': '检查 Node.js',
  'trellis:check': '检查 Trellis CLI',
  'python:check': '检查 Python',
  'node:download': '下载 Node.js',
  'trellis:install': '安装 Trellis CLI',
  'python:download': '安装 Python',
  ready: '校验运行环境',
}

const PROGRESS_STEP: Record<string, StepId> = {
  'node:download': 'node:download',
  'node:verify': 'node:download',
  'node:extract': 'node:download',
  'node:validate': 'node:download',
  'trellis:install': 'trellis:install',
  'trellis:validate': 'trellis:install',
  'python:download': 'python:download',
  'python:verify': 'python:download',
  'python:install': 'python:download',
  'python:validate': 'python:download',
  'write-flag': 'ready',
  ready: 'ready',
}

type RuntimeStatus = {
  state?: 'checking' | 'ready' | 'needs_setup' | 'installing' | 'failed'
  node?: { ok?: boolean; version?: string; foundVersion?: string; minVersion?: string }
  trellis?: { ok?: boolean; version?: string; foundVersion?: string; requiredVersion?: string }
  python?: { ok?: boolean; version?: string; foundVersion?: string; minVersion?: string }
  error?: string
}

type AppStatus = {
  version?: string
  serverUrl?: string
  username?: string
  password?: string
  configPath?: string
}

type Credentials = { serverUrl: string; username: string; password: string }

function validateInput({ serverUrl, username, password }: Credentials): string | null {
  const trimmedUrl = serverUrl.trim()
  if (!trimmedUrl) return '请填写服务器地址。'
  try {
    const parsed = new URL(trimmedUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) return '服务器地址必须使用 HTTP 或 HTTPS。'
  } catch {
    return '服务器地址格式无效。'
  }
  if (username.trim().length < 3) return '请填写有效的登录名。'
  if (password.length < 6) return '密码至少需要 6 个字符。'
  return null
}

export function LoginApp() {
  const [phase, setPhase] = useState<'pending' | 'env' | 'login'>('pending')
  const [steps, setSteps] = useState<{ active: StepId | null; done: StepId[] }>({
    active: null,
    done: [],
  })
  const [envStatus, setEnvStatus] = useState('正在检查运行环境…')
  const [envError, setEnvError] = useState<string | null>(null)
  const [installVisible, setInstallVisible] = useState(false)
  const [retryVisible, setRetryVisible] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [loginStatus, setLoginStatus] = useState('正在读取上次登录设置…')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [version, setVersion] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [credentials, setCredentials] = useState<Credentials>({
    serverUrl: '',
    username: '',
    password: '',
  })

  const loginReadyRef = useRef(false)
  const serverUrlRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  function applyRuntime(status: RuntimeStatus | null) {
    setEnvError(null)
    const state = status?.state ?? 'checking'
    const node = status?.node ?? {}
    const trellis = status?.trellis ?? {}
    const python = status?.python ?? {}
    if (state !== 'ready') setPhase('env')
    if (state === 'ready') {
      setSteps({ active: null, done: [...STEP_ORDER] })
      setEnvStatus(
        `运行环境就绪：Node.js ${node.version ?? ''} / Trellis ${trellis.version ?? ''} / Python ${python.version ?? ''}`,
      )
      showLogin()
      return
    }
    if (state === 'installing') {
      setInstallVisible(false)
      setRetryVisible(false)
      setEnvStatus('正在安装运行环境…')
      return
    }
    if (state === 'needs_setup') {
      setSteps({ active: null, done: ['node:check', 'trellis:check', 'python:check'] })
      const detected: string[] = []
      if (node.ok && node.version) detected.push(`Node.js ${node.version}`)
      if (trellis.ok && trellis.version) detected.push(`Trellis ${trellis.version}`)
      if (python.ok && python.version) detected.push(`Python ${python.version}`)
      const missing: string[] = []
      if (!node.ok) {
        missing.push(
          node.foundVersion
            ? `Node.js（当前 ${node.foundVersion}，需 ≥ ${node.minVersion ?? '18.17.0'}）`
            : 'Node.js',
        )
      }
      if (!trellis.ok) {
        missing.push(
          trellis.foundVersion
            ? `Trellis CLI（当前 ${trellis.foundVersion}，需 ≥ ${trellis.requiredVersion ?? '0.6.17'}）`
            : 'Trellis CLI',
        )
      }
      if (!python.ok) {
        missing.push(
          python.foundVersion
            ? `Python（当前 ${python.foundVersion}，需 ≥ ${python.minVersion ?? '3.9.0'}）`
            : 'Python',
        )
      }
      const detectedText = detected.length ? `已检测到 ${detected.join('、')}。` : ''
      setEnvStatus(
        missing.length
          ? `${detectedText}${missing.join('、')} 缺失或版本过低，请先安装运行环境。`
          : `${detectedText}请先安装运行环境。`,
      )
      setInstallVisible(true)
      setRetryVisible(true)
      return
    }
    if (state === 'failed') {
      setInstallVisible(true)
      setRetryVisible(true)
      setEnvStatus('运行环境检查失败。')
      setEnvError(status?.error || '请重试或检查网络连接。')
      return
    }
    setSteps({ active: 'node:check', done: [] })
    setEnvStatus('正在检查运行环境…')
  }

  function showLogin() {
    if (loginReadyRef.current) return
    loginReadyRef.current = true
    setPhase('login')
    void readStatus()
  }

  async function refreshRuntime() {
    if (!invoke) {
      setPhase('env')
      setEnvStatus('请在 Trellis Board 桌面客户端中打开此页面。')
      setEnvError('未能连接桌面客户端进程。')
      return
    }
    try {
      applyRuntime(await invoke<RuntimeStatus>('runtime_status'))
    } catch (error) {
      setPhase('env')
      setInstallVisible(true)
      setEnvStatus('无法检查运行环境。')
      setEnvError(errorMessage(error, ''))
    }
  }

  async function installRuntime() {
    if (!invoke || installing) return
    setInstalling(true)
    setEnvError(null)
    setInstallVisible(false)
    setRetryVisible(false)
    setSteps({ active: null, done: ['node:check', 'trellis:check', 'python:check'] })
    setEnvStatus('正在准备运行环境…')
    try {
      const result = await invoke<{
        nodeVersion?: string
        trellisVersion?: string
        pythonVersion?: string
      }>('runtime_install')
      setEnvStatus(
        `运行环境安装完成：Node.js ${result?.nodeVersion ?? ''} / Trellis ${result?.trellisVersion ?? ''} / Python ${result?.pythonVersion ?? ''}`,
      )
      // 安装结束不等于环境就绪（例如 Python 安装器被拦截）：交给 runtime_status 决定下一步。
      await refreshRuntime()
    } catch (error) {
      setEnvStatus('运行环境安装失败。')
      setEnvError(errorMessage(error, ''))
      setInstallVisible(true)
      setRetryVisible(true)
    } finally {
      setInstalling(false)
    }
  }

  async function readStatus() {
    if (!invoke) return
    try {
      const app = await invoke<AppStatus>('app_status')
      setVersion(app.version ? `v${app.version}` : '')
      setConfigPath(app.configPath ? `配置：${app.configPath}` : '')
      setCredentials({
        serverUrl: app.serverUrl ?? '',
        username: app.username ?? '',
        password: app.password ?? '',
      })
      if (app.serverUrl && app.username && app.password) {
        setLoginStatus('已恢复上次登录信息，正在自动登录…')
        void submitLogin(
          { serverUrl: app.serverUrl, username: app.username, password: app.password },
          true,
        )
        return
      }
      setLoginStatus('请输入账号密码登录。')
      requestAnimationFrame(() => {
        const firstEmpty = [serverUrlRef, usernameRef, passwordRef].find(
          (input) => !input.current?.value,
        )
        ;(firstEmpty?.current ?? submitRef.current)?.focus()
      })
    } catch (error) {
      setLoginStatus('无法读取本地配置。')
      setLoginError(errorMessage(error, '登录失败'))
    }
  }

  async function submitLogin(value: Credentials, automatic: boolean) {
    if (submitting || !invoke) return
    setLoginError(null)
    const validationError = validateInput(value)
    if (validationError) {
      setLoginError(validationError)
      return
    }
    setSubmitting(true)
    setLoginStatus('正在验证账号并建立设备会话…')
    try {
      await invoke('desktop_login', {
        serverUrl: value.serverUrl.trim(),
        username: value.username.trim(),
        password: value.password,
      })
      setCredentials((current) => ({ ...current, password: '' }))
      setLoginStatus('登录成功，正在打开 Board…')
    } catch (error) {
      setSubmitting(false)
      setLoginStatus(automatic ? '自动登录失败，请检查后重试。' : '登录失败。')
      setLoginError(errorMessage(error, '登录失败'))
      requestAnimationFrame(() => passwordRef.current?.focus())
    }
  }

  useEffect(() => {
    void refreshRuntime()
    if (listen) {
      listen('runtime-progress', (event) => {
        const payload = (event?.payload ?? {}) as { stage?: string; message?: string }
        if (payload.message) setEnvStatus(payload.message)
        const mapped = PROGRESS_STEP[payload.stage ?? '']
        if (mapped) {
          const index = STEP_ORDER.indexOf(mapped)
          setSteps({ active: mapped, done: STEP_ORDER.slice(0, Math.max(index, 0)) })
        }
      }).catch(() => {})
    }
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitLogin(credentials, false)
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
      {phase === 'env' ? (
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-3">
              <TrellisLogo size={36} />
              <div>
                <p className="text-2xs font-semibold tracking-[0.2em] text-muted-foreground">
                  TRELLIS DESKTOP
                </p>
                <h1 className="font-heading text-xl font-medium">首次启动环境检查</h1>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {envStatus}
            </p>
            <Progress
              aria-label="运行环境安装进度"
              value={(steps.done.length / STEP_ORDER.length) * 100}
            />
            <ol className="flex flex-col gap-2 text-sm">
              {STEP_ORDER.map((step) => {
                const done = steps.done.includes(step)
                const active = steps.active === step
                return (
                  <li
                    key={step}
                    className="flex items-center gap-2"
                    aria-current={active ? 'step' : undefined}
                  >
                    {done ? (
                      <Check className="size-4 shrink-0 text-primary" />
                    ) : active ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    ) : (
                      <Circle className="size-4 shrink-0 text-muted-foreground/40" />
                    )}
                    <span className={active ? 'font-medium' : 'text-muted-foreground'}>
                      {STEP_LABELS[step]}
                    </span>
                  </li>
                )
              })}
            </ol>
            {envError ? (
              <Alert variant="destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <AlertDescription className="text-sm">{envError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {installVisible ? (
                <Button size="sm" disabled={installing} onClick={() => void installRuntime()}>
                  安装运行环境
                </Button>
              ) : null}
              {retryVisible ? (
                <Button size="sm" variant="outline" onClick={() => void refreshRuntime()}>
                  重新检查
                </Button>
              ) : null}
            </div>
            <Separator />
            <p className="pt-4 text-xs leading-6 text-muted-foreground">
              运行环境缺失时客户端会从国内镜像下载便携 Node.js，并把 Trellis CLI
              安装到客户端私有目录，不改动系统环境；Python 缺失或低于 3.9 时下载官方安装包静默安装
              Python 3.12.8（仅当前用户，无需管理员权限）。
            </p>
          </CardContent>
        </Card>
      ) : null}

      {phase === 'login' ? (
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-3">
              <TrellisLogo size={36} />
              <div>
                <p className="text-2xs font-semibold tracking-[0.2em] text-muted-foreground">
                  TRELLIS DESKTOP
                </p>
                <h1 className="font-heading text-xl font-medium">登录团队看板</h1>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p role="status" aria-live="polite" className="mb-4 text-sm text-muted-foreground">
              {loginStatus}
            </p>
            <form className="flex flex-col gap-4" noValidate onSubmit={handleSubmit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-url">服务器地址</Label>
                <Input
                  id="server-url"
                  ref={serverUrlRef}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  placeholder="http://board.example.com 或 https://board.example.com"
                  required
                  disabled={submitting}
                  value={credentials.serverUrl}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, serverUrl: event.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="username">登录名</Label>
                <Input
                  id="username"
                  ref={usernameRef}
                  type="text"
                  maxLength={64}
                  autoComplete="username"
                  spellCheck={false}
                  required
                  disabled={submitting}
                  value={credentials.username}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, username: event.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  ref={passwordRef}
                  type="password"
                  maxLength={1024}
                  autoComplete="current-password"
                  required
                  disabled={submitting}
                  value={credentials.password}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, password: event.target.value }))
                  }
                />
              </div>
              {loginError ? (
                <Alert variant="destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <AlertDescription className="text-sm">{loginError}</AlertDescription>
                </Alert>
              ) : null}
              <Button ref={submitRef} type="submit" className="w-full" disabled={submitting}>
                {submitting ? '正在登录…' : '登录'}
              </Button>
            </form>
            <Separator className="mt-6" />
            <p className="pt-4 text-xs leading-6 text-muted-foreground">
              登录成功后会记住服务器地址、登录名和密码，下次打开可直接登录；密码不会写入日志。
            </p>
          </CardContent>
        </Card>
      ) : null}

      <footer className="flex w-full max-w-md flex-col items-center gap-1 text-xs text-muted-foreground">
        <span>{version}</span>
        <span>{configPath}</span>
      </footer>
    </main>
  )
}
