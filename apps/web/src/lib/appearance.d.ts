export type ThemePreference = 'light' | 'dark' | 'system'
export type FontSize = 'sm' | 'md' | 'lg' | 'xl'

export const THEMES: readonly ThemePreference[]
export const FONT_SIZE_KEYS: readonly FontSize[]
export const FONT_SIZES: Record<FontSize, number>
export const DEFAULT_THEME: ThemePreference
export const DEFAULT_FONT_SIZE: FontSize
export const THEME_STORAGE_KEY: string
export const FONT_SIZE_STORAGE_KEY: string

export function normalizeTheme(value: unknown): ThemePreference
export function normalizeFontSize(value: unknown): FontSize
export function resolveTheme(theme: unknown, prefersDark: boolean): 'light' | 'dark'
export function fontPixels(size: unknown): number
