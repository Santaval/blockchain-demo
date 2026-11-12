// Socket.io sync: per-role rooms, throttled full-state broadcast, per-wallet lite state.
import { state, events, registerWallet, getBalance, availableBalance, expectedNonce, listNicks } from './state.js';
import { submitTx } from './validator.js';
import { validateChain, getDifficulty, getMineInterval, isMinerRunning, isMining, isTampered } from './miner.js';
import { registerAdminHandlers, getPanel } from './admin.js';

const ROLES = ['wallet', 'pantalla', 'admin'];
const BROADCAST_MS = 200;
const CHAIN_WINDOW = 30;
const HISTORY_LIMIT = 30;
const PROGRESS_MS = 100;

const num = (n) => (n === Infinity ? '∞' : n);
const nickOf = (addr) => state.accounts.get(addr)?.nick ?? addr;

// Status of each tx in the latest block, for the projector's network panel.
function lastBlockStatus() {
  const last = state.chain[state.chain.length - 1];
  return (last?.txs ?? []).map((t) => {
    const st = state.txStatus.get(t.hash) ?? { status: 'pending' };
    return { hash: t.hash, status: st.status, reason: st.reason };
  });
}

export function buildFullState() {
  const validity = validateChain(); // whole chain, then sliced to match the window
  return {
    chain: state.chain.slice(-CHAIN_WINDOW),
    validity: validity.slice(-CHAIN_WINDOW),
    mempool: state.mempool,
    accounts: [...state.accounts.values()].map((a) => ({ address: a.address, nick: a.nick, system: !!a.system, balance: num(getBalance(a.address)) })),
    contracts: [],
    participants: 0, // overwritten by attachSync (needs socket info)
    height: state.chain.length - 1,
    difficulty: getDifficulty(),
    mineIntervalMs: getMineInterval(),
    panel: getPanel(),
    minerRunning: isMinerRunning(),
    mining: isMining(),
    tampered: isTampered(),
    lastBlockStatus: lastBlockStatus(),
  };
}

export function buildWalletState(address) {
  const account = state.accounts.get(address);
  if (!account) return null;
  const involved = (t) => t.from === address || t.to === address;
  const txs = [...state.mempool.filter(involved)];
  for (let i = state.chain.length - 1; i >= 0 && txs.length < HISTORY_LIMIT; i--) {
    txs.push(...state.chain[i].txs.filter(involved).reverse());
  }
  const history = txs
    .map((t) => ({ t, st: state.txStatus.get(t.hash) ?? { status: 'pending' } }))
    .sort((a, b) => b.t.timestamp - a.t.timestamp)
    .slice(0, HISTORY_LIMIT)
    .map(({ t, st }) => {
      const item = {
        hash: t.hash, from: t.from, to: t.to, fromNick: nickOf(t.from), toNick: nickOf(t.to),
        amount: t.amount, timestamp: t.timestamp, status: st.status,
      };
      if (st.block !== undefined) item.block = st.block;
      if (st.reason) item.reason = st.reason;
      return item;
    });
  return {
    address, nick: account.nick,
    balance: getBalance(address), available: availableBalance(address),
    nonce: expectedNonce(address), height: state.chain.length - 1,
    history, nicks: listNicks(), contracts: [],
  };
}

