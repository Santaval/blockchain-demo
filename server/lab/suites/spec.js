// Slides 4-6: spec tests. Each vector has an expected verdict and runs against the real validators in the fork.
import * as wc from '../../../public/shared/wallet-crypto.js';
import { CATALOG } from '../catalog.js';
import { state, registerWallet, getBalance, expectedNonce, createSystemTx, SYSTEM } from '../../state.js';
import { submitTx, validateTx } from '../../validator.js';
import { validateChain, setDifficulty } from '../../miner.js';
import { getContract } from '../../contracts/engine.js';
import { BANK } from '../../contracts/bank.js';
import { VOTING } from '../../contracts/voting.js';
import { AUCTION } from '../../contracts/auction.js';
import { mineAll, remineBlock, leadingZeros, uniqueNick, fmtDelta } from '../kit.js';

const META = CATALOG.find((s) => s.id === 'spec');

async function makeWallet(nick) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const res = registerWallet(uniqueNick(nick), pubKey);
  return { priv: kp.privateKey, pubKey, address: res.account.address };
}

const sign = async (w, { to, amount, nonce = expectedNonce(w.address), call, from = w.address, pubKey = w.pubKey }) =>
  wc.signTx(w.priv, await wc.buildTx({ from, to, amount, nonce, call, pubKey }));

const verdictOf = (res) => (res.ok ? 'válida' : res.reason);

