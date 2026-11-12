import { connect, bindStatus } from '/shared/socket.js';
import {
  generateKeyPair, exportPublicKeyHex, exportPrivateJwk, importPrivateJwk,
  addressFromPubKeyHex, buildTx, signTx,
} from '/shared/wallet-crypto.js';

const $ = (id) => document.getElementById(id);
const K = { priv: 'wallet.privJwk', pub: 'wallet.pubHex', nick: 'wallet.nick' };

let privateKey = null;
let privJwk = null;
let pubHex = null;
let nick = null;
let state = null;
let localNonce = null;      // bumped after a successful submit until next state
let sending = false;
const rejected = [];        // in-memory locally rejected txs
let toastTimer = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('error');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }

function emitAck(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      resolve(err ? { ok: false, reason: 'Sin respuesta del servidor' } : res);
    });
  });
}

function loadStored() {
  try {
    const j = localStorage.getItem(K.priv), p = localStorage.getItem(K.pub), n = localStorage.getItem(K.nick);
    if (j && p && n) return { jwk: JSON.parse(j), pub: p, nick: n };
  } catch { /* ignore */ }
  return null;
}

async function register() {
  const res = await emitAck('register', { nick, pubKey: pubHex });
  if (res?.ok) {
    if (wantMining) joinPool(); // reconnect or server reset: the server forgot us
    $('onboarding').hidden = true;
    $('main').hidden = false;
    $('tabs').hidden = false;
    $('nick-label').textContent = res.nick ?? nick;
    $('address').textContent = res.address;
    $('pub').textContent = pubHex;
    $('priv').textContent = (privJwk.d || '').slice(0, 8) + '…';
  }
  return res;
}

function showOnboarding(msg) {
  $('main').hidden = true;
  $('tabs').hidden = true;
  $('top-balance').hidden = true;
  $('onboarding').hidden = false;
  showError($('onboard-error'), msg || '');
}

async function startWithKeys() {
  const res = await register();
  if (!res?.ok) {
    // Stored nick may be taken (e.g. after server reset); let the user pick another.
    $('nick').value = nick || '';
    showOnboarding(res?.reason || 'No se pudo registrar');
  }
}

