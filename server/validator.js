// Synchronous transaction validator + mempool entry point.
// No await anywhere: concurrent submissions are serialized by the event loop.
import { addressFromPubKey, computeTxHash, verifyTxSignature } from './crypto.js';
import { state, events, SYSTEM, availableBalance, expectedNonce } from './state.js';

const SYSTEM_ADDRESSES = new Set(Object.values(SYSTEM));
const isStr = (v) => typeof v === 'string' && v.length > 0;
const fail = (reason) => ({ ok: false, reason });

export function validateTx(tx) {
  try {
    if (!tx || typeof tx !== 'object' || !isStr(tx.from) || !isStr(tx.to) || !isStr(tx.pubKey) ||
        !isStr(tx.signature) || !isStr(tx.hash) || !Number.isFinite(tx.nonce) || !Number.isFinite(tx.timestamp)) {
      return fail('Transacción mal formada');
    }
    if (tx.call !== undefined && tx.call !== null &&
        (typeof tx.call !== 'object' || typeof tx.call.method !== 'string' || !Array.isArray(tx.call.args))) {
      return fail('Transacción mal formada');
    }
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) return fail('Monto inválido');
    if (SYSTEM_ADDRESSES.has(tx.from)) return fail('Remitente no permitido');
    if (!state.accounts.has(tx.to)) return fail('Destinatario desconocido');
    if (tx.to === tx.from) return fail('No puedes enviarte a ti mismo');
    if (addressFromPubKey(tx.pubKey) !== tx.from) return fail('La dirección no corresponde a la llave pública');
    if (!verifyTxSignature(tx)) return fail('Firma inválida');
    if (computeTxHash(tx) !== tx.hash) return fail('Hash no coincide');
    if (state.txStatus.has(tx.hash)) return fail('Transacción duplicada');
    const expected = expectedNonce(tx.from);
    if (tx.nonce !== expected) return fail(`Nonce incorrecto (esperado ${expected})`);
    if (tx.amount > availableBalance(tx.from)) return fail('Saldo insuficiente');
    return { ok: true };
  } catch {
    return fail('Transacción mal formada');
  }
}

export function submitTx(tx) {
  const result = validateTx(tx);
  if (!result.ok) return result;
  state.mempool.push(tx);
  state.txStatus.set(tx.hash, { status: 'pending' });
  events.emit('mempool:add', tx);
  events.emit('state:changed');
  return result;
}
