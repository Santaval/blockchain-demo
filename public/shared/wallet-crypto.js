// Browser-side crypto (Web Crypto). Also runs in Node 20+ via globalThis.crypto.
import { signedPayload, txHashInput, bytesToHex, hexToBytes } from './canonical.js';

const ALGO = { name: 'ECDSA', namedCurve: 'P-256' };
const enc = new TextEncoder();

export async function sha256HexAsync(str) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(str));
  return bytesToHex(new Uint8Array(digest));
}

export async function addressFromPubKeyHex(hex) {
  return '0x' + (await sha256HexAsync(hex)).slice(0, 12);
}

export function generateKeyPair() {
  return globalThis.crypto.subtle.generateKey(ALGO, true, ['sign', 'verify']);
}

// Lowercase hex of the raw (uncompressed, 65 bytes, starts with 04) public key.
export async function exportPublicKeyHex(publicKey) {
  const raw = await globalThis.crypto.subtle.exportKey('raw', publicKey);
  return bytesToHex(new Uint8Array(raw));
}

export function exportPrivateJwk(privateKey) {
  return globalThis.crypto.subtle.exportKey('jwk', privateKey);
}

export function importPrivateJwk(jwk) {
  return globalThis.crypto.subtle.importKey('jwk', jwk, ALGO, true, ['sign']);
}

// Builds an unsigned tx (timestamp = now). `from` is derived from pubKey.
export async function buildTx({ from, to, amount, nonce, call, pubKey }) {
  const tx = { from: from ?? await addressFromPubKeyHex(pubKey), to, amount, nonce, timestamp: Date.now() };
  if (call) tx.call = call;
  tx.pubKey = pubKey;
  return tx;
}

// Fills signature (hex, IEEE P1363 r||s) and hash; returns the full Tx.
export async function signTx(privateKey, partialTx) {
  const tx = { ...partialTx };
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(signedPayload(tx)));
  tx.signature = bytesToHex(new Uint8Array(sig));
  tx.hash = await sha256HexAsync(txHashInput(tx));
  return tx;
}

export { hexToBytes };
