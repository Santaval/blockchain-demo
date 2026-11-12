// Slide 7: multi-client compatibility. Client B (an independent implementation) must reach the same
// verdict, with the same reason, as client A (validateChain) on every block, valid chain or not.
import { CATALOG } from '../catalog.js';
import { state, createSystemTx, SYSTEM } from '../../state.js';
import { validateChain, setDifficulty } from '../../miner.js';
import { validateChainB } from '../client-b.js';
import { mineAll, queue, remineBlock, leadingZeros } from '../kit.js';

const META = CATALOG.find((s) => s.id === 'multicliente');

const firstBad = (verdicts) => verdicts.find((v) => !v.valid) ?? null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default {
  ...META,
  async run(ctx) {
    setDifficulty(1);
    // Make sure the tip carries a transaction we can tamper with (the fork has its own copy of the chain).
    queue(createSystemTx(SYSTEM.PRESENTADOR, ctx.rng.int(1, 9)));
    mineAll();

    const chain = structuredClone(state.chain);
    const total = chain.length;
    const a = validateChain(chain);
    const b = validateChainB(chain);
    const step = Math.ceil(total / 40);
    let agree = 0;
    let mismatch = null;
    for (let i = 0; i < total; i++) {
      if (a[i].valid === b[i].valid && a[i].reason === b[i].reason) agree++;
      else mismatch ??= `#${i} A: ${a[i].reason ?? 'válido'} · B: ${b[i].reason ?? 'válido'}`;
      ctx.progress(`bloque ${i + 1}/${total}`);
      if (i % step === 0) await ctx.pace(40);
    }
    const bad = firstBad(a);
    await ctx.check(
      'Cadena de la red copiada',
      agree === total,
      agree === total
        ? `${agree}/${total} bloques coinciden · ${bad ? `ambos ven la cadena inválida desde #${bad.index}` : 'ambos la dan por válida'}`
        : `${agree}/${total} coinciden · ${mismatch}`,
    );

    // Tampered copies: both clients must reject, at the same block and for the same reason.
    const tip = total - 1;
    const mutations = [
      ['Monto alterado en el último bloque', (c) => { c[tip].txs[0].amount += 1000; }, 'Hash no coincide'],
      ['Hash falsificado', (c) => { c[tip].hash = '0'.repeat(64); }, 'Hash no coincide'],
      ['prevHash roto y re-minado', (c) => { c[tip].prevHash = 'ab'.repeat(32); remineBlock(c[tip]); }, 'prevHash no coincide con el bloque anterior'],
      ['Prueba de trabajo insuficiente', (c) => { c[tip].difficulty = leadingZeros(c[tip].hash) + 1; }, 'No cumple la dificultad'],
    ];
    for (const [name, mutate, reason] of mutations) {
      ctx.progress(`caso ${mutations.findIndex((m) => m[0] === name) + 1}/${mutations.length}`);
      const copy = structuredClone(state.chain);
      mutate(copy);
      const va = validateChain(copy);
      const vb = validateChainB(copy);
      const fa = firstBad(va);
      const fb = firstBad(vb);
      const ok = same(va, vb) && fa?.index === tip && fa?.reason === reason;
      await ctx.check(name, ok, ok
        ? `ambos rechazan el bloque #${tip}: ${reason}`
        : `A: ${fa ? `#${fa.index} ${fa.reason}` : 'válida'} · B: ${fb ? `#${fb.index} ${fb.reason}` : 'válida'}`);
    }
    ctx.summary(agree === total ? `Los dos clientes coinciden en ${total}/${total} bloques y en las 4 cadenas manipuladas` : 'Los clientes discrepan');
  },
};
