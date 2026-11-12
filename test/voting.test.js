import './helpers/no-mine-pause.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { state, reset, registerWallet, getBalance } from '../server/state.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, setDifficulty } from '../server/miner.js';
import { getContract, getLogs, contractsViewFor } from '../server/contracts/engine.js';
import '../server/contracts/index.js';
import { configureVoting, setVotingOpen, VOTING } from '../server/contracts/voting.js';

setDifficulty(2);

async function makeWallet(nick, balance = 100) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  state.balances.set(account.address, balance);
  state.mempool.length = 0;
  return { priv: kp.privateKey, pubKey, address: account.address, nonce: 0 };
}

async function vote(w, option, amount = 0) {
  const partial = await wc.buildTx({ from: w.address, to: VOTING, amount, nonce: w.nonce, call: { method: 'votar', args: [option] }, pubKey: w.pubKey });
  const tx = await wc.signTx(w.priv, partial);
  const res = submitTx(tx);
  assert.equal(res.ok, true, res.reason);
  w.nonce++;
  return tx;
}

const S = () => getContract(VOTING).storage;
const status = (tx) => state.txStatus.get(tx.hash);
let ana, beto;

beforeEach(async () => {
  reset();
  ana = await makeWallet('Ana');
  beto = await makeWallet('Beto');
  assert.deepEqual(configureVoting({ question: '¿Mejor lenguaje?', options: ['JS', 'Rust', 'Go'] }), { ok: true });
  assert.deepEqual(setVotingOpen(true), { ok: true });
});

test('a vote is counted at mining, with a log and public view', async () => {
  const tx = await vote(ana, 1);
  assert.equal(S().votes.length, 0);
  mineBlock();
  assert.equal(status(tx).status, 'confirmed');
  assert.deepEqual(S().votes, [{ address: ana.address, nick: 'Ana', option: 1 }]);
  assert.equal(getLogs().at(-1).message, 'Ana votó por Rust');
  const c = contractsViewFor(ana.address).find((x) => x.address === VOTING);
  assert.deepEqual(c.view.counts, [0, 1, 0]);
  assert.equal(c.me.myVote, 1);
  assert.equal(contractsViewFor(beto.address).find((x) => x.address === VOTING).me.myVote, null);
});

test('double vote fails with "Ya votaste"', async () => {
  await vote(ana, 0);
  mineBlock();
  const tx = await vote(ana, 2);
  mineBlock();
  assert.equal(status(tx).reason, 'Ya votaste');
  assert.equal(S().votes.length, 1);
});

test('closed voting and invalid options fail', async () => {
  const bad = await vote(ana, 7);
  mineBlock();
  assert.equal(status(bad).reason, 'Opción inválida');
  setVotingOpen(false);
  const closed = await vote(beto, 0);
  mineBlock();
  assert.equal(status(closed).reason, 'La votación está cerrada');
  assert.equal(S().votes.length, 0);
});

test('attached coins fail and are refunded by the revert', async () => {
  const tx = await vote(ana, 0, 5);
  mineBlock();
  assert.equal(status(tx).reason, 'La votación no acepta monedas');
  assert.equal(getBalance(ana.address), 100);
  assert.equal(getBalance(VOTING), 0);
  assert.equal(S().votes.length, 0);
});

test('admin config validation; config is refused while open and clears votes', async () => {
  assert.equal(configureVoting({ question: 'x', options: ['a', 'b'] }).ok, false); // open
  setVotingOpen(false);
  assert.equal(configureVoting({ question: '', options: ['a', 'b'] }).ok, false);
  assert.equal(configureVoting({ question: 'x', options: ['a'] }).ok, false);
  assert.equal(configureVoting({ question: 'x', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok, false);
  assert.equal(configureVoting({ question: 'x', options: ['a', ''] }).ok, false);
  assert.equal(configureVoting({ question: 'x', options: ['a', 'y'.repeat(41)] }).ok, false);
  assert.equal(configureVoting({ question: 'q'.repeat(121), options: ['a', 'b'] }).ok, false);
  setVotingOpen(true);
  await vote(ana, 0);
  mineBlock();
  setVotingOpen(false);
  assert.equal(S().votes.length, 1);
  assert.equal(configureVoting({ question: 'Nueva', options: ['a', 'b'] }).ok, true);
  assert.equal(S().votes.length, 0);
});

test('reset gives the voting contract fresh storage', () => {
  reset();
  assert.deepEqual(S(), { question: '', options: [], open: false, votes: [] });
  assert.equal(state.accounts.get(VOTING).contract, true);
});
