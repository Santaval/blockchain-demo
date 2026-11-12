import { connect, bindStatus } from '/shared/socket.js';

const MAX_MEMPOOL = 8;
const $ = (id) => document.getElementById(id);
const socket = connect('pantalla');
bindStatus(socket, $('status'));

let mineIntervalMs = 0;
let lastBlockAt = Date.now();
let lastHeight = null;
let state = null;
const sig = { chain: null, mempool: null, panel: null, logs: null };
const freshBlocks = new Set();
const freshTxs = new Set();

let publicUrl = '';
fetch('/api/info').then((r) => r.json()).then((i) => { publicUrl = i.url; $('url-small').textContent = i.url.replace(/^https?:\/\//, ''); if (state) renderPanel(state); }).catch(() => {});

const PANEL_TITLES = { qr: 'Bienvenida', red: 'Red', votacion: 'Votación', subasta: 'Subasta', banco: 'Banco' };

const short = (h) => (h ? h.slice(0, 10) + '…' : '');

// Hash with leading zeros emphasized (built with DOM nodes, never innerHTML).
function hashEl(h) {
  const span = document.createElement('span');
  span.className = 'hash mono';
  const zeros = (h.match(/^0*/) || [''])[0].length;
  const shown = h.slice(0, 10);
  const z = Math.min(zeros, shown.length);
  if (z) {
    const zs = document.createElement('span');
    zs.className = 'zeros';
    zs.textContent = shown.slice(0, z);
    span.appendChild(zs);
  }
  span.appendChild(document.createTextNode(shown.slice(z) + (h.length > 10 ? '…' : '')));
  return span;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(label, valueNode) {
  const r = el('div', 'row');
  r.appendChild(el('span', 'k', label));
  r.appendChild(valueNode);
  return r;
}

// Mining strip: idle / mining a block, with the current hash and its leading zeros highlighted.
let mining = null; // { index, difficulty }
function minerHash(h, difficulty) {
  const box = $('miner-hash');
  box.replaceChildren();
  const zeros = (h.match(/^0*/) || [''])[0].length;
  box.classList.toggle('hit', zeros >= difficulty);
  if (zeros) box.appendChild(el('span', 'zeros', h.slice(0, zeros)));
  box.append(h.slice(zeros));
}
function setMining(info) {
  mining = info;
  $('miner-strip').classList.toggle('active', !!info);
  $('miner-title').textContent = info ? `${info.remine ? 'Re-minando' : 'Minando'} bloque #${info.index}` : 'Esperando transacciones…';
  if (!info) { $('miner-nonce').textContent = '-'; $('miner-hash').replaceChildren(); }
}

function renderChain(s) {
  const root = $('chain');
  root.replaceChildren();
  const chain = s.chain || [];
  chain.forEach((b, i) => {
    const v = (s.validity || [])[i];
    const invalid = v && v.valid === false;
    if (i > 0) root.appendChild(el('div', 'link', '→'));
    const card = el('div', 'block' + (invalid ? ' invalid' : '') + (freshBlocks.has(b.hash) ? ' fresh' : ''));
    const isGenesis = b.index === 0;
    card.appendChild(el('div', 'title', isGenesis ? 'Génesis' : 'Bloque #' + b.index));
    card.appendChild(row('prev', isGenesis ? el('span', 'hash mono', '—') : hashEl(b.prevHash || '')));
    card.appendChild(row('hash', hashEl(b.hash || '')));
    const meta = el('div', 'meta');
    const nonce = el('span', 'mono');
    nonce.append('nonce ');
    nonce.appendChild(el('b', null, String(b.nonce)));
    const txs = el('span');
    txs.appendChild(el('b', null, String((b.txs || []).length)));
    txs.append(' tx');
    meta.append(nonce, txs);
    card.appendChild(meta);
    if (invalid) card.appendChild(el('div', 'reason', '✖ ' + (v.reason || 'inválido')));
    root.appendChild(card);
  });
}

function renderMempool(s) {
  const nick = new Map((s.accounts || []).map((a) => [a.address, a.nick]));
  const name = (addr) => nick.get(addr) || (addr ? addr.slice(0, 8) + '…' : '?');
  const txs = [...(s.mempool || [])].reverse(); // newest on top
  $('mempool-count').textContent = String(txs.length);
  const ul = $('mempool');
  ul.replaceChildren();
  if (!txs.length) {
    ul.appendChild(el('li', 'empty', 'Mempool vacío'));
    return;
  }
  txs.slice(0, MAX_MEMPOOL).forEach((tx) => {
    const li = el('li', freshTxs.has(tx.hash) ? 'fresh' : '');
    li.append(`${name(tx.from)} → ${name(tx.to)} · `);
    li.appendChild(el('span', 'amt', String(tx.amount)));
    li.append(tx.amount === 1 ? ' moneda' : ' monedas');
    ul.appendChild(li);
  });
  if (txs.length > MAX_MEMPOOL) ul.appendChild(el('li', 'more', `+${txs.length - MAX_MEMPOOL} más`));
}

function fullHash(h) {
  const span = el('span', 'hash mono');
  const zeros = (h.match(/^0*/) || [''])[0].length;
  if (zeros) span.appendChild(el('span', 'zeros', h.slice(0, zeros)));
  span.append(h.slice(zeros));
  return span;
}

function panelWelcome(s, body) {
  const qr = el('img', 'qr-big');
  qr.src = '/qr.svg';
  qr.alt = 'QR para unirse';
  const side = el('div', 'welcome-side');
  side.appendChild(el('div', 'welcome-title', 'Escanea para unirte'));
  side.appendChild(el('div', 'welcome-url mono', publicUrl.replace(/^https?:\/\//, '')));
  const count = el('div', 'welcome-count');
  count.appendChild(el('b', null, String(s.participants ?? 0)));
  count.append((s.participants ?? 0) === 1 ? ' participante' : ' participantes');
  side.appendChild(count);
  body.append(qr, side);
}

function panelNetwork(s, body) {
  const nick = new Map((s.accounts || []).map((a) => [a.address, a.nick]));
  const name = (addr) => nick.get(addr) || (addr ? addr.slice(0, 8) + '…' : '?');
  const last = (s.chain || [])[(s.chain || []).length - 1];

  const detail = el('div', 'net-col');
  detail.appendChild(el('h3', null, last ? (last.index === 0 ? 'Último bloque: Génesis' : `Último bloque: #${last.index}`) : 'Sin bloques'));
  if (last) {
    const kv = (k, v) => {
      const r = el('div', 'kv');
      r.appendChild(el('span', 'k', k));
      r.appendChild(typeof v === 'string' ? el('span', 'mono', v) : v);
      detail.appendChild(r);
    };
    kv('hash', fullHash(last.hash || ''));
    kv('prevHash', last.index === 0 ? '—' : fullHash(last.prevHash || ''));
    kv('nonce', String(last.nonce));
    kv('dificultad', String(last.difficulty));
    kv('hora', new Date(last.timestamp).toLocaleTimeString('es'));
    const status = new Map((s.lastBlockStatus || []).map((x) => [x.hash, x]));
    const ul = el('ul', 'net-txs');
    (last.txs || []).slice(0, 5).forEach((t) => {
      const st = status.get(t.hash);
      const failed = st && st.status === 'failed';
      const li = el('li', failed ? 'failed' : '');
      li.append(`${failed ? '✖' : '✔'} ${name(t.from)} → ${name(t.to)} · ${t.amount}`);
      if (failed && st.reason) li.appendChild(el('span', 'why', ' (' + st.reason + ')'));
      ul.appendChild(li);
    });
    if ((last.txs || []).length > 5) ul.appendChild(el('li', 'more', `+${last.txs.length - 5} más`));
    if (!(last.txs || []).length) ul.appendChild(el('li', 'more', 'Sin transacciones'));
    detail.appendChild(ul);
  }

  const rank = el('div', 'net-col');
  rank.appendChild(el('h3', null, 'Ranking de saldos'));
  const top = (s.accounts || []).filter((a) => !a.system)
    .sort((a, b) => Number(b.balance) - Number(a.balance)).slice(0, 10);
  const ol = el('ol', 'ranking');
  if (!top.length) ol.appendChild(el('li', 'more', 'Aún no hay participantes'));
  top.forEach((a) => {
    const li = el('li');
    li.appendChild(el('span', 'rk-name', a.nick));
    li.appendChild(el('span', 'rk-bal', String(a.balance)));
    ol.appendChild(li);
  });
  rank.appendChild(ol);
  body.append(detail, rank);
}

// Contract panels plug in here: PANEL_RENDERERS[panelName] = (state, body) => {...}.
const PANEL_RENDERERS = {};

PANEL_RENDERERS.votacion = (s, body) => {
  const c = (s.contracts || []).find((x) => x.address === '0xVOTACION');
  const v = c?.view;
  if (!v || !v.question) return void body.appendChild(el('div', 'placeholder', 'Sin votación configurada'));
  const nick = new Map((s.accounts || []).map((a) => [a.address, a.nick]));
  const main = el('div', 'vote-main');
  const head = el('div', 'vote-head');
  head.appendChild(el('div', 'vote-question', v.question));
  head.appendChild(el('span', 'vote-badge' + (v.open ? ' open' : ''), v.open ? 'ABIERTA' : 'CERRADA'));
  main.appendChild(head);
  const max = Math.max(1, ...v.counts);
  v.options.forEach((opt, i) => {
    const r = el('div', 'vote-row');
    r.appendChild(el('span', 'vote-opt', opt));
    const track = el('div', 'vote-track');
    const bar = el('div', 'vote-bar');
    bar.style.width = (v.counts[i] / max) * 100 + '%';
    track.appendChild(bar);
    r.append(track, el('span', 'vote-count', String(v.counts[i])));
    main.appendChild(r);
  });
  const list = el('div', 'vote-list');
  list.appendChild(el('h3', null, `Votos (${v.votes.length})`));
  const ul = el('ul');
  [...v.votes].reverse().slice(0, 12).forEach((x) => {
    ul.appendChild(el('li', null, `${nick.get(x.address) || x.nick} → ${v.options[x.option]}`));
  });
  if (!v.votes.length) ul.appendChild(el('li', 'more', 'Aún no hay votos'));
  list.appendChild(ul);
  body.append(main, list);
};

PANEL_RENDERERS.subasta = (s, body) => {
  const v = (s.contracts || []).find((x) => x.address === '0xSUBASTA')?.view;
  if (!v || !v.item) return void body.appendChild(el('div', 'placeholder', 'Sin subasta abierta'));
  const main = el('div', 'auc-main');
  main.appendChild(el('div', 'auc-item', v.item));
  if (v.open) {
    const cd = el('div', 'auc-count');
    cd.dataset.endsAt = v.endsAt;
    main.appendChild(cd);
    tickAuction();
  } else main.appendChild(el('div', 'auc-count done', 'CERRADA'));
  main.appendChild(el('div', 'auc-highest', v.highest ? `${v.highest.amount} · ${v.highest.nick}` : 'Sin ofertas'));
  if (v.winner) main.appendChild(el('div', 'auc-winner', `Ganó ${v.winner.nick} · el contrato pagó ${v.winner.amount} al Presentador`));
  const side = el('div', 'auc-side');
  const list = (title, items, fmt) => {
    side.appendChild(el('h3', null, `${title} (${items.length})`));
    const ul = el('ul');
    [...items].reverse().slice(0, 8).forEach((x) => ul.appendChild(el('li', null, fmt(x))));
    if (!items.length) ul.appendChild(el('li', 'more', 'Ninguno'));
    side.appendChild(ul);
  };
  list('Ofertas', v.bids, (b) => `${b.nick} ofertó ${b.amount}`);
  list('Reembolsos', v.refunds, (r) => `${r.nick} recuperó ${r.amount}`);
  body.append(main, side);
};

function tickAuction() {
  const e = document.querySelector('.auc-count[data-ends-at]');
  if (!e) return;
  const left = Math.max(0, Math.ceil((Number(e.dataset.endsAt) - Date.now()) / 1000));
  e.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Cerrando…';
}

const MAX_LOGS = 8;
function renderContractLog(s) {
  const nick = new Map((s.accounts || []).map((a) => [a.address, a.nick]));
  const ul = $('contract-log');
  ul.replaceChildren();
  const logs = [...(s.contractLogs || [])].reverse().slice(0, MAX_LOGS); // newest first
  if (!logs.length) return void ul.appendChild(el('li', 'empty', 'Sin actividad de contratos'));
  for (const l of logs) {
    const li = el('li', l.message.startsWith('Revertido') ? 'revert' : '');
    li.appendChild(el('b', null, nick.get(l.contract) || l.contract));
    li.append(l.message);
    ul.appendChild(li);
  }
}

function renderPanel(s) {
  const panel = PANEL_TITLES[s.panel] ? s.panel : 'qr';
  $('main-panel').dataset.panel = panel;
  $('main-panel-title').textContent = PANEL_TITLES[panel];
  document.body.dataset.panel = panel; // small QR in the top bar hides while the big one shows
  const body = $('main-panel-body');
  body.replaceChildren();
  if (panel === 'qr') panelWelcome(s, body);
  else if (panel === 'red') panelNetwork(s, body);
  else if (PANEL_RENDERERS[panel]) PANEL_RENDERERS[panel](s, body);
  else body.appendChild(el('div', 'placeholder', 'Disponible en la fase 3'));
}

function render(s) {
  state = s;
  const pSig = [s.panel, s.participants, s.lastBlockStatus?.map((x) => x.hash + x.status).join(), s.chain?.at(-1)?.hash,
    s.accounts?.map((a) => a.nick + a.balance).join(), JSON.stringify(s.contracts), s.contractLogs?.length].join('|') + publicUrl;
  if (pSig !== sig.panel) { sig.panel = pSig; renderPanel(s); }
  $('tamper-banner').hidden = !s.tampered;
  if (mining && !s.mining) setMining(null); // run aborted (tamper/restore/reset)
  mineIntervalMs = s.mineIntervalMs || mineIntervalMs;
  $('participants').textContent = String(s.participants ?? 0);
  $('height').textContent = String(s.height ?? 0);
  $('difficulty').textContent = `${s.difficulty} ${s.difficulty === 1 ? 'cero' : 'ceros'}`;
  if (lastHeight !== null && s.height !== lastHeight) lastBlockAt = Date.now();
  lastHeight = s.height;
  // Only rebuild DOM when something changed, so highlight animations are not restarted.
  const cSig = (s.chain || []).map((b, i) => b.hash + ((s.validity || [])[i]?.valid === false ? 'x' : '')).join();
  if (cSig !== sig.chain) { sig.chain = cSig; renderChain(s); }
  const lSig = JSON.stringify(s.contractLogs || []) + (s.accounts || []).map((a) => a.address + a.nick).join();
  if (lSig !== sig.logs) { sig.logs = lSig; renderContractLog(s); }
  const mSig = (s.mempool || []).map((t) => t.hash).join() + '|' + (s.accounts || []).map((a) => a.address + a.nick).join();
  if (mSig !== sig.mempool) { sig.mempool = mSig; renderMempool(s); }
}

function tick() {
  if (!mineIntervalMs) return;
  const left = Math.max(0, Math.ceil((mineIntervalMs - (Date.now() - lastBlockAt)) / 1000));
  $('countdown').textContent = left > 0 ? `~${left}s` : 'minando…';
}
setInterval(tick, 250);
setInterval(tickAuction, 250);

socket.on('state:full', render);
socket.on('contract:log', (entry) => {
  if (!state) return;
  state.contractLogs = [...(state.contractLogs || []), entry].slice(-60);
  sig.logs = null;
  renderContractLog(state);
  sig.logs = JSON.stringify(state.contractLogs) + (state.accounts || []).map((a) => a.address + a.nick).join();
});
socket.on('mempool:add', (tx) => {
  freshTxs.add(tx.hash);
  setTimeout(() => freshTxs.delete(tx.hash), 2000);
});
socket.on('block:mined', (b) => {
  lastBlockAt = Date.now();
  if (mining && mining.index === b.index) {
    $('miner-nonce').textContent = String(b.nonce);
    minerHash(b.hash, b.difficulty);
    mining = null;
    $('miner-title').textContent = `Bloque #${b.index} minado`;
    const strip = $('miner-strip');
    strip.classList.remove('active', 'flash');
    void strip.offsetWidth; // restart the animation
    strip.classList.add('flash');
    setTimeout(() => { strip.classList.remove('flash'); if (!mining) setMining(null); }, 1500);
  }
  freshBlocks.add(b.hash);
  setTimeout(() => freshBlocks.delete(b.hash), 2000);
});

socket.on('block:remined', () => setMining(null));

socket.on('mine:start', (info) => {
  setMining(info);
  $('miner-nonce').textContent = '0';
  $('miner-hash').replaceChildren();
});
socket.on('mine:progress', (p) => {
  if (!mining || p.index !== mining.index) return;
  $('miner-nonce').textContent = String(p.nonce);
  minerHash(p.hash, mining.difficulty);
});
