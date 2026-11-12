// In-memory state singleton. `state` is mutated in place by reset() so importers keep the reference.
import { EventEmitter } from 'node:events';
import { DIFFICULTY, FAUCET_AMOUNT } from './config.js';
import { addressFromPubKey, computeBlockHash, computeTxHash, pubKeyHexToKeyObject } from './crypto.js';

export const events = new EventEmitter();

export const SYSTEM = {
  SISTEMA: '0xSISTEMA',
  PRESENTADOR: '0xPRESENTADOR',
  HACKER: '0xHACKER',
};

export const state = {
  chain: [],
  mempool: [],
  balances: new Map(),
  nonces: new Map(),
  accounts: new Map(),
  nickIndex: new Map(),
  txStatus: new Map(),
};

export function addAccount(account, balance) {
  state.accounts.set(account.address, account);
  state.nickIndex.set(account.nick.toLowerCase(), account.address);
  state.balances.set(account.address, balance);
  state.nonces.set(account.address, 0);
}

function createGenesis() {
  const block = { index: 0, prevHash: '0'.repeat(64), timestamp: Date.now(), txs: [], nonce: 0, difficulty: DIFFICULTY };
  const target = '0'.repeat(DIFFICULTY);
  while (!(block.hash = computeBlockHash(block)).startsWith(target)) block.nonce++;
  return block;
}

export function reset() {
  state.chain = [createGenesis()];
  state.mempool = [];
  state.balances.clear();
  state.nonces.clear();
  state.accounts.clear();
  state.nickIndex.clear();
  state.txStatus.clear();
  addAccount({ address: SYSTEM.SISTEMA, nick: 'Sistema', pubKey: '', system: true }, Infinity);
  addAccount({ address: SYSTEM.PRESENTADOR, nick: 'Presentador', pubKey: '', system: true }, 0);
  addAccount({ address: SYSTEM.HACKER, nick: 'Hacker', pubKey: '', system: true }, 0);
  events.emit('reset');
}

// Full deep copy of the ledger (Maps and Infinity survive structured clone). Used to fork the node in the lab.
export function exportSnapshot() {
  const { chain, mempool, balances, nonces, accounts, nickIndex, txStatus } = state;
  return structuredClone({ chain, mempool, balances, nonces, accounts, nickIndex, txStatus });
}

// Replaces the ledger with a copy of `snap`. Emits nothing (no 'reset'), so contract storage stays as it is.
export function importSnapshot(snap) {
  const copy = structuredClone(snap);
  state.chain = copy.chain;
  state.mempool = copy.mempool;
  for (const key of ['balances', 'nonces', 'accounts', 'nickIndex', 'txStatus']) {
    state[key].clear();
    for (const [k, v] of copy[key]) state[key].set(k, v);
  }
}

export const getBalance = (addr) => state.balances.get(addr) ?? 0;

export const pendingOutgoing = (addr) =>
  state.mempool.filter((t) => t.from === addr).reduce((sum, t) => sum + t.amount, 0);

export const availableBalance = (addr) => getBalance(addr) - pendingOutgoing(addr);

export const expectedNonce = (addr) =>
  (state.nonces.get(addr) ?? 0) + state.mempool.filter((t) => t.from === addr).length;

export const findByNick = (nick) => {
  const addr = state.nickIndex.get(String(nick).trim().toLowerCase());
  return addr ? state.accounts.get(addr) : undefined;
};

export const listNicks = () =>
  [...state.accounts.values()].filter((a) => !a.system).map((a) => ({ nick: a.nick, address: a.address }));

// System tx: never goes through the validator.
export function createSystemTx(to, amount, { from = SYSTEM.SISTEMA, call } = {}) {
  const tx = {
    from, to, amount,
    nonce: expectedNonce(from),
    timestamp: Date.now(),
    pubKey: '', signature: 'SISTEMA',
  };
  if (call) tx.call = call;
  tx.hash = computeTxHash(tx);
  return tx;
}

export function registerWallet(nick, pubKey) {
  try {
    pubKeyHexToKeyObject(pubKey);
  } catch {
    return { ok: false, reason: 'Llave pública inválida' };
  }
  const address = addressFromPubKey(pubKey);
  const existing = state.accounts.get(address);
  if (existing) return { ok: true, account: existing, isNew: false };

  const clean = String(nick ?? '').trim();
  if (clean.length < 1 || clean.length > 20) return { ok: false, reason: 'El apodo debe tener entre 1 y 20 caracteres' };
  if (state.nickIndex.has(clean.toLowerCase())) return { ok: false, reason: 'Ese apodo ya está en uso' };

  const account = { address, nick: clean, pubKey };
  addAccount(account, 0);

  const tx = createSystemTx(address, FAUCET_AMOUNT);
  state.mempool.push(tx);
  state.txStatus.set(tx.hash, { status: 'pending' });
  events.emit('mempool:add', tx);
  events.emit('state:changed');
  return { ok: true, account, isNew: true };
}

reset();