$('onboard-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('onboard-btn');
  const value = $('nick').value.trim().slice(0, 20);
  if (!value) return showError($('onboard-error'), 'Escribe un apodo');
  btn.disabled = true;
  try {
    if (!privateKey) {
      const kp = await generateKeyPair();
      privateKey = kp.privateKey;
      privJwk = await exportPrivateJwk(kp.privateKey);
      pubHex = await exportPublicKeyHex(kp.publicKey);
    }
    nick = value;
    const res = await register();
    if (res?.ok) {
      try {
        localStorage.setItem(K.priv, JSON.stringify(privJwk));
        localStorage.setItem(K.pub, pubHex);
        localStorage.setItem(K.nick, nick);
      } catch { /* storage unavailable */ }
    } else {
      showError($('onboard-error'), res?.reason || 'No se pudo registrar');
    }
  } catch (err) {
    showError($('onboard-error'), 'Error: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

$('address').addEventListener('click', async () => {
  const text = $('address').textContent;
  try { await navigator.clipboard.writeText(text); toast('Dirección copiada'); }
  catch {
    const r = document.createRange(); r.selectNodeContents($('address'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    toast('Selecciona y copia la dirección');
  }
});

$('keys-toggle').addEventListener('click', () => {
  const k = $('keys');
  k.hidden = !k.hidden;
  $('keys-toggle').textContent = k.hidden ? 'Ver mis llaves' : 'Ocultar mis llaves';
});

// ---- Rendering ----
function renderNicks() {
  const sel = $('to');
  const prev = sel.value;
  const others = (state?.nicks || []).filter((n) => n.address !== state.address);
  sel.innerHTML = '';
  if (!others.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'No hay compañeros conectados';
    sel.appendChild(o);
  }
  for (const n of others) {
    const o = document.createElement('option');
    o.value = n.address; o.textContent = n.nick;
    sel.appendChild(o);
  }
  if (others.some((n) => n.address === prev)) sel.value = prev;
}

const STATUS_CHIP = { pending: 'c-neutral blink', confirmed: 'c-ok', failed: 'c-bad', rejected: 'c-bad' };

function histRow(cls, label, amount, status, statusCls) {
  const li = document.createElement('li');
  li.className = cls;
  const ic = document.createElement('div'); ic.className = 'dir'; ic.textContent = cls === 'in' ? '↓' : '↑';
  const left = document.createElement('div'); left.className = 'tx';
  const a = document.createElement('div'); a.className = 'who'; a.textContent = label;
  const s = document.createElement('span'); s.className = 'chip ' + (STATUS_CHIP[statusCls] || 'c-neutral'); s.textContent = status;
  left.append(a, s);
  const amt = document.createElement('div'); amt.className = 'amt';
  amt.textContent = (cls === 'in' ? '+' : '-') + amount;
  li.append(ic, left, amt);
  return li;
}

function renderHistory() {
  const ul = $('history');
  ul.innerHTML = '';
  for (const r of rejected) {
    ul.appendChild(histRow('out', `Enviaste a ${r.toNick}`, r.amount, `rechazada (${r.reason})`, 'rejected'));
  }
  for (const h of state?.history || []) {
    const mine = h.from === state.address;
    let label = mine ? `Enviaste a ${h.toNick || h.to}` : `Recibiste de ${h.fromNick || h.from}`;
    if (h.reward) label = 'Recompensa de minería';
    else if (h.call) label = `Llamaste ${h.call.method} en ${h.toNick || h.to}`;
    else if (h.internal) label = mine ? `Pagaste a ${h.toNick || h.to}` : `${h.fromNick || h.from} te pagó`;
    let st, cls = h.status;
    if (h.status === 'confirmed') st = `confirmada (bloque #${h.block})`;
    else if (h.status === 'failed') st = `fallida (${h.reason || 'sin motivo'})`;
    else st = 'pendiente';
    ul.appendChild(histRow(mine ? 'out' : 'in', label, h.amount, st, cls));
  }
  $('history-empty').hidden = ul.children.length > 0;
}

function render() {
  if (!state) return;
  $('balance').textContent = state.balance;
  $('top-balance').textContent = `${state.balance} monedas`;
  $('top-balance').hidden = false;
  const diff = String(state.available) !== String(state.balance);
  $('available-row').hidden = !diff;
  $('available').textContent = state.available;
  $('height').textContent = state.height;
  renderNicks();
  renderHistory();
  renderContracts();
  applyPool(state.pool);
}

// ---- Tabs: one section per screen, remembered for this browser tab ----
const TABS = ['inicio', 'enviar', 'minar', 'contratos', 'historial'];
let currentTab = 'inicio';
let knownContracts = 0;
function showTab(name) {
  if (!TABS.includes(name)) name = 'inicio';
  currentTab = name;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'contratos') $('tab-dot').hidden = true;
  if (name === 'minar') $('mine-dot').hidden = true;
  try { sessionStorage.setItem('wallet.tab', name); } catch { /* ignore */ }
  window.scrollTo(0, 0);
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
try { showTab(sessionStorage.getItem('wallet.tab') || 'inicio'); } catch { showTab('inicio'); }

// ---- Contracts ----
// Per-contract card renderers: CARD_RENDERERS[address] = (container, contract) => {...}. Unknown ones show the name only.
const CARD_RENDERERS = {};
let contractsSig = null;

function renderContracts() {
  const active = (state?.contracts || []).filter((c) => c.active);
  const sig = JSON.stringify(active);
  if (sig === contractsSig) return; // keep inputs and focus while nothing changed
  contractsSig = sig;
  const root = $('contracts');
  root.replaceChildren();
  root.hidden = active.length === 0;
  $('contracts-empty').hidden = active.length > 0;
  // Flag new contracts on the tab when the user is elsewhere.
  if (active.length > knownContracts && currentTab !== 'contratos') $('tab-dot').hidden = false;
  knownContracts = active.length;
  for (const c of active) {
    const section = document.createElement('section');
    section.className = 'card';
    const head = document.createElement('div');
    head.className = 'node small k-tool';
    const ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = '⚙';
    const tx = document.createElement('div'); tx.className = 'tx';
    const ttl = document.createElement('div'); ttl.className = 'ttl'; ttl.textContent = c.name;
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = c.address;
    tx.append(ttl, sub);
    head.append(ic, tx);
    const card = document.createElement('div');
    card.className = 'body';
    section.append(head, card);
    CARD_RENDERERS[c.address]?.(card, c);
    root.appendChild(section);
  }
}

CARD_RENDERERS['0xVOTACION'] = (card, c) => {
  const v = c.view;
  const q = document.createElement('p');
  q.className = 'vote-question';
  q.textContent = v.question;
  card.appendChild(q);
  const myVote = c.me?.myVote;
  if (myVote != null) {
    const done = document.createElement('p');
    done.className = 'vote-done';
    done.textContent = `Ya votaste: ${v.options[myVote]}`;
    card.appendChild(done);
  } else if (!v.open) {
    const closed = document.createElement('p');
    closed.className = 'muted';
    closed.textContent = 'La votación está cerrada';
    card.appendChild(closed);
  } else {
    v.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn vote-btn';
      b.textContent = opt;
      b.addEventListener('click', async () => {
        card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        const res = await callContract(c.address, 'votar', [i], 0);
        if (!res?.ok) card.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      });
      card.appendChild(b);
    });
  }
  const counts = document.createElement('p');
  counts.className = 'muted small';
  counts.textContent = v.options.map((o, i) => `${o}: ${v.counts[i]}`).join(' · ');
  card.appendChild(counts);
};

CARD_RENDERERS['0xSUBASTA'] = (card, c) => {
  const v = c.view;
  const add = (cls, text) => {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    card.appendChild(p);
    return p;
  };
  add('auction-item', v.item);
  add('muted', v.highest ? `Oferta más alta: ${v.highest.amount} (${v.highest.nick})` : 'Sin ofertas todavía');
  if (!v.open) {
    add('auction-done', v.winner ? `Subasta cerrada. Ganó ${v.winner.nick} con ${v.winner.amount}` : 'Subasta cerrada');
    return;
  }
  const count = add('auction-count', '');
  count.dataset.endsAt = v.endsAt;
  updateAuctionCountdown();
  if (c.me?.isHighest) add('vote-done', 'Vas ganando');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.inputMode = 'numeric';
  input.placeholder = 'Tu oferta';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn primary';
  b.textContent = 'Ofertar';
  b.addEventListener('click', async () => {
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 1) return toast('Escribe una oferta válida');
    b.disabled = true;
    const res = await callContract(c.address, 'ofertar', [], amount);
    if (res?.ok) input.value = '';
    b.disabled = false;
  });
  card.append(input, b);
};

CARD_RENDERERS['0xBANCO'] = (card, c) => {
  const add = (cls, text) => {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    card.appendChild(p);
  };
  add('muted', `Saldo del banco: ${c.view.balance}`);
  add('auction-item', `Tu depósito: ${c.me?.myDeposit ?? 0}`);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.inputMode = 'numeric';
  input.placeholder = 'Monto a depositar';
  const dep = document.createElement('button');
  dep.type = 'button';
  dep.className = 'btn primary';
  dep.textContent = 'Depositar';
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'btn';
  out.textContent = 'Retirar';
  out.disabled = !(c.me?.myDeposit > 0);
  const run = async (method, amount) => {
    dep.disabled = out.disabled = true;
    const res = await callContract(c.address, method, [], amount);
    if (res?.ok) input.value = '';
    dep.disabled = false;
    out.disabled = !(c.me?.myDeposit > 0);
  };
  dep.addEventListener('click', () => {
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 1) return toast('Escribe un monto válido');
    run('depositar', amount);
  });
  out.addEventListener('click', () => run('retirar', 0));
  card.append(input, dep, out);
};

CARD_RENDERERS['0xATACANTE'] = (card, c) => {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = 'Deposita en el banco y trata de sacar más de lo que pusiste.';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.inputMode = 'numeric';
  input.placeholder = 'Monto del ataque';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn danger';
  b.textContent = 'Atacar';
  b.addEventListener('click', async () => {
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 1) return toast('Escribe un monto válido');
    b.disabled = true;
    const res = await callContract(c.address, 'atacar', [], amount);
    if (res?.ok) input.value = '';
    b.disabled = false;
  });
  card.append(p, input, b);
};

