import { connect, bindStatus } from '/shared/socket.js';

const MAX_MEMPOOL = 12;
const $ = (id) => document.getElementById(id);
const socket = connect('pantalla');
bindStatus(socket, $('status'));

let mineIntervalMs = 0;
let lastBlockAt = Date.now();
let lastHeight = null;
let state = null;
const sig = { chain: null, mempool: null };
const freshBlocks = new Set();
const freshTxs = new Set();

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

function render(s) {
  state = s;
  const panel = PANEL_TITLES[s.panel] ? s.panel : 'qr';
  $('main-panel').dataset.panel = panel; // #12 fills each panel
  $('main-panel-title').textContent = PANEL_TITLES[panel];
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
  const mSig = (s.mempool || []).map((t) => t.hash).join() + '|' + (s.accounts || []).map((a) => a.address + a.nick).join();
  if (mSig !== sig.mempool) { sig.mempool = mSig; renderMempool(s); }
}

function tick() {
  if (!mineIntervalMs) return;
  const left = Math.max(0, Math.ceil((mineIntervalMs - (Date.now() - lastBlockAt)) / 1000));
  $('countdown').textContent = left > 0 ? `~${left}s` : 'minando…';
}
setInterval(tick, 250);

socket.on('state:full', render);
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
