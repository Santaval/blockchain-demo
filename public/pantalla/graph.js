// SVG workflow canvas: HTML node cards inside foreignObject, bezier edges and animated tokens.
// Fixed logical viewBox (1600x760) that the browser fits to the stage; no pan or zoom.
// Nodes are persistent elements: they are only refilled when their key changes, so animations are not restarted.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_TOKENS = 40;
const PENDING_TTL_MS = 3000;
const BLOCK_WINDOW = 5; // newest block lands under the miner, clear of the contract column
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Hash with its leading zeros emphasized (DOM nodes only, never innerHTML).
export function hashEl(h, len = 10) {
  const span = el('span', 'hash mono');
  const zeros = (h.match(/^0*/) || [''])[0].length;
  const shown = h.slice(0, len);
  const z = Math.min(zeros, shown.length);
  if (z) span.appendChild(el('span', 'zeros', shown.slice(0, z)));
  span.appendChild(document.createTextNode(shown.slice(z) + (h.length > len ? '…' : '')));
  return span;
}

const KINDS = ['trigger', 'source', 'step', 'ai', 'switch', 'tool', 'out', 'sink'];
const BANK = '0xBANCO', ATTACKER = '0xATACANTE';
export const LOOP_EDGE = `contract:${BANK}>contract:${ATTACKER}`;

