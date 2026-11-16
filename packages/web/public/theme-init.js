;(function () {
  var THEMES = ['light', 'dark', 'system']
  var FONT_SIZES = { sm: 14, md: 16, lg: 18, xl: 20 }
  var DEFAULT_THEME = 'system'
  var DEFAULT_FONT_SIZE = 'md'
  var media = window.matchMedia('(prefers-color-scheme: dark)')

  function read(key) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }

  function themePreference() {
    var value = read('trellis-theme')
    return THEMES.indexOf(value) >= 0 ? value : DEFAULT_THEME
  }

  function fontSizePreference() {
    var value = read('trellis-font-size')
    return FONT_SIZES[value] ? value : DEFAULT_FONT_SIZE
  }

  function apply() {
    var root = document.documentElement
    var theme = themePreference()
    var dark = theme === 'system' ? media.matches : theme === 'dark'
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
    root.dataset.theme = theme
    root.dataset.fontSize = fontSizePreference()
  }

  apply()
  media.addEventListener('change', function () {
    if (themePreference() === 'system') apply()
  })
})()
