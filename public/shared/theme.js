// Theme selection. Loaded as a plain script in <head> so the page never flashes the wrong theme.
// ?tema=claro|oscuro|auto overrides and is remembered in localStorage['tema']; auto follows the device.
// window.cycleTheme() moves auto -> claro -> oscuro and returns the new choice; window.themeChoice() reads it.
(function () {
  var MAP = { claro: 'light', oscuro: 'dark' };
  var ORDER = ['auto', 'claro', 'oscuro'];
  var choice = 'auto';
  var root = document.documentElement;
  function apply() {
    if (MAP[choice]) root.dataset.theme = MAP[choice];
    else delete root.dataset.theme;
  }
  function save() {
    try { localStorage.setItem('tema', choice); } catch (e) { /* storage unavailable */ }
  }
  try {
    var q = new URLSearchParams(location.search).get('tema');
    if (ORDER.indexOf(q) >= 0) {
      choice = q;
      save();
    } else {
      var saved = null;
      try { saved = localStorage.getItem('tema'); } catch (e) { /* storage unavailable */ }
      if (saved === 'claro' || saved === 'oscuro') choice = saved;
    }
  } catch (e) { /* keep auto */ }
  apply();
  window.themeChoice = function () { return choice; };
  window.cycleTheme = function () {
    choice = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    save();
    apply();
    return choice;
  };
})();
