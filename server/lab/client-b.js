// "Client B": an independent block validator. It deliberately imports neither server/crypto.js nor
// miner.validateChain; it only uses the browser-side SHA-256 (public/shared/sha256.js) and its own code.
// Same consensus rules and the same verdict texts as client A, so verdicts can be compared per block.
import { sha256Hex } from '../../public/shared/sha256.js';

const digestOfTxs = (txs) => sha256Hex(JSON.stringify(txs.map((t) => [t.hash, t.from, t.to, t.amount])));
const headerHash = (b) => sha256Hex(`${b.index}|${b.prevHash}|${b.timestamp}|${digestOfTxs(b.txs)}|${b.nonce}`);

function judge(block, previous, previousOk) {
  if (headerHash(block) !== block.hash) return 'Hash no coincide';
  if (!block.hash.startsWith('0'.repeat(block.difficulty))) return 'No cumple la dificultad';
  if (previous) {
    if (block.prevHash !== previous.hash) return 'prevHash no coincide con el bloque anterior';
    if (!previousOk) return 'Bloque anterior inválido';
  }
  return null;
}

// Returns [{ index, valid, reason }] per block.
export function validateChainB(chain) {
  const verdicts = [];
  let previousOk = true;
  for (let i = 0; i < chain.length; i++) {
    const reason = judge(chain[i], i > 0 ? chain[i - 1] : null, previousOk);
    previousOk = reason === null;
    verdicts.push({ index: chain[i].index, valid: previousOk, reason });
  }
  return verdicts;
}
