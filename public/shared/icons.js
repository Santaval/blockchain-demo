// Inline SVG icon set shared by pantalla, admin and wallet. Stroke icons on a 24x24 grid that take the text color,
// so they look the same on every device (no emoji or symbol fonts involved).
const SVG_NS = 'http://www.w3.org/2000/svg';

// name -> path data, or [path data, ...extra shapes as [tag, attrs]]
const ICONS = {
  logo: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', ['circle', { cx: 9, cy: 7, r: 4 }]],
  layers: 'M12 2 2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5',
  pick: ['M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2', ['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }], ['rect', { x: 9, y: 9, width: 6, height: 6, rx: 1 }]],
  block: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  contract: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  flask: 'M9 3h6M10 3v6L4.5 18.5a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3M7.5 15h9',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  key: ['M10.7 12.3 21 2M17 6l3 3M14 9l2 2', ['circle', { cx: 7.5, cy: 15.5, r: 4.5 }]],
  clock: ['M12 7v5l3 2', ['circle', { cx: 12, cy: 12, r: 9 }]],
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  screen: ['M8 21h8M12 17v4', ['rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }]],
  vote: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
  bank: 'M3 21h18M5 21V10M19 21V10M9.5 21V10M14.5 21V10M2 9l10-6 10 6z',
  wallet: 'M3 5a2 2 0 0 1 2-2h13v4h2v14H5a2 2 0 0 1-2-2zM3 5a2 2 0 0 0 2 2h13M16.5 14h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  'arrow-down': 'M12 5v14M5 12l7 7 7-7',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  play: 'M6 4l14 8-14 8z',
  circle: ['', ['circle', { cx: 12, cy: 12, r: 9 }]],
  spinner: 'M21 12a9 9 0 1 1-6.2-8.6',
  contrast: ['M12 3v18', ['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 3a9 9 0 0 1 0 18z', fill: 'currentColor', stroke: 'none' }]],
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  fork: ['M6 7.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2M12 12.5v4', ['circle', { cx: 6, cy: 5, r: 2.5 }], ['circle', { cx: 18, cy: 5, r: 2.5 }], ['circle', { cx: 12, cy: 19, r: 2.5 }]],
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  copy: ['M5 15V5a2 2 0 0 1 2-2h10', ['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }]],
  scale: 'M12 3v18M6 21h12M4 7h16M5 7 2.5 14a3 3 0 0 0 5 0zM19 7l-2.5 7a3 3 0 0 0 5 0z',
  clipboard: 'M9 2h6v4H9zM9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 14l2 2 4-4',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  back: 'M19 12H5M12 19l-7-7 7-7',
};

/** Returns an <svg> for the named icon (falls back to a plain circle). */
export function icon(name, cls) {
  const def = ICONS[name] ?? ICONS.circle;
  const [d, ...extra] = Array.isArray(def) ? def : [def];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon i-${name}${cls ? ' ' + cls : ''}`);
  if (d) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  for (const [tag, attrs] of extra) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e);
  }
  return svg;
}

/** Fills every [data-icon] placeholder under `root` once. */
export function hydrateIcons(root = document) {
  for (const e of root.querySelectorAll('[data-icon]')) {
    if (e.firstElementChild?.classList.contains('icon')) continue;
    e.prepend(icon(e.dataset.icon));
  }
}

// Theme button: cycles auto -> claro -> oscuro (see theme.js).
const THEME_LABEL = { auto: 'Tema: automático', claro: 'Tema: claro', oscuro: 'Tema: oscuro' };
function initThemeToggle() {
  for (const b of document.querySelectorAll('[data-theme-toggle]')) {
    const paint = (choice) => { b.title = THEME_LABEL[choice] ?? THEME_LABEL.auto; b.setAttribute('aria-label', b.title); };
    paint(window.themeChoice?.() ?? 'auto');
    b.addEventListener('click', () => paint(window.cycleTheme?.() ?? 'auto'));
  }
}

hydrateIcons();
initThemeToggle();
