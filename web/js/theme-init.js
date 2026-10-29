// Runs before the page paints so dark mode does not flash.
(function () {
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('advisor:theme')); } catch (e) { /* storage off */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
})();
