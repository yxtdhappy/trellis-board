import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, requestJson } from '@/api/request'
import { normalizeRuntime, normalizeUser, safeReturnTo } from '@/lib/team-client.js'

type LoginState = 'checking' | 'ready' | 'submitting'

type SessionUser = { mustChangePassword?: boolean } | null

type LoginResponse = { user?: SessionUser } | null

export function LoginPage() {
  const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'))
  const [state, setState] = useState<LoginState>('checking')
  const [message, setMessage] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const result = await requestJson('/api/runtime')
        const runtime = normalizeRuntime(result.data as Parameters<typeof normalizeRuntime>[0])
        if (!runtime.team) {
          window.location.replace('/')
          return
        }
        if (runtime.authenticated && runtime.user) {
          window.location.replace(runtime.user.mustChangePassword ? '/' : returnTo)
          return
        }
        if (cancelled) return
        setState('ready')
        usernameRef.current?.focus()
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          window.location.replace('/')
          return
        }
        setMessage(`无法读取登录状态：${(error as Error).message}`)
        setState('ready')
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [returnTo])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('submitting')
    setMessage('')
    try {
      const result = await requestJson<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password },
      })
      const sessionUser = result.data?.user ?? (result.data as SessionUser)
      const user = normalizeUser(sessionUser)
      window.location.replace(user?.mustChangePassword ? '/' : returnTo)
    } catch (error) {
      setPassword('')
      setMessage((error as Error).message)
      setState('ready')
      passwordRef.current?.focus()
    }
  }

  const submitting = state === 'submitting'

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,46%)_minmax(0,54%)]">
      <section className="hidden flex-col justify-between gap-12 bg-primary p-14 text-primary-foreground lg:flex">
        <a className="flex items-center gap-3" href="/" aria-label="Trellis Board 首页">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary-foreground text-sm font-bold text-primary">
            T
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-base font-semibold">Trellis Board</span>
            <span className="text-[11px] tracking-[0.18em] text-primary-foreground/70">TEAM / BOARD</span>
          </span>
        </a>

        <div className="flex max-w-lg flex-col gap-5">
          <p className="text-[11px] font-semibold tracking-[0.22em] text-primary-foreground/70">
            AUTHORIZED WORKSPACE
          </p>
          <h1 className="text-[32px] leading-[1.3] font-semibold font-heading">
            让每个任务都有清楚的负责人和发布结果。
          </h1>
          <p className="text-sm leading-7 text-primary-foreground/80">
            登录后可查看授权项目的跨项目任务、待接受队列、Git 同步状态和管理入口。浏览器只持有 HttpOnly 会话 Cookie。
          </p>
          <ul className="flex flex-col gap-3 pt-2">
            {[
              '任务流水线与注意力队列',
              '跨项目团队查询与归档证据',
              '项目权限、Agent 绑定与系统审计',
            ].map((item) => (
              <li key={item} className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex size-5 items-center justify-center rounded-full bg-primary-foreground text-[10px] font-bold text-primary">
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <dl className="grid gap-4 text-xs text-primary-foreground/70 sm:grid-cols-3">
          <div>
            <dt className="font-semibold text-primary-foreground/90">会话</dt>
            <dd className="mt-1 leading-5">服务端校验，12 小时过期</dd>
          </div>
          <div>
            <dt className="font-semibold text-primary-foreground/90">权限</dt>
            <dd className="mt-1 leading-5">项目负责人、成员与只读角色分离</dd>
          </div>
          <div>
            <dt className="font-semibold text-primary-foreground/90">数据</dt>
            <dd className="mt-1 leading-5">任务内容来自共享分支工作副本</dd>
          </div>
        </dl>
      </section>

      <section className="flex items-center justify-center px-6 py-16">
        <Card className="w-full max-w-[400px] shadow-sm">
          <CardHeader className="gap-2">
            <p className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground">TEAM ACCESS</p>
            <CardTitle className="text-xl font-heading">登录团队看板</CardTitle>
            <CardDescription className="leading-6">
              首次登录或密码被重置后，会先进入强制修改密码界面。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-username">登录名</Label>
                <Input
                  id="login-username"
                  ref={usernameRef}
                  name="username"
                  autoComplete="username"
                  maxLength={64}
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={submitting || state === 'checking'}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-password">密码</Label>
                <Input
                  id="login-password"
                  ref={passwordRef}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={1024}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={submitting || state === 'checking'}
                />
              </div>
              {message ? (
                <p role="alert" aria-live="assertive" className="text-sm text-destructive">
                  {message}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={submitting || state === 'checking'}>
                {state === 'checking' ? '正在检查会话…' : submitting ? '正在登录…' : '登录'}
              </Button>
            </form>
            <p className="mt-6 border-t border-border pt-4 text-xs leading-6 text-muted-foreground">
              账号由系统管理员创建。忘记密码请联系管理员重置，重置会使其他会话立即失效。
            </p>
          </CardContent>
        </Card>
      </section>
    </main>
  )
}
