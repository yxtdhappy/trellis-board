import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { applyMarkdownTheme } from '@/lib/markdown-theme'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  FONT_SIZE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  fontPixels,
  normalizeFontSize,
  normalizeTheme,
  resolveTheme,
} from '@/lib/appearance.js'
import type { FontSize, ThemePreference } from '@/lib/appearance.js'

type AppearanceContextValue = {
  theme: ThemePreference
  resolvedTheme: 'light' | 'dark'
  fontSize: FontSize
  fontPixels: number
  setTheme: (theme: ThemePreference) => void
  setFontSize: (fontSize: FontSize) => void
  resetAppearance: () => void
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

function readInitialTheme(): ThemePreference {
  if (typeof document === 'undefined') return DEFAULT_THEME
  return normalizeTheme(document.documentElement.dataset.theme)
}

function readInitialFontSize(): FontSize {
  if (typeof document === 'undefined') return DEFAULT_FONT_SIZE
  return normalizeFontSize(document.documentElement.dataset.fontSize)
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

// 桌面客户端内 localStorage 按 origin 隔离，设备偏好改由客户端主进程落盘。
function desktopInvoke(): DesktopInvoke | undefined {
  const invoke = typeof window === 'undefined' ? undefined : window.__TAURI__?.core?.invoke
  return typeof invoke === 'function' ? invoke : undefined
}

function readDesktopAppearance(value: unknown): { theme: ThemePreference; fontSize: FontSize } {
  const record: object = typeof value === 'object' && value !== null ? value : {}
  const theme = 'theme' in record ? record.theme : undefined
  const fontSize = 'fontSize' in record ? record.fontSize : undefined
  return { theme: normalizeTheme(theme), fontSize: normalizeFontSize(fontSize) }
}

function storePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下忽略写入失败 */
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readInitialTheme)
  const [fontSize, setFontSizeState] = useState<FontSize>(readInitialFontSize)
  const [systemDark, setSystemDark] = useState(readSystemDark)
  const touched = useRef(false)

  useEffect(() => {
    const invoke = desktopInvoke()
    if (!invoke) return
    let cancelled = false
    invoke('appearance_load')
      .then((payload) => {
        if (cancelled || touched.current) return
        const loaded = readDesktopAppearance(payload)
        setThemeState(loaded.theme)
        setFontSizeState(loaded.fontSize)
      })
      .catch(() => {
        /* 读取设备偏好失败时保持当前外观 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolvedTheme = resolveTheme(theme, systemDark)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
    root.dataset.theme = theme
    applyMarkdownTheme(resolvedTheme)
    storePreference(THEME_STORAGE_KEY, theme)
  }, [theme, resolvedTheme])

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize
    storePreference(FONT_SIZE_STORAGE_KEY, fontSize)
  }, [fontSize])

  // 只在用户真正改过外观时落盘，挂载时的初始值不回写设备偏好。
  useEffect(() => {
    if (!touched.current) return
    const invoke = desktopInvoke()
    if (!invoke) return
    invoke('appearance_save', { theme, fontSize }).catch(() => {
      /* 导航中或权限变化时保存失败，忽略 */
    })
  }, [theme, fontSize])

  const setTheme = useCallback((next: ThemePreference) => {
    touched.current = true
    setThemeState(normalizeTheme(next))
  }, [])
  const setFontSize = useCallback((next: FontSize) => {
    touched.current = true
    setFontSizeState(normalizeFontSize(next))
  }, [])
  const resetAppearance = useCallback(() => {
    touched.current = true
    setThemeState(DEFAULT_THEME)
    setFontSizeState(DEFAULT_FONT_SIZE)
  }, [])

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      fontSize,
      fontPixels: fontPixels(fontSize),
      setTheme,
      setFontSize,
      resetAppearance,
    }),
    [theme, resolvedTheme, fontSize, setTheme, setFontSize, resetAppearance],
  )

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

export function useAppearance() {
  const context = useContext(AppearanceContext)
  if (!context) throw new Error('useAppearance 必须在 AppearanceProvider 内使用')
  return context
}
