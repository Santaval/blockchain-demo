// Block tampering for the demo: edit a tx amount, re-mine the block, restore the original chain.
import { state, events } from './state.js';
import { stopMiner, startMiner, isMinerRunning, isMining, isTampered, setTampered, remineBlock } from './miner.js';

let backup = null;
let wasRunning = false;
events.on('reset', () => { backup = null; wasRunning = false; });

const isIdx = (v, max) => Number.isInteger(v) && v >= 0 && v < max;
const fail = (reason) => ({ ok: false, reason });

export function tamper({ block, tx, amount }) {
  if (!Number.isInteger(block) || block < 1 || block >= state.chain.length) return fail('Bloque inválido');
  const target = state.chain[block];
  if (!isIdx(tx, target.txs.length)) return fail('Transacción inválida');
  if (!Number.isInteger(amount) || amount <= 0) return fail('El monto debe ser un entero positivo');
  if (!isTampered()) {
    backup = structuredClone(state.chain);
    wasRunning = isMinerRunning();
    stopMiner();
    setTampered(true); // aborts any in-flight mining run
  }
  target.txs[tx].amount = amount; // balances stay untouched: only the hashes break
  events.emit('state:changed');
  return { ok: true };
}

export function remine({ block }) {
  if (!isTampered()) return fail('Primero manipula la cadena');
  if (!Number.isInteger(block) || block < 1 || block >= state.chain.length) return fail('Bloque inválido');
  if (isMining()) return fail('Ya se está minando un bloque');
  remineBlock(block);
  return { ok: true };
}

export function restore() {
  if (!isTampered()) return fail('La cadena no está manipulada');
  state.chain = backup;
  backup = null;
  setTampered(false); // also aborts a running re-mine
  if (wasRunning) startMiner();
  events.emit('state:changed');
  return { ok: true };
}