function updateAuctionCountdown() {
  const e = document.querySelector('.auction-count');
  if (!e) return;
  const left = Math.max(0, Math.ceil((Number(e.dataset.endsAt) - Date.now()) / 1000));
  e.textContent = left > 0 ? `Quedan ${left} s` : 'Cerrando…';
}
setInterval(updateAuctionCountdown, 500);

// Builds, signs and submits a tx that calls a contract method. Returns the ack ({ ok, reason }).
async function callContract(address, method, args = [], amount = 0) {
  if (sending || !state) return { ok: false, reason: 'Espera un momento' };
  sending = true;
  try {
    const nonce = localNonce ?? state.nonce;
    const partial = await buildTx({ to: address, amount, nonce, call: { method, args }, pubKey: pubHex });
    const tx = await signTx(privateKey, partial);
    const res = await emitAck('tx:submit', tx);
    if (res?.ok) { localNonce = nonce + 1; toast('Llamada enviada'); }
    else toast(res?.reason || 'Llamada rechazada');
    return res;
  } catch (ex) {
    toast('Error: ' + ex.message);
    return { ok: false, reason: ex.message };
  } finally {
    sending = false;
  }
}

// ---- Send ----
$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending || !state) return;
  const err = $('send-error');
  showError(err, '');
  const to = $('to').value;
  const amount = Number($('amount').value);
  if (!to) return showError(err, 'Elige un compañero');
  if (!Number.isInteger(amount) || amount <= 0) return showError(err, 'El monto debe ser un entero positivo');
  sending = true;
  $('send-btn').disabled = true;
  const toNick = $('to').selectedOptions[0]?.textContent || to;
  try {
    const nonce = localNonce ?? state.nonce;
    const partial = await buildTx({ to, amount, nonce, pubKey: pubHex });
    const tx = await signTx(privateKey, partial);
    const res = await emitAck('tx:submit', tx);
    if (res?.ok) {
      localNonce = nonce + 1;
      $('amount').value = '';
      toast('Transacción enviada');
    } else {
      const reason = res?.reason || 'rechazada';
      showError(err, reason);
      addRejected(tx.hash, toNick, amount, reason);
    }
  } catch (ex) {
    showError(err, 'Error: ' + ex.message);
  } finally {
    sending = false;
    $('send-btn').disabled = false;
  }
});

