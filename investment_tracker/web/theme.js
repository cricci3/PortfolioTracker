// Applica il tema salvato prima del render, per evitare il flash chiaro/scuro.
try {
  var t = localStorage.getItem('it-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