export function createGraph(svg) {
  svg.innerHTML = `
    <defs>
      <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.5" class="grid-dot"/></pattern>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker>
    </defs>
    <rect class="bg" x="-2000" y="-2000" width="5600" height="4900" fill="url(#grid)"/>
    <g class="edges"></g><g class="nodes"></g><g class="tokens"></g>`;
  const gEdges = svg.querySelector('.edges');
  const gNodes = svg.querySelector('.nodes');
  const gTokens = svg.querySelector('.tokens');

  const nodes = new Map(); // id -> { fo, el, parts, key, x, y, w, h }
  const edges = new Map(); // id -> { path, d, flow, used }
  let pending = []; // tokens waiting for their edge to exist (e.g. the new block arrives after the event)
  let live = 0;
  let minerModel = { sub: 'Esperando transacciones…', active: false, nonce: '-', hash: '', hit: false };
  let minerShownHash = null;
  const minerNonce = el('div', 'mn mono');
  const minerHash = el('div', 'mh mono');

  // ---------- nodes ----------

  function makeNode(id) {
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    const card = el('div', 'node');
    card.dataset.node = id;
    const ic = el('div', 'ic');
    const tx = el('div', 'tx');
    const ttl = el('div', 'ttl');
    const sub = el('div', 'sub');
    const st = el('div', 'st');
    tx.append(ttl, sub, st);
    const badge = el('div', 'badge');
    const ring = el('div', 'ring');
    card.append(ic, tx, badge, ring);
    fo.appendChild(card);
    gNodes.appendChild(fo);
    return { fo, el: card, parts: { ic, ttl, sub, st, badge }, key: null, x: null, y: null, w: null, h: null };
  }

  function fillNode(n, d) {
    const { ic, ttl, sub, st, badge } = n.parts;
    ic.textContent = d.icon;
    ttl.textContent = d.title;
    badge.textContent = d.badge ?? '';
    if (!d.live) {
      sub.replaceChildren(...[].concat(d.sub?.() ?? []));
      st.replaceChildren(...[].concat(d.st?.() ?? []));
    }
    n.el.classList.remove(...KINDS.map((k) => `k-${k}`));
    n.el.classList.add(`k-${d.kind}`);
    n.el.classList.toggle('small', !!d.small);
    n.el.classList.toggle('block', !!d.block);
  }

  function upsertNode(id, d) {
    let n = nodes.get(id);
    const fresh = !n;
    if (fresh) { n = makeNode(id); nodes.set(id, n); }
    if (n.x !== d.x || n.y !== d.y || n.w !== d.w || n.h !== d.h) {
      n.fo.setAttribute('x', d.x); n.fo.setAttribute('y', d.y);
      n.fo.setAttribute('width', d.w); n.fo.setAttribute('height', d.h);
      Object.assign(n, { x: d.x, y: d.y, w: d.w, h: d.h });
    }
    if (n.key !== d.key) { n.key = d.key; fillNode(n, d); }
    if (id === 'miner' && fresh) {
      n.parts.st.replaceChildren(minerNonce, minerHash);
      applyMiner();
    }
    return n;
  }

  function applyMiner() {
    const n = nodes.get('miner');
    if (!n) return;
    const m = minerModel;
    n.el.classList.toggle('active', !!m.active);
    if (n.parts.sub.textContent !== m.sub) n.parts.sub.textContent = m.sub;
    const nonce = `nonce ${m.nonce}`;
    if (minerNonce.textContent !== nonce) minerNonce.textContent = nonce;
    minerHash.classList.toggle('hit', !!m.hit);
    if (minerShownHash !== m.hash) {
      minerShownHash = m.hash;
      minerHash.replaceChildren(m.hash ? hashEl(m.hash, 18) : '');
    }
  }

  /** In-place update of the miner node (no rebuild): { sub, active, nonce, hash, hit }. */
  function setMiner(m) {
    minerModel = { ...minerModel, ...m };
    applyMiner();
  }

  // ---------- edges ----------

  function rect(id) {
    const n = nodes.get(id);
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
  }

  function pathFor(spec) {
    const a = rect(spec.from), b = rect(spec.to);
    if (!a || !b) return null;
    if (spec.mode === 'loop') {
      const x = a.x, y1 = a.y + a.h / 2 + 22, y2 = b.y + b.h / 2 - 22;
      return `M${x},${y1} C${x - 130},${y1} ${x - 130},${y2} ${x},${y2}`;
    }
    if (spec.mode !== 'h' && b.y >= a.y + a.h) {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
      const dy = Math.max(30, (y2 - y1) / 2);
      return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
    }
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function upsertEdge(id, spec) {
    let e = edges.get(id);
    if (!e) {
      const path = document.createElementNS(SVG_NS, 'path');
      if (!spec.tool) path.setAttribute('marker-end', 'url(#arrow)');
      gEdges.appendChild(path);
      e = { path, d: null, flow: 0, used: false };
      edges.set(id, e);
    }
    const d = pathFor(spec);
    if (d && d !== e.d) { e.d = d; e.path.setAttribute('d', d); }
    e.path.classList.add('edge');
    e.path.classList.toggle('tool-edge', !!spec.tool);
    e.path.classList.toggle('bad', !!spec.bad);
    e.path.classList.toggle('used', e.used || !!spec.used);
  }

  // ---------- layout / sync ----------

  /**
   * model: { participants, pending, chain: [{index,hash,nonce,txs,invalid,reason}],
   *          contracts: [{address,name,figure}], selected }
   */
  function sync(model) {
    const defs = new Map();
    const specs = new Map();

    const nPart = model.participants ?? 0;
    defs.set('wallets', {
      x: 30, y: 125, w: 320, h: 130, kind: 'trigger', icon: '◉', title: 'Participantes',
      key: `p${nPart}`, sub: () => `${nPart} ${nPart === 1 ? 'conectado' : 'conectados'}`,
    });
    defs.set('mempool', {
      x: 430, y: 125, w: 320, h: 130, kind: 'source', icon: '☰', title: 'Mempool',
      key: `m${model.pending}`, badge: model.pending ? String(model.pending) : '',
      sub: () => 'transacciones en espera',
    });
    defs.set('miner', { x: 830, y: 95, w: 400, h: 190, kind: 'ai', icon: '✦', title: 'Minero', key: 'miner', live: true });
    specs.set('wallets>mempool', { from: 'wallets', to: 'mempool' });
    specs.set('mempool>miner', { from: 'mempool', to: 'miner' });

    const chain = (model.chain || []).slice(-BLOCK_WINDOW);
    const first = BLOCK_WINDOW - chain.length;
    let prevId = null, lastId = null;
    chain.forEach((b, i) => {
      const id = `block:${b.index}`;
      const nTx = b.txs;
      defs.set(id, {
        x: 10 + (first + i) * 262, y: 520, w: 228, h: 220, kind: b.invalid ? 'sink' : 'out', block: true,
        icon: b.invalid ? '✖' : '▣', title: b.index === 0 ? 'Génesis' : `#${b.index}`, badge: b.invalid ? '✖' : '',
        key: [b.hash, b.nonce, nTx, b.invalid ? b.reason || 'x' : ''].join('|'),
        sub: () => hashEl(b.hash || '', 8),
        st: () => {
          const out = [el('div', null, `nonce ${b.nonce}`), el('div', null, `${nTx} tx`)];
          if (b.invalid) out.push(el('div', 'why', b.reason || 'inválido'));
          return out;
        },
      });
      if (prevId) specs.set(`${prevId}>${id}`, { from: prevId, to: id, used: true, bad: b.invalid });
      prevId = lastId = id;
    });
    if (lastId) {
      const lastB = chain[chain.length - 1];
      specs.set(`miner>${lastId}`, { from: 'miner', to: lastId, used: true, bad: lastB.invalid });
    }

    (model.contracts || []).forEach((c, i) => {
      const id = `contract:${c.address}`;
      defs.set(id, {
        x: 1300, y: 20 + i * 112, w: 280, h: 96, kind: 'tool', small: true, icon: '⚙', title: c.name,
        key: `${c.name}|${c.figure}`, st: () => c.figure,
      });
      specs.set(`miner>${id}`, { from: 'miner', to: id, mode: 'h', tool: true });
    });
    if (defs.has(`contract:${BANK}`) && defs.has(`contract:${ATTACKER}`)) {
      specs.set(LOOP_EDGE, { from: `contract:${BANK}`, to: `contract:${ATTACKER}`, mode: 'loop', tool: true });
    }

    for (const [id, d] of defs) upsertNode(id, d);
    for (const [id, n] of nodes) {
      if (!defs.has(id)) { n.fo.remove(); nodes.delete(id); }
    }
    for (const [id, spec] of specs) upsertEdge(id, spec);
    for (const [id, e] of edges) {
      if (!specs.has(id)) { e.path.remove(); edges.delete(id); }
    }
    for (const [id, n] of nodes) n.el.classList.toggle('selected', id === model.selected);
    flushPending();
  }

  // ---------- tokens ----------

  function pop(id) {
    const n = nodes.get(id);
    if (!n) return;
    n.el.classList.remove('pulse');
    void n.el.offsetWidth; // restart the animation
    n.el.classList.add('pulse');
  }

  function flushPending() {
    if (!pending.length) return;
    const now = Date.now();
    const waiting = pending;
    pending = [];
    for (const p of waiting) {
      if (now > p.until) continue;
      if (edges.has(p.id)) run(p.id, p.opts);
      else pending.push(p);
    }
  }

  /** Sends a glowing token along an edge. opts: { cls, reverse, delay, dur, onDone }. */
  function token(id, opts = {}) {
    if (reduceMotion.matches) { opts.onDone?.(); return; }
    if (opts.delay) {
      const { delay, ...rest } = opts;
      setTimeout(() => token(id, rest), delay);
      return;
    }
    if (!edges.has(id)) { pending.push({ id, opts, until: Date.now() + PENDING_TTL_MS }); return; }
    run(id, opts);
  }

  function run(id, { cls = '', reverse = false, dur = 650, onDone } = {}) {
    const e = edges.get(id);
    if (!e || live >= MAX_TOKENS) { onDone?.(); return; }
    live++;
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '9');
    dot.setAttribute('class', `token ${cls}`.trim());
    gTokens.appendChild(dot);
    e.flow++;
    e.used = true;
    e.path.classList.add('flow', 'used');
    const len = e.path.getTotalLength();
    let t0 = null;
    const step = (now) => {
      t0 ??= now;
      const p = Math.min(1, (now - t0) / dur);
      const ease = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      const pt = e.path.getPointAtLength(len * (reverse ? 1 - ease : ease));
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      if (p < 1) return requestAnimationFrame(step);
      dot.remove();
      live--;
      if (--e.flow <= 0) e.path.classList.remove('flow');
      onDone?.();
    };
    requestAnimationFrame(step);
  }

  return { sync, setMiner, token, pop, hasEdge: (id) => edges.has(id) };
}