function addRejected(hash, toNick, amount, reason) {
  if (hash && rejected.some((r) => r.hash === hash)) return;
  rejected.unshift({ hash, toNick, amount, reason });
  renderHistory();
}


// ---- Pool mining ----
// `wantMining` is the user's intent: it survives reconnects and server resets (we re-join) but not a disabled pool.
let wantMining = false;
let worker = null;
let job = null;            // current { round, index, difficulty, prefix, rate, reward }
let poolInfo = null;       // latest { enabled, reason, etaSeconds, won, reward, ... }
let poolWasEnabled = true;
let lastProgressAt = 0;
let wakeLock = null;
let joining = false;

function setStatus(text) { $('mine-status').textContent = text; }

function paintHash(hash, difficulty) {
  const box = $('mine-hash');
  const zeros = (hash.match(/^0*/) || [''])[0].length;
  box.replaceChildren();
  if (zeros) { const z = document.createElement('span'); z.className = 'zeros'; z.textContent = hash.slice(0, zeros); box.appendChild(z); }
  box.append(hash.slice(zeros) || (zeros ? '' : '-'));
  box.classList.toggle('hit', !!hash && zeros >= difficulty);
}

function renderMineUi() {
  const btn = $('mine-btn');
  const disabled = poolInfo && !poolInfo.enabled;
  btn.textContent = wantMining ? 'Detener' : 'Empezar a minar';
  btn.classList.toggle('stop', wantMining);
  btn.classList.toggle('primary', !wantMining);
  btn.disabled = !!disabled || joining;
  $('mine-live').hidden = !wantMining;
  $('mine-won').textContent = poolInfo?.won ?? 0;
  $('mine-reward').textContent = poolInfo?.reward ?? 10;
}

