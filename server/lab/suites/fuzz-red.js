// Slide 8: network fuzzing. A real http + socket.io server (the same attachSync as production) runs inside the
// fork on a random port and receives seeded garbage. It must keep answering, never crash and never accept
// anything it should reject.
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import * as wc from '../../../public/shared/wallet-crypto.js';
import { CATALOG } from '../catalog.js';
import { state, SYSTEM, expectedNonce } from '../../state.js';
import { validateChain, setDifficulty } from '../../miner.js';
import { addressFromPubKey, computeTxHash, verifyTxSignature } from '../../crypto.js';
import { mineAll, sleep, uniqueNick } from '../kit.js';

const META = CATALOG.find((s) => s.id === 'fuzz-red');
const TOTAL = 300;
const CONTROL_EVERY = 30;
const SYSTEM_ADDRESSES = new Set(Object.values(SYSTEM));

const EVENTS = [
  'register', 'register', 'tx:submit', 'tx:submit', 'tx:submit', 'pool:join', 'pool:leave', 'pool:submit', 'pool:progress',
  'admin:login', 'admin:panel', 'admin:reset', 'admin:miner', 'admin:difficulty', 'admin:interval', 'admin:gift',
  'admin:tamper', 'admin:remine', 'admin:restore', 'admin:attack', 'admin:attack-enabled', 'admin:bank-seed',
  'admin:voting-config', 'admin:voting-open', 'admin:auction-open', 'admin:lab-run', 'admin:lab-clear',
  'admin:__proto__', 'admin:', 'nope', 'constructor', '__proto__', 'x'.repeat(300), 'state:full', 'disconnect',
];

// Mirrors the checks validateTx does, for txs that already sit in the mempool.
function txSane(tx) {
  if (SYSTEM_ADDRESSES.has(tx.from)) return false; // system txs never come over the network
  return addressFromPubKey(tx.pubKey) === tx.from && verifyTxSignature(tx) && computeTxHash(tx) === tx.hash &&
    Number.isInteger(tx.amount) && tx.amount >= (tx.call ? 0 : 1) && tx.from !== tx.to;
}

const flipChar = (hex) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);

