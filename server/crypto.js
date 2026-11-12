import { createHash, createPublicKey, verify } from 'node:crypto';
import { signedPayload, txHashInput } from '../public/shared/canonical.js';

export function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

export function addressFromPubKey(pubKeyHex) {
  return '0x' + sha256Hex(pubKeyHex).slice(0, 12);
}

// raw uncompressed P-256 point (hex) -> JWK -> KeyObject. Throws on bad input.
export function pubKeyHexToKeyObject(pubKeyHex) {
  if (typeof pubKeyHex !== 'string' || !/^04[0-9a-f]{128}$/.test(pubKeyHex)) {
    throw new Error('Invalid public key');
  }
  const raw = Buffer.from(pubKeyHex, 'hex');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: raw.subarray(1, 33).toString('base64url'),
    y: raw.subarray(33, 65).toString('base64url'),
  };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

// Never throws.
export function verifyTxSignature(tx) {
  try {
    if (typeof tx.signature !== 'string' || !/^[0-9a-f]{128}$/.test(tx.signature)) return false;
    return verify(
      'sha256',
      Buffer.from(signedPayload(tx), 'utf8'),
      { key: pubKeyHexToKeyObject(tx.pubKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(tx.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

export function computeTxHash(tx) {
  return sha256Hex(txHashInput(tx));
}

// Includes amounts so tampering with an amount changes the block hash.
export function txsDigest(txs) {
  return sha256Hex(JSON.stringify(txs.map((t) => [t.hash, t.from, t.to, t.amount])));
}

export function computeBlockHash(b) {
  return sha256Hex([b.index, b.prevHash, b.timestamp, txsDigest(b.txs), b.nonce].join('|'));
}