async function acquireWakeLock() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* unsupported or denied: the hint still asks to keep the screen on */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantMining) acquireWakeLock();
});

function stopWorker() {
  if (worker) { try { worker.postMessage({ type: 'stop' }); } catch { /* ignore */ } worker.terminate(); worker = null; }
  job = null;
}

async function joinPool() {
  const res = await emitAck('pool:join', {});
  if (!res?.ok) {
    wantMining = false;
    releaseWakeLock();
    stopWorker();
    if (poolInfo) poolInfo.enabled = res?.reason ? false : poolInfo.enabled;
    showPoolWarn(res?.reason || 'No se pudo unir a los mineros');
    renderMineUi();
    return false;
  }
  if (poolInfo) { poolInfo.reward = res.reward ?? poolInfo.reward; }
  if (!job) setStatus('Esperando el próximo bloque…');
  return true;
}

function showPoolWarn(text) {
  $('mine-warn').textContent = text;
  $('mine-warn').hidden = !text;
}

async function startMining() {
  if (joining || wantMining) return;
  joining = true;
  renderMineUi();
  $('mine-win').hidden = true;
  wantMining = true;
  setStatus('Uniéndote a los mineros…');
  const ok = await joinPool();
  joining = false;
  if (ok) { showPoolWarn(''); acquireWakeLock(); }
  renderMineUi();
}

function stopMining() {
  wantMining = false;
  stopWorker();
  releaseWakeLock();
  socket.emit('pool:leave', {});
  setStatus('Pulsa el botón para unirte a los mineros.');
  renderMineUi();
}

$('mine-btn').addEventListener('click', () => { if (wantMining) stopMining(); else startMining(); });

// Reacts to pool info coming from `state` or `pool:state`.
function applyPool(p) {
  if (!p) return;
  poolInfo = p;
  if (!p.enabled) {
    if (wantMining) {
      // The server keeps registered miners, so leave explicitly.
      wantMining = false;
      stopWorker();
      releaseWakeLock();
      socket.emit('pool:leave', {});
      setStatus('Minería detenida.');
    }
    showPoolWarn(p.reason || 'La minería está desactivada');
  } else if (!poolWasEnabled) {
    showPoolWarn('');
    setStatus('Puedes volver a minar');
  }
  poolWasEnabled = p.enabled;
  renderMineUi();
}

function onJob(j) {
  if (!wantMining) return;
  stopWorker();
  job = j;
  $('mine-win').hidden = true;
  lastProgressAt = 0;
  setStatus(`Minando bloque #${j.index}`);
  $('mine-nonce').textContent = '0';
  $('mine-tried').textContent = '0';
  paintHash('', j.difficulty);
  try {
    worker = new Worker('/wallet/miner-worker.js', { type: 'module' });
  } catch (ex) {
    setStatus('Tu navegador no puede minar: ' + ex.message);
    return;
  }
  worker.onmessage = ({ data }) => onWorkerMessage(data);
  worker.postMessage({ type: 'job', job: j });
}

