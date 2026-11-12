// Basic miner: takes txs from the mempool, applies them to balances, solves proof of work.
import { MINE_INTERVAL_MS, DIFFICULTY, MAX_TXS_PER_BLOCK } from './config.js';
import { computeBlockHash } from './crypto.js';
import { state, events, getBalance } from './state.js';

let difficulty = DIFFICULTY;
let mineIntervalMs = MINE_INTERVAL_MS;
let timer = null;
let contractExecutor = () => ({ ok: false, reason: 'Contratos no disponibles todavía' });

export const getDifficulty = () => difficulty;
export const setDifficulty = (n) => { difficulty = n; };
export const getMineInterval = () => mineIntervalMs;
export function setMineInterval(ms) {
  mineIntervalMs = ms;
  if (timer) { stopMiner(); startMiner(); }
}

// fn(tx) -> { ok: true } | { ok: false, reason }. It handles its own balance moves.
export function setContractExecutor(fn) { contractExecutor = fn; }

function applyTx(tx) {
  if (tx.call) return contractExecutor(tx);
  if (getBalance(tx.from) < tx.amount) return { ok: false, reason: 'Saldo insuficiente' };
  state.balances.set(tx.from, getBalance(tx.from) - tx.amount); // Infinity - n stays Infinity
  state.balances.set(tx.to, getBalance(tx.to) + tx.amount);
  return { ok: true };
}

export function mineBlock() {
  if (state.mempool.length === 0) return null;
  const txs = state.mempool.splice(0, MAX_TXS_PER_BLOCK);
  const index = state.chain.length;
  const results = txs.map((tx) => {
    let result;
    try { result = applyTx(tx) ?? { ok: false, reason: 'Error al aplicar' }; }
    catch { result = { ok: false, reason: 'Error al aplicar' }; }
    state.nonces.set(tx.from, (state.nonces.get(tx.from) ?? 0) + 1);
    state.txStatus.set(tx.hash, result.ok
      ? { status: 'confirmed', block: index }
      : { status: 'failed', block: index, reason: result.reason });
    return result;
  });

  const block = {
    index, prevHash: state.chain[index - 1].hash, timestamp: Date.now(),
    txs, nonce: 0, difficulty,
  };
  const target = '0'.repeat(difficulty);
  while (!(block.hash = computeBlockHash(block)).startsWith(target)) block.nonce++;

  state.chain.push(block);
  txs.forEach((tx, i) => {
    if (results[i].ok) events.emit('tx:confirmed', tx, index);
    else events.emit('tx:failed', tx, index, results[i].reason);
  });
  events.emit('block:mined', block);
  events.emit('state:changed');
  return block;
}

export function startMiner() {
  if (timer) return;
  timer = setInterval(mineBlock, mineIntervalMs);
}

export function stopMiner() {
  clearInterval(timer);
  timer = null;
}

// Returns [{ index, valid, reason }] per block.
export function validateChain(chain = state.chain) {
  const out = [];
  chain.forEach((b, i) => {
    let reason = null;
    if (computeBlockHash(b) !== b.hash) reason = 'Hash no coincide';
    else if (!b.hash.startsWith('0'.repeat(b.difficulty))) reason = 'No cumple la dificultad';
    else if (i > 0) {
      if (b.prevHash !== chain[i - 1].hash) reason = 'prevHash no coincide con el bloque anterior';
      else if (!out[i - 1].valid) reason = 'Bloque anterior inválido';
    }
    out.push({ index: b.index, valid: reason === null, reason });
  });
  return out;
}