export default {
  ...META,
  async run(ctx) {
    setDifficulty(1); // fork only: keeps mining instant
    const ana = await makeWallet('LAB-Ana');
    const beto = await makeWallet('LAB-Beto');
    ctx.mark({ addresses: [ana.address, beto.address] });
    mineAll(); // faucet coins
    for (const [from, to, amount] of [[ana, beto, 5], [beto, ana, 3]]) { // two blocks with real transfers
      const r = submitTx(await sign(from, { to: to.address, amount }));
      if (!r.ok) throw new Error(`No se pudo preparar el fork: ${r.reason}`);
      mineAll();
    }

    const last = state.chain.length - 1;
    const mid = last - 1;
    const copy = () => structuredClone(state.chain);
    const firstBad = (chain) => {
      const bad = validateChain(chain).find((v) => !v.valid);
      return bad ? `inválida en #${bad.index}: ${bad.reason}` : 'válida';
    };

    // Consensus vectors: edit a copy of the chain, then ask validateChain.
    const consensus = [
      ['Cadena copiada intacta', 'válida', () => firstBad(copy())],
      ['Monto alterado en un bloque', `inválida en #${mid}: Hash no coincide`, () => {
        const c = copy(); c[mid].txs[0].amount += 1000; return firstBad(c);
      }],
      ['Bloque siguiente a uno alterado', `#${mid + 1}: Bloque anterior inválido`, () => {
        const c = copy(); c[mid].txs[0].amount += 1000;
        const v = validateChain(c)[mid + 1]; return `#${v.index}: ${v.reason}`;
      }],
      ['prevHash incorrecto (re-minado)', `inválida en #${last}: prevHash no coincide con el bloque anterior`, () => {
        const c = copy(); c[last].prevHash = 'ab'.repeat(32); remineBlock(c[last]); return firstBad(c);
      }],
      ['Bloque intermedio re-minado', `inválida en #${mid + 1}: prevHash no coincide con el bloque anterior`, () => {
        const c = copy(); c[mid].txs[0].amount += 1000; remineBlock(c[mid]); return firstBad(c);
      }],
      ['Prueba de trabajo insuficiente', `inválida en #${last}: No cumple la dificultad`, () => {
        const c = copy(); c[last].difficulty = leadingZeros(c[last].hash) + 1; return firstBad(c);
      }],
      ['Hash falsificado', `inválida en #${last}: Hash no coincide`, () => {
        const c = copy(); c[last].hash = '0'.repeat(64); return firstBad(c);
      }],
      ['Transacción añadida sin re-minar', `inválida en #${last}: Hash no coincide`, () => {
        const c = copy(); c[last].txs.push(createSystemTx(SYSTEM.PRESENTADOR, 9)); return firstBad(c);
      }],
      ['Marca de tiempo alterada', `inválida en #${last}: Hash no coincide`, () => {
        const c = copy(); c[last].timestamp += 1; return firstBad(c);
      }],
      ['Nonce de minado alterado', `inválida en #${last}: Hash no coincide`, () => {
        const c = copy(); c[last].nonce += 1; return firstBad(c);
      }],
      ['Génesis alterado', 'inválida en #0: Hash no coincide', () => {
        const c = copy(); c[0].timestamp += 1; return firstBad(c);
      }],
    ];

    // Execution vectors, part 1: validateTx on signed (and then mangled) transactions.
    const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
    const validation = [
      ['Transacción válida', 'válida', async () => verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 10 })))],
      ['Firma inválida', 'Firma inválida', async () => {
        const tx = await sign(ana, { to: beto.address, amount: 10 }); tx.signature = flip(tx.signature);
        return verdictOf(validateTx(tx));
      }],
      ['Monto alterado tras firmar', 'Firma inválida', async () => {
        const tx = await sign(ana, { to: beto.address, amount: 10 }); tx.amount = 90;
        return verdictOf(validateTx(tx));
      }],
      ['Hash alterado', 'Hash no coincide', async () => {
        const tx = await sign(ana, { to: beto.address, amount: 10 }); tx.hash = flip(tx.hash);
        return verdictOf(validateTx(tx));
      }],
      ['Nonce repetido', 'Nonce incorrecto', async () => {
        const stale = expectedNonce(ana.address);
        if (!submitTx(await sign(ana, { to: beto.address, amount: 1 })).ok) return 'no se pudo preparar';
        mineAll();
        return verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 1, nonce: stale })));
      }],
      ['Nonce futuro', 'Nonce incorrecto', async () =>
        verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 1, nonce: expectedNonce(ana.address) + 5 })))],
      ['Saldo insuficiente', 'Saldo insuficiente', async () => verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 100000 })))],
      ['Monto cero', 'Monto inválido', async () => verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 0 })))],
      ['Monto negativo', 'Monto inválido', async () => verdictOf(validateTx(await sign(ana, { to: beto.address, amount: -5 })))],
      ['Monto con decimales', 'Monto inválido', async () => verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 1.5 })))],
      ['Envío a sí mismo', 'No puedes enviarte a ti mismo', async () => verdictOf(validateTx(await sign(ana, { to: ana.address, amount: 1 })))],
      ['Destinatario desconocido', 'Destinatario desconocido', async () => verdictOf(validateTx(await sign(ana, { to: '0xNOEXISTE', amount: 1 })))],
      ['Llave pública ajena', 'La dirección no corresponde a la llave pública', async () =>
        verdictOf(validateTx(await sign(beto, { to: beto.address, amount: 1, from: ana.address })))],
      ['Remitente del sistema', 'Remitente no permitido', async () =>
        verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 1, from: SYSTEM.SISTEMA })))],
      ['Llamada a una cuenta que no es contrato', 'El destinatario no es un contrato', async () =>
        verdictOf(validateTx(await sign(ana, { to: beto.address, amount: 0, call: { method: 'depositar', args: [] } })))],
      ['Transacción duplicada', 'Transacción duplicada', async () => {
        const tx = await sign(ana, { to: beto.address, amount: 1 });
        if (!submitTx(tx).ok) return 'no se pudo preparar';
        const verdict = verdictOf(validateTx(tx));
        mineAll();
        return verdict;
      }],
    ];

    // Execution vectors, part 2: mined transactions and the balances they leave behind (deltas, not absolutes).
    const names = new Map([[ana.address, 'Ana'], [beto.address, 'Beto'], [BANK, 'Banco']]);
    async function execute(from, to, amount, call, watch) {
      const before = new Map(watch.map((a) => [a, getBalance(a)]));
      const tx = await sign(from, { to, amount, call });
      const res = submitTx(tx);
      if (!res.ok) return `rechazada: ${res.reason}`;
      mineAll();
      const st = state.txStatus.get(tx.hash);
      const moves = watch.map((a) => `${names.get(a)} ${fmtDelta(getBalance(a) - before.get(a))}`).join(' · ');
      return `${st.status === 'confirmed' ? 'confirmada' : `fallida: ${st.reason}`} · ${moves}`;
    }
    const call = (method) => ({ method, args: [] });
    const execution = [
      ['Transferencia Ana → Beto', 'confirmada · Ana -30 · Beto +30', () => execute(ana, beto.address, 30, null, [ana.address, beto.address])],
      ['Depositar en el banco', 'confirmada · Ana -20 · Banco +20', () => execute(ana, BANK, 20, call('depositar'), [ana.address, BANK])],
      ['Retirar del banco', 'confirmada · Ana +20 · Banco -20', () => execute(ana, BANK, 0, call('retirar'), [ana.address, BANK])],
      ['Retirar sin depósito (revierte)', 'fallida: No tienes depósito · Ana 0 · Banco 0', () => execute(ana, BANK, 0, call('retirar'), [ana.address, BANK])],
      ['Método inexistente (revierte)', 'fallida: Método desconocido: hackear · Ana 0', () => execute(ana, BANK, 0, call('hackear'), [ana.address])],
      ['Votar con la votación cerrada', 'fallida: La votación está cerrada · Ana 0', () => {
        getContract(VOTING).storage.open = false;
        return execute(ana, VOTING, 0, { method: 'votar', args: [0] }, [ana.address]);
      }],
      ['Ofertar con la subasta cerrada', 'fallida: Subasta cerrada · Ana 0', () => {
        getContract(AUCTION).storage.open = false;
        return execute(ana, AUCTION, 5, call('ofertar'), [ana.address]);
      }],
    ];

    const vectors = [
      ...consensus.map(([name, expect, fn]) => ({ kind: 'consenso', name, expect, fn })),
      ...validation.map(([name, expect, fn]) => ({ kind: 'validación', name, expect, fn })),
      ...execution.map(([name, expect, fn]) => ({ kind: 'ejecución', name, expect, fn })),
    ];
    let passed = 0;
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      ctx.progress(`vector ${i + 1}/${vectors.length}`);
      const got = await v.fn();
      const ok = got === v.expect || (got.startsWith(v.expect) && v.expect.length > 0 && !v.expect.includes('·'));
      if (ok) passed++;
      await ctx.check(`${v.kind[0].toUpperCase()}${v.kind.slice(1)} · ${v.name}`, ok, ok ? `→ esperado ${v.expect}` : `esperado ${v.expect} · obtenido ${got}`);
    }
    ctx.summary(`${passed}/${vectors.length} vectores con el veredicto esperado`);
  },
};
