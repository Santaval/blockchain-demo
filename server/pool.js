// Participant mining pool: phones race to solve the PoW of the next block and the winner gets a coinbase reward.
// Each miner gets its own puzzle: the coinbase (first tx, paying that miner) is part of the block digest,
// so a nonce found for one address is useless for another.
import { POOL_REWARD, POOL_HASH_RATE, POOL_MAX_DIFFICULTY, POOL_TIMEOUT_MS } from './config.js';
import { computeBlockHash, txsDigest } from './crypto.js';
import { state, events, createSystemTx } from './state.js';
import {
  getDifficulty, isTampered, getGeneration, selectTxs, commit, acquireMining, releaseMining,
  setRoundStarter, mineBlockAnimated,
} from './miner.js';

// Events emitted on the shared bus (sync.js forwards them to sockets):
//   pool:job   { address, sockets, job }          per-miner puzzle
//   pool:won   { index, address, nick, reward }   a miner found the block
//   pool:end   { reason, sockets }                round cancelled; miners stop hashing
//   pool:state { }                                difficulty changed: miners should re-read poolState

let timeoutMs = POOL_TIMEOUT_MS;
export const setPoolTimeout = (ms) => { timeoutMs = ms; };

const miners = new Map(); // address -> Set<socketId>
let round = null; // { id, index, prevHash, timestamp, txs, difficulty, gen, per, tried, best, timer }
let roundSeq = 0;
let lastMinerCount = 0; // miners leave when the pool is disabled; the ETA should still reflect the group

const nickOf = (addr) => state.accounts.get(addr)?.nick ?? addr;
const leadingZeros = (hex) => hex.length - hex.replace(/^0+/, '').length;
const allSockets = () => [...miners.values()].flatMap((set) => [...set]);

export const isMiner = (address) => miners.has(address);
export const blocksWon = (address) => state.chain.filter((b) => b.miner === address).length;

export function leaderboard() {
  const addrs = new Set([...miners.keys(), ...state.chain.map((b) => b.miner).filter(Boolean)]);
  return [...addrs]
    .filter((a) => state.accounts.has(a))
    .map((address) => ({ address, nick: nickOf(address), won: blocksWon(address), mining: miners.has(address) }))
    .sort((a, b) => b.won - a.won || a.nick.localeCompare(b.nick));
}

