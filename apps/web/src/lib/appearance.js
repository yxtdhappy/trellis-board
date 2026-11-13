export const THEMES = ['light', 'dark', 'system']
export const FONT_SIZE_KEYS = ['sm', 'md', 'lg', 'xl']
export const FONT_SIZES = { sm: 14, md: 16, lg: 18, xl: 20 }
export const DEFAULT_THEME = 'system'
export const DEFAULT_FONT_SIZE = 'md'
export const THEME_STORAGE_KEY = 'trellis-theme'
export const FONT_SIZE_STORAGE_KEY = 'trellis-font-size'

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME
}

export function normalizeFontSize(value) {
  return FONT_SIZE_KEYS.includes(value) ? value : DEFAULT_FONT_SIZE
}

export function resolveTheme(theme, prefersDark) {
  const preference = normalizeTheme(theme)
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference === 'dark' ? 'dark' : 'light'
}

export function fontPixels(size) {
  return FONT_SIZES[normalizeFontSize(size)]
}
