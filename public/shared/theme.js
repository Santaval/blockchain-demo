// Theme selection. Loaded as a plain script in <head> so the page never flashes the wrong theme.
// ?tema=claro|oscuro|auto overrides and is remembered in localStorage['tema']; auto follows the device.
(function () {
  var MAP = { claro: 'light', oscuro: 'dark' };
  var choice = 'auto';
  try {
    var q = new URLSearchParams(location.search).get('tema');
    if (q === 'claro' || q === 'oscuro' || q === 'auto') {
      choice = q;
      try { localStorage.setItem('tema', q); } catch (e) { /* storage unavailable */ }
    } else {
      var saved = null;
      try { saved = localStorage.getItem('tema'); } catch (e) { /* storage unavailable */ }
      if (saved === 'claro' || saved === 'oscuro') choice = saved;
    }
  } catch (e) { /* keep auto */ }
  var root = document.documentElement;
  if (MAP[choice]) root.dataset.theme = MAP[choice];
  else delete root.dataset.theme;
})();