function humanTime(seconds) {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${Math.round(seconds / 3600)} h`;
}

export function poolState() {
  const d = getDifficulty();
  const group = Math.max(1, miners.size || lastMinerCount);
  const etaSeconds = Math.round((16 ** d / (POOL_HASH_RATE * group)) * 10) / 10;
  const enabled = d <= POOL_MAX_DIFFICULTY;
  return {
    enabled,
    reason: enabled ? null : `La dificultad subió a ${d}: el grupo tardaría ${humanTime(etaSeconds)} por bloque. Deja de minar.`,
    etaSeconds,
    miners: [...miners.keys()].map((address) => ({ address, nick: nickOf(address) })),
    round: round ? { index: round.index } : null,
  };
}

// Per-address puzzle template, created lazily (miners can join mid-round).
function templateFor(address) {
  let t = round.per.get(address);
  if (!t) {
    const coinbase = createSystemTx(address, POOL_REWARD);
    coinbase.coinbase = true; // not part of the hash
    t = { coinbase, digest: txsDigest([coinbase, ...round.txs]) };
    round.per.set(address, t);
  }
  return t;
}

function jobFor(address) {
  const t = templateFor(address);
  return {
    round: round.id, index: round.index, difficulty: round.difficulty,
    prefix: `${round.index}|${round.prevHash}|${round.timestamp}|${t.digest}|`,
    rate: POOL_HASH_RATE, reward: POOL_REWARD,
  };
}

function sendJob(address) {
  events.emit('pool:job', { address, sockets: [...(miners.get(address) ?? [])], job: jobFor(address) });
}

// Drops the round and its timer. `release` gives back the shared mining flag.
function closeRound(release) {
  if (!round) return null;
  clearTimeout(round.timer);
  const r = round;
  round = null;
  if (release) releaseMining(r.gen);
  return r;
}

// The round failed (timeout, everybody left, difficulty too high): the server mines the same txs, no reward.
function fallback(reason) {
  if (!closeRound(true)) return;
  events.emit('pool:end', { reason, sockets: allSockets() });
  mineBlockAnimated().catch(() => {});
}

// Reset or tamper: the shared generation already moved on, so just forget the round.
function abort(notify) {
  if (!closeRound(false)) return;
  if (notify) events.emit('pool:end', { reason: 'Ronda cancelada', sockets: allSockets() });
}

export function canRun() {
  return miners.size > 0 && getDifficulty() <= POOL_MAX_DIFFICULTY && !isTampered() && state.mempool.length > 0;
}

// Returns true if a round started (it holds the shared mining flag until it ends).
export function startRound() {
  if (round || !canRun()) return false;
  const gen = acquireMining();
  if (gen === null) return false;
  const { txs, block } = selectTxs();
  round = {
    id: ++roundSeq, index: block.index, prevHash: block.prevHash, timestamp: block.timestamp, txs,
    difficulty: block.difficulty, gen, per: new Map(), tried: new Map(), best: null, timer: null,
  };
  round.timer = setTimeout(() => {
    if (round && round.gen === getGeneration()) fallback('Nadie encontró el bloque a tiempo');
  }, timeoutMs);
  round.timer.unref();
  events.emit('mine:start', { index: round.index, difficulty: round.difficulty, txCount: txs.length, pool: true, miners: miners.size });
  for (const address of miners.keys()) sendJob(address);
  return true;
}
setRoundStarter(startRound);

export function join(address, socketId) {
  const st = poolState();
  if (!st.enabled) return { ok: false, reason: st.reason };
  if (!state.accounts.has(address)) return { ok: false, reason: 'Wallet no registrada' };
  const isNew = !miners.has(address);
  if (isNew) miners.set(address, new Set());
  miners.get(address).add(socketId);
  lastMinerCount = miners.size;
  if (round) sendJob(address);
  events.emit('state:changed');
  return { ok: true, rate: POOL_HASH_RATE, reward: POOL_REWARD };
}

function removeSocket(address, socketId) {
  const set = miners.get(address);
  if (!set || !set.delete(socketId)) return;
  if (set.size === 0) miners.delete(address);
  if (round && miners.size === 0) fallback('Todos los mineros salieron');
  events.emit('state:changed');
}

export function leave(address, socketId) { removeSocket(address, socketId); }

export function leaveSocket(socketId) {
  for (const address of [...miners.keys()]) removeSocket(address, socketId);
}

export function submit(address, payload) {
  if (!round || round.gen !== getGeneration() || payload?.round !== round.id) return { ok: false, reason: 'Llegaste tarde' };
  if (!miners.has(address)) return { ok: false, reason: 'No estás minando' };
  const { nonce } = payload;
  if (!Number.isSafeInteger(nonce) || nonce < 0) return { ok: false, reason: 'Solución inválida' };
  const { coinbase } = templateFor(address);
  const block = {
    index: round.index, prevHash: round.prevHash, timestamp: round.timestamp,
    txs: [coinbase, ...round.txs], nonce, difficulty: round.difficulty,
  };
  block.hash = computeBlockHash(block);
  if (!block.hash.startsWith('0'.repeat(round.difficulty))) return { ok: false, reason: 'Solución inválida' };
  block.miner = address;
  const r = closeRound(true);
  commit(block, r.txs.length);
  events.emit('pool:won', { index: block.index, address, nick: nickOf(address), reward: POOL_REWARD });
  return { ok: true };
}

// `tried` is the miner's cumulative attempts in this round; `hash` its best/latest hash.
export function progress(address, payload) {
  if (!round || payload?.round !== round.id || !miners.has(address)) return;
  const { tried, hash } = payload;
  if (!Number.isFinite(tried) || tried < 0) return;
  round.tried.set(address, Math.floor(tried));
  if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && (!round.best || leadingZeros(hash) > leadingZeros(round.best))) {
    round.best = hash;
  }
  let total = 0;
  for (const n of round.tried.values()) total += n;
  events.emit('mine:progress', { index: round.index, nonce: total, hash: round.best ?? '' });
}

events.on('reset', () => { miners.clear(); lastMinerCount = 0; abort(false); });
events.on('mining:aborted', () => abort(true));
events.on('difficulty:changed', () => {
  if (round && getDifficulty() > POOL_MAX_DIFFICULTY) fallback('La dificultad subió');
  events.emit('pool:state');
});
