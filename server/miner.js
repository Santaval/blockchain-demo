// Basic miner: takes txs from the mempool, applies them to balances, solves proof of work.
import { MINE_INTERVAL_MS, DIFFICULTY, MAX_TXS_PER_BLOCK, MINE_BATCH, MINE_PAUSE_MS } from './config.js';
import { computeBlockHash } from './crypto.js';
import { state, events, getBalance } from './state.js';
import { executeTx, isContract } from './contracts/engine.js';

let difficulty = DIFFICULTY;
let mineIntervalMs = MINE_INTERVAL_MS;
let timer = null;
let contractExecutor = executeTx;

export const getDifficulty = () => difficulty;
export const setDifficulty = (n) => { difficulty = n; };
export const getMineInterval = () => mineIntervalMs;
export function setMineInterval(ms) {
  mineIntervalMs = ms;
  if (timer) { stopMiner(); startMiner(); }
}

// fn(tx, { time, block }) -> { ok: true } | { ok: false, reason }. It handles its own balance moves.
export function setContractExecutor(fn) { contractExecutor = fn; }

function applyTx(tx, env) {
  if (tx.call || isContract(tx.to)) return contractExecutor(tx, env);
  if (getBalance(tx.from) < tx.amount) return { ok: false, reason: 'Saldo insuficiente' };
  state.balances.set(tx.from, getBalance(tx.from) - tx.amount); // Infinity - n stays Infinity
  state.balances.set(tx.to, getBalance(tx.to) + tx.amount);
  return { ok: true };
}

// Step 1: pick the txs without removing them, so they stay visible while mining runs.
function selectTxs() {
  const txs = state.mempool.slice(0, MAX_TXS_PER_BLOCK);
  const index = state.chain.length;
  return {
    txs,
    block: { index, prevHash: state.chain[index - 1].hash, timestamp: Date.now(), txs, nonce: 0, difficulty },
  };
}

// Step 3: remove the txs from the mempool, apply them, push the block and announce it.
function commit(block) {
  const { txs, index } = block;
  state.mempool.splice(0, txs.length);
  const results = txs.map((tx) => {
    let result;
    try { result = applyTx(tx, { time: block.timestamp, block: index }) ?? { ok: false, reason: 'Error al aplicar' }; }
    catch { result = { ok: false, reason: 'Error al aplicar' }; }
    state.nonces.set(tx.from, (state.nonces.get(tx.from) ?? 0) + 1);
    state.txStatus.set(tx.hash, result.ok
      ? { status: 'confirmed', block: index }
      : { status: 'failed', block: index, reason: result.reason });
    return result;
  });
  state.chain.push(block);
  txs.forEach((tx, i) => {
    if (results[i].ok) events.emit('tx:confirmed', tx, index);
    else events.emit('tx:failed', tx, index, results[i].reason);
  });
  events.emit('block:mined', block);
  events.emit('state:changed');
  return block;
}

// Synchronous, instant PoW (used by tests and scripts).
export function mineBlock() {
  if (tampered || state.mempool.length === 0) return null;
  const { block } = selectTxs();
  const target = '0'.repeat(block.difficulty);
  while (!(block.hash = computeBlockHash(block)).startsWith(target)) block.nonce++;
  return commit(block);
}

let generation = 0; // bumped on reset/tamper so in-flight runs abort
let mining = false;
let tampered = false;
events.on('reset', () => { generation++; mining = false; tampered = false; });
export const isMining = () => mining;
export const isTampered = () => tampered;

// Tampering (or restoring) aborts any in-flight run: it must never commit on top of an edited chain.
export function setTampered(value) {
  tampered = value;
  generation++;
  mining = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared batched PoW: tries MINE_BATCH nonces, reports progress, pauses. Returns false if aborted.
async function powAnimated(block, gen) {
  const target = '0'.repeat(block.difficulty);
  for (;;) {
    for (let i = 0; i < MINE_BATCH; i++) {
      block.hash = computeBlockHash(block);
      if (block.hash.startsWith(target)) return true;
      block.nonce++;
    }
    events.emit('mine:progress', { index: block.index, nonce: block.nonce, hash: block.hash });
    await sleep(MINE_PAUSE_MS);
    if (gen !== generation) return false;
  }
}

// Same result as mineBlock(), but PoW runs in batches with pauses so the projector can show it.
export async function mineBlockAnimated() {
  if (mining || tampered || state.mempool.length === 0) return null;
  mining = true;
  const gen = generation;
  try {
    const { block, txs } = selectTxs();
    events.emit('mine:start', { index: block.index, difficulty: block.difficulty, txCount: txs.length });
    return (await powAnimated(block, gen)) ? commit(block) : null;
  } finally {
    if (gen === generation) mining = false;
  }
}

// Re-runs PoW on an existing block (used after tampering) with the current difficulty.
export async function remineBlock(index) {
  const old = state.chain[index];
  if (mining || !old) return null;
  mining = true;
  const gen = generation;
  try {
    const block = { ...old, nonce: 0, difficulty };
    events.emit('mine:start', { index, difficulty, txCount: old.txs.length, remine: true });
    if (!(await powAnimated(block, gen))) return null;
    Object.assign(old, { nonce: block.nonce, difficulty: block.difficulty, hash: block.hash });
    events.emit('block:remined', old);
    events.emit('state:changed');
    return old;
  } finally {
    if (gen === generation) mining = false;
  }
}

export function mineNow() {
  return isMining() ? Promise.resolve(null) : mineBlockAnimated();
}

export function startMiner() {
  if (timer) return;
  timer = setInterval(mineNow, mineIntervalMs);
}

export const isMinerRunning = () => timer !== null;

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