export function attachSync(io) {
  const walletOf = new Map(); // socket.id -> address

  const socketsOf = (address) =>
    [...walletOf].filter(([, a]) => a === address).map(([id]) => io.sockets.sockets.get(id)).filter(Boolean);
  const notify = (addresses, event, payload) => {
    for (const addr of new Set(addresses)) socketsOf(addr).forEach((s) => s.emit(event, payload));
  };
  const sendFull = (socket) => {
    const full = buildFullState();
    full.participants = new Set(walletOf.values()).size;
    socket.emit('state:full', full);
  };
  const sendState = (socket) => {
    const data = buildWalletState(walletOf.get(socket.id));
    if (data) socket.emit('state', data);
  };

  function broadcast() {
    const full = buildFullState();
    full.participants = new Set(walletOf.values()).size;
    io.to('pantalla').to('admin').emit('state:full', full);
    for (const id of walletOf.keys()) {
      const s = io.sockets.sockets.get(id);
      if (s) sendState(s);
    }
  }

  // Single trailing timer: at most one broadcast per BROADCAST_MS, no storms.
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; broadcast(); }, BROADCAST_MS);
  };

  let progressTimer = null;
  let pendingProgress = null;

  const onEvent = {
    'state:changed': schedule,
    reset: () => {
      const ids = [...walletOf.keys()];
      walletOf.clear();
      ids.forEach((id) => io.sockets.sockets.get(id)?.emit('reset'));
      schedule();
    },
    'mempool:add': (tx) => io.to('pantalla').to('admin').emit('mempool:add', tx),
    'block:mined': (block) => {
      pendingProgress = null; // drop stale progress once the block is mined
      io.to('pantalla').to('admin').emit('block:mined', block);
    },
    'block:remined': (block) => io.to('pantalla').to('admin').emit('block:remined', block),
    'mine:start': (info) => {
      pendingProgress = null;
      io.to('pantalla').to('admin').emit('mine:start', info);
    },
    'mine:progress': (p) => {
      pendingProgress = p; // always keep the latest value
      if (progressTimer) return;
      progressTimer = setTimeout(() => {
        progressTimer = null;
        if (pendingProgress) io.to('pantalla').to('admin').emit('mine:progress', pendingProgress);
        pendingProgress = null;
      }, PROGRESS_MS);
    },
    'tx:confirmed': (tx, block) => notify([tx.from, tx.to], 'tx:confirmed', { hash: tx.hash, block }),
    'tx:failed': (tx, block, reason) => notify([tx.from, tx.to], 'tx:failed', { hash: tx.hash, block, reason }),
  };
  for (const [name, fn] of Object.entries(onEvent)) events.on(name, fn);

  io.on('connection', (socket) => {
    const role = socket.handshake.query.role;
    if (!ROLES.includes(role)) { socket.disconnect(true); return; }
    if (role !== 'admin') socket.join(role); // admin joins its room only after login
    registerAdminHandlers(socket, { sendFull });

    socket.on('register', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (role !== 'wallet') return reply({ ok: false, reason: 'Solo disponible para billeteras' });
      if (!payload || typeof payload !== 'object' || typeof payload.pubKey !== 'string') {
        return reply({ ok: false, reason: 'Datos de registro inválidos' });
      }
      const res = registerWallet(payload.nick, payload.pubKey);
      if (!res.ok) return reply(res);
      walletOf.set(socket.id, res.account.address);
      reply({ ok: true, address: res.account.address, nick: res.account.nick });
      sendState(socket);
      schedule(); // participants changed
    });

    socket.on('tx:submit', (tx, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const address = walletOf.get(socket.id);
      if (role !== 'wallet' || !address) return reply({ ok: false, reason: 'Wallet no registrada' });
      const res = submitTx(tx);
      if (res.ok) return reply({ ok: true, hash: tx.hash });
      const hash = typeof tx?.hash === 'string' ? tx.hash : null;
      reply({ ok: false, reason: res.reason });
      socket.emit('tx:rejected', { hash, reason: res.reason });
    });

    socket.on('disconnect', () => {
      if (walletOf.delete(socket.id)) schedule();
    });

    // Initial snapshot right away for late joiners; the throttled path covers the rest.
    if (role === 'pantalla') sendFull(socket);
  });

  return () => {
    for (const [name, fn] of Object.entries(onEvent)) events.off(name, fn);
    clearTimeout(timer);
    clearTimeout(progressTimer);
    timer = null;
    progressTimer = null;
  };
}
