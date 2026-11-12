// Helpers shared by the suites. They only touch the state of the process they run in (the fork inside the worker).
import '../contracts/index.js';
import { state, events, addAccount, createSystemTx, getBalance } from '../state.js';
import { mineBlock } from '../miner.js';
import { computeBlockHash } from '../crypto.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pushes a tx into the mempool (like the admin helpers do).
export function queue(tx) {
  state.mempool.push(tx);
  state.txStatus.set(tx.hash, { status: 'pending' });
  events.emit('mempool:add', tx);
  return tx;
}

// Mines until the mempool is empty (difficulty is expected to be low in the fork).
export function mineAll() {
  let blocks = 0;
  while (state.mempool.length > 0) {
    if (!mineBlock()) break;
    blocks++;
  }
  return blocks;
}

// Redoes the proof of work of a (possibly edited) block with its own difficulty.
export function remineBlock(block) {
  const target = '0'.repeat(block.difficulty);
  block.nonce = 0;
  while (!(block.hash = computeBlockHash(block)).startsWith(target)) block.nonce++;
  return block;
}

export const leadingZeros = (hex) => hex.length - hex.replace(/^0+/, '').length;

export function uniqueNick(base) {
  let nick = base;
  for (let n = 2; state.nickIndex.has(nick.toLowerCase()); n++) nick = `${base}${n}`;
  return nick;
}

// Fork-only account with an address that cannot belong to a real participant (0xFORK + 6 hex chars).
export function forkAccount(rng, nick, balance = 0) {
  let address;
  do address = '0xFORK' + rng.hex(6); while (state.accounts.has(address));
  addAccount({ address, nick: uniqueNick(`FORK-${nick}`), pubKey: '' }, 0);
  if (balance > 0) queue(createSystemTx(address, balance));
  return address;
}

export const fmtDelta = (n) => (n > 0 ? `+${n}` : String(n));
export const balanceOf = getBalance;