export default {
  ...META,
  async run(ctx) {
    const { rng } = ctx;
    setDifficulty(1);
    const { attachSync } = await import('../../sync.js'); // lazy: sync.js reaches admin.js and the lab controller

    let crashes = 0;
    const onCrash = () => { crashes++; };
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);

    const httpServer = http.createServer();
    const io = new Server(httpServer);
    const detach = attachSync(io);
    const clients = [];
    try {
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${httpServer.address().port}`;
      const connect = async (role) => {
        const c = ioc(url, { query: { role }, forceNew: true, reconnection: false });
        clients.push(c);
        await new Promise((resolve) => { c.once('connect', resolve); setTimeout(resolve, 3000); });
        return c;
      };
      const ask = (c, event, payload, ms = 2000) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        c.emit(event, payload, (res) => { clearTimeout(t); resolve(res ?? null); });
      });

      const [walletA, walletB, screen, adminAnon] = await Promise.all(['wallet', 'wallet', 'pantalla', 'admin'].map(connect));

      // Two real wallets so valid (and mutated) transactions have somewhere to go.
      const keys = [];
      for (const [socket, nick] of [[walletA, 'LAB-Fuzz'], [walletB, 'LAB-Peer']]) {
        const kp = await wc.generateKeyPair();
        const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
        const res = await ask(socket, 'register', { nick: uniqueNick(nick), pubKey });
        if (!res?.ok) throw new Error(`No se pudo registrar la billetera de prueba: ${res?.reason ?? 'sin respuesta'}`);
        keys.push({ priv: kp.privateKey, pubKey, address: res.address });
      }
      ctx.mark({ addresses: keys.map((k) => k.address) });
      mineAll();
      await sleep(50);
      const [fuzzer, peer] = keys;
      const height0 = state.chain.length;

      const signed = async (over = {}) => wc.signTx(fuzzer.priv, await wc.buildTx({
        from: fuzzer.address, to: peer.address, amount: 1, nonce: expectedNonce(fuzzer.address), pubKey: fuzzer.pubKey, ...over,
      }));
      // Every mutation here breaks the signature or a rule, so ok:true on any of them is a bug.
      const mutations = [
        (tx) => { tx.signature = flipChar(tx.signature); },
        (tx) => { tx.hash = flipChar(tx.hash); },
        (tx) => { tx.amount = -5; },
        (tx) => { tx.amount = 0; },
        (tx) => { tx.amount = 1.5; },
        (tx) => { tx.amount = '5'; },
        (tx) => { tx.amount = 1e308; },
        (tx) => { tx.amount = null; },
        (tx) => { tx.nonce += 1; },
        (tx) => { tx.to = fuzzer.address; },
        (tx) => { tx.to = '0xNOEXISTE'; },
        (tx) => { tx.from = SYSTEM.SISTEMA; },
        (tx) => { delete tx.pubKey; },
        (tx) => { tx.call = { method: 'depositar', args: [] }; },
        (tx) => { tx.call = { method: 'x', args: ['y'.repeat(2000)] }; },
        (tx) => { tx.timestamp = 'ayer'; },
      ];

      const deep = (n) => (n === 0 ? 'fin' : { a: [deep(n - 1)] });
      const junk = () => rng.pick([
        null, undefined, 0, -1, 1.5, NaN, Infinity, true, '', 'x'.repeat(rng.int(1, 4000)), [], [1, [2, [3]]], {},
        deep(rng.int(5, 60)), JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: { prototype: { polluted: 1 } } },
        { nick: {}, pubKey: [] }, { nick: 'x'.repeat(5000), pubKey: '04' + 'ab'.repeat(64) }, { suite: ['all'], seed: {} },
        { password: 12345 }, { amount: 1e309 }, { tx: { from: 1 } }, 'admin', [null, null],
      ]);

      let sent = 0;
      let accepted = 0; // accepted when it must have been rejected
      let adminTried = 0;
      let adminAccepted = 0;
      let validSent = 0;
      let controlsOk = 0;
      let controlsTotal = 0;

      const ackFor = (event, mustReject) => (res) => {
        if (res?.ok !== true) return;
        if (event.startsWith('admin:')) { adminAccepted++; accepted++; } else if (mustReject) accepted++;
      };

      for (let i = 1; i <= TOTAL; i++) {
        const roll = rng.next();
        if (roll < 0.25) { // tx:submit with a mutated (always invalid) transaction
          const tx = await signed();
          rng.pick(mutations)(tx);
          walletA.emit('tx:submit', tx, ackFor('tx:submit', true));
        } else if (roll < 0.30 && validSent < 3) { // a few legitimate transactions must still work
          validSent++;
          walletA.emit('tx:submit', await signed(), () => {});
        } else {
          const event = rng.pick(EVENTS);
          const socket = event.startsWith('admin:') ? rng.pick([adminAnon, walletA, walletB, screen]) : rng.pick([walletA, walletB, screen, adminAnon]);
          if (event.startsWith('admin:')) adminTried++;
          const payload = junk();
          const useAck = event.startsWith('admin:') || rng.chance(0.5);
          const mustReject = event === 'register' || event === 'tx:submit' || event.startsWith('pool:submit');
          try {
            if (useAck) socket.emit(event, payload, ackFor(event, mustReject && event !== 'register'));
            else socket.emit(event, payload);
          } catch { /* the client refused to serialize it: not a server problem */ }
        }
        sent++;
        ctx.progress(`mensaje ${i}/${TOTAL}`);
        if (i % 10 === 0) { await sleep(3); await ctx.pace(60); }
        if (i % CONTROL_EVERY === 0) {
          controlsTotal++;
          const res = await ask(walletA, 'pool:leave', {});
          const ok = res?.ok === true;
          if (ok) controlsOk++;
          await ctx.check(`Control de vida tras ${i} mensajes`, ok, ok ? 'el servidor sigue respondiendo' : 'sin respuesta');
        }
      }
      await sleep(300);

      await ctx.check('Sin excepciones no capturadas', crashes === 0, `${crashes} caídas en ${sent} mensajes`);
      await ctx.check('Mensajes admin:* sin autenticar', adminAccepted === 0,
        `${adminTried} intentos · ${adminAccepted} aceptados (deben ser 0)`);
      await ctx.check('Transacciones mutadas', accepted === adminAccepted, `${accepted - adminAccepted} aceptadas indebidamente (deben ser 0)`);
      const pending = state.mempool.filter((tx) => !txSane(tx));
      await ctx.check('Mempool solo con transacciones válidas', pending.length === 0,
        `${state.mempool.length} en el mempool · ${pending.length} inválidas`);
      mineAll();
      const broken = validateChain().find((v) => !v.valid);
      await ctx.check('La cadena sigue válida', !broken && state.chain.length >= height0,
        broken ? `inválida desde #${broken.index}: ${broken.reason}` : `${state.chain.length} bloques, todos válidos`);
      await ctx.check('Las cuentas siguen ahí', state.accounts.has(fuzzer.address) && state.accounts.has(peer.address),
        'ningún mensaje borró ni reinició la copia');
      ctx.summary(`${sent} mensajes · ${crashes} caídas · ${accepted} aceptados indebidamente`);
    } finally {
      clients.forEach((c) => c.close());
      detach();
      await io.close();
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
    }
  },
};
