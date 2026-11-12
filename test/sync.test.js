import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import * as wc from '../public/shared/wallet-crypto.js';
import { reset } from '../server/state.js';
import { mineBlock } from '../server/miner.js';
import { attachSync } from '../server/sync.js';

let httpServer, io, detach, url;
const clients = [];

before(async () => {
  reset();
  httpServer = http.createServer();
  io = new Server(httpServer);
  detach = attachSync(io);
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://localhost:${httpServer.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  detach();
  await io.close();
});

function client(role) {
  const c = ioc(url, { query: { role }, forceNew: true });
  clients.push(c);
  return c;
}
const once = (c, ev) => new Promise((r) => c.once(ev, r));
const emit = (c, ev, data) => new Promise((r) => c.emit(ev, data, r));

async function wallet(nick) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const c = client('wallet');
  return { c, kp, pubKey, nick };
}
const sign = async (w, to, amount, nonce) =>
  wc.signTx(w.kp.privateKey, await wc.buildTx({ to, amount, nonce, pubKey: w.pubKey }));

test('sync flow', async () => {
  const pantalla = client('pantalla');
  const first = await once(pantalla, 'state:full');
  assert.equal(first.height, 0);

  const alice = await wallet('Alice');
  const bob = await wallet('Bob');
  const aliceState = once(alice.c, 'state');
  const pantallaAdd = once(pantalla, 'mempool:add');
  const ra = await emit(alice.c, 'register', { nick: 'Alice', pubKey: alice.pubKey });
  assert.equal(ra.ok, true);
  const st = await aliceState;
  assert.equal(st.address, ra.address);
  assert.equal(st.history[0].status, 'pending');
  assert.equal(st.history[0].fromNick, 'Sistema');
  assert.equal((await pantallaAdd).to, ra.address);
  const rb = await emit(bob.c, 'register', { nick: 'Bob', pubKey: bob.pubKey });

  // re-register same key => same address
  const again = await emit(alice.c, 'register', { nick: 'Other', pubKey: alice.pubKey });
  assert.deepEqual(again, ra);

  // full state after throttle: participants counted
  let full;
  do { full = await once(pantalla, 'state:full'); } while (full.participants !== 2);
  assert.equal(full.accounts.find((a) => a.address === '0xSISTEMA').balance, '∞');
  assert.equal(full.validity.length, full.chain.length);

  mineBlock(); // faucets
  await once(alice.c, 'tx:confirmed');

  // bad tx
  const bad = await sign(alice, rb.address, 10_000, 0);
  const rejected = once(alice.c, 'tx:rejected');
  const nack = await emit(alice.c, 'tx:submit', bad);
  assert.equal(nack.ok, false);
  assert.equal((await rejected).reason, nack.reason);
  assert.equal((await emit(alice.c, 'tx:submit', null)).ok, false);

  // good tx
  const good = await sign(alice, rb.address, 10, 0);
  const ack = await emit(alice.c, 'tx:submit', good);
  assert.deepEqual(ack, { ok: true, hash: good.hash });
  const conf = once(bob.c, 'tx:confirmed');
  const bobState = new Promise((res) => bob.c.on('state', (s) => s.balance === 110 && res(s)));
  mineBlock();
  assert.deepEqual(await conf, { hash: good.hash, block: 2 });
  const bs = await bobState;
  assert.equal(bs.history[0].status, 'confirmed');
  assert.equal(bs.history[0].fromNick, 'Alice');
});
