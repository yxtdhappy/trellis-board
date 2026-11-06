(function () {
  function storedTheme() {
    try {
      return window.localStorage.getItem('trellis-theme');
    } catch {
      return null;
    }
  }
  var stored = storedTheme();
  var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
