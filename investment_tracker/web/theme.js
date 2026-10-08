// Apply the saved theme before first render to avoid a light/dark flash.
try {
  var t = localStorage.getItem('it-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
