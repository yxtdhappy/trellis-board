import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
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

  const setTheme = useCallback((next: ThemePreference) => setThemeState(normalizeTheme(next)), [])
  const setFontSize = useCallback((next: FontSize) => setFontSizeState(normalizeFontSize(next)), [])
  const resetAppearance = useCallback(() => {
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
