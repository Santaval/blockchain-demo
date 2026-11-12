// Pure helpers shared by browser and server (no DOM, no Node APIs).

// Content that gets signed: identical on client and server.
export function signedPayload(tx) {
  return JSON.stringify([
    tx.from, tx.to, tx.amount, tx.nonce, tx.timestamp,
    tx.call?.method ?? null, tx.call?.args ?? null,
  ]);
}

// Input of the tx hash: signed content + signature.
export function txHashInput(tx) {
  return signedPayload(tx) + '|' + tx.signature;
}

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('Invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