async function onWorkerMessage(m) {
  if (!job || m.round !== job.round) return;
  if (m.type === 'progress') {
    $('mine-nonce').textContent = String(m.nonce);
    $('mine-tried').textContent = String(m.tried);
    paintHash(m.hash, job.difficulty);
    const now = Date.now();
    if (now - lastProgressAt >= 500) {
      lastProgressAt = now;
      socket.emit('pool:progress', { round: m.round, tried: m.tried, hash: m.best || m.hash });
    }
  } else if (m.type === 'found') {
    const j = job;
    $('mine-nonce').textContent = String(m.nonce);
    paintHash(m.hash, j.difficulty);
    setStatus('¡Encontraste una solución! Enviando…');
    stopWorker();
    const res = await emitAck('pool:submit', { round: j.round, nonce: m.nonce });
    if (!wantMining) return;
    // pool:won arrives before this ack, so a win is already on screen: just wait for the next round.
    if (res?.ok) setStatus('Esperando el próximo bloque…');
    else setStatus(`${res?.reason || 'No se aceptó la solución'}. Esperando el próximo bloque…`);
  }
}

function onWon(w) {
  stopWorker(); // the round is over for everybody
  if (w.address === state?.address) {
    const msg = `¡Encontraste el bloque #${w.index}! +${w.reward}`;
    $('mine-win').textContent = msg;
    $('mine-win').hidden = false;
    toast(msg);
    if (currentTab !== 'minar') $('mine-dot').hidden = false;
    if (wantMining) setStatus('Esperando el próximo bloque…');
  } else if (wantMining) {
    $('mine-win').hidden = true;
    setStatus(`${w.nick} encontró el bloque #${w.index}. Esperando el próximo bloque…`);
  }
}

// ---- Socket ----
const socket = connect('wallet');
bindStatus(socket, $('status'));

socket.on('connect', () => { if (pubHex && nick) startWithKeys(); });
socket.on('state', (s) => { state = s; localNonce = null; render(); });
socket.on('tx:rejected', ({ hash, reason }) => {
  if (rejected.some((r) => r.hash === hash)) return;
  const h = (state?.history || []).find((x) => x.hash === hash);
  addRejected(hash, h?.toNick || '?', h?.amount ?? '?', reason);
});
// tx:confirmed / tx:failed are reflected by the next `state` push.
socket.on('reset', () => {
  localNonce = null; rejected.length = 0;
  stopWorker(); // the old round no longer exists; a new job arrives after re-joining
  if (pubHex && nick) startWithKeys();
});
socket.on('disconnect', () => { stopWorker(); if (wantMining) setStatus('Reconectando…'); });
socket.on('pool:job', onJob);
socket.on('pool:won', onWon);
socket.on('pool:end', ({ reason }) => {
  stopWorker();
  if (wantMining) setStatus(`${reason || 'Ronda cancelada'}. Esperando el próximo bloque…`);
});
socket.on('pool:state', (p) => applyPool(p));

// ---- Init ----
(async () => {
  if (!globalThis.crypto?.subtle) {
    const f = $('fatal');
    f.textContent = 'Se necesita HTTPS para crear la wallet';
    f.hidden = false;
    return;
  }
  const stored = loadStored();
  if (stored) {
    try {
      privateKey = await importPrivateJwk(stored.jwk);
      privJwk = stored.jwk; pubHex = stored.pub; nick = stored.nick;
      if (socket.connected) startWithKeys();   // else the 'connect' handler does it
      return;
    } catch { /* corrupt keys: fall through to onboarding */ }
  }
  showOnboarding();
})();
