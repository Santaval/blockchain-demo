// Slide 9: Byzantine fault tolerance, simulated with four nodes (n = 3f + 1, f = 1) over copies of the fork chain.
// Honest nodes validate proposals with validateChain and only finalize a block with a quorum of 2f + 1 votes.
import { CATALOG } from '../catalog.js';
import { state, createSystemTx, SYSTEM } from '../../state.js';
import { validateChain } from '../../miner.js';
import { computeBlockHash } from '../../crypto.js';

const META = CATALOG.find((s) => s.id === 'bft');
const N = 4;
const F = 1;
const QUORUM = 2 * F + 1;

const makeNodes = (byzantine) =>
  Array.from({ length: N }, (_, i) => ({ id: `N${i}`, byz: byzantine.includes(i), chain: structuredClone(state.chain) }));

// A valid block on top of the node's tip (difficulty 1 keeps the simulation instant).
function propose(node, amount) {
  const tip = node.chain[node.chain.length - 1];
  const block = {
    index: tip.index + 1, prevHash: tip.hash, timestamp: Date.now() + amount,
    txs: [createSystemTx(SYSTEM.PRESENTADOR, amount)], nonce: 0, difficulty: 1,
  };
  while (!(block.hash = computeBlockHash(block)).startsWith('0')) block.nonce++;
  return block;
}

// What an honest node does with a proposal: validate it against its own tip.
function verdict(node, block) {
  const tip = node.chain[node.chain.length - 1];
  const v = validateChain([tip, block])[1];
  return v.valid ? null : v.reason;
}

const tally = (votes) => Math.max(0, ...[...votes.values()].map((s) => s.size));
const addVote = (votes, hash, id) => {
  if (!votes.has(hash)) votes.set(hash, new Set());
  votes.get(hash).add(id);
};

export default {
  ...META,
  async run(ctx) {
    // One drawing per round for the projector: who voted what, the tally against the quorum, and the outcome.
    const scenes = [];
    const scene = (title, nodes, votes, result, good) => {
      scenes.push({ title, nodes, votes, quorum: QUORUM, result, good });
      ctx.viz({ n: N, f: F, quorum: QUORUM, scenes: [...scenes] });
    };
    const draw = (nodes, voteOf) => nodes.map((n) => ({ id: n.id, byz: n.byz, vote: voteOf(n) }));
    // Case 1: the byzantine node proposes a block with an altered amount.
    ctx.progress('caso 1/3');
    {
      const nodes = makeNodes([3]);
      const honest = nodes.filter((n) => !n.byz);
      const forged = propose(nodes[3], 5);
      forged.txs[0].amount = 5000; // edited after mining
      const votes = new Map();
      let allReject = true;
      for (const n of honest) {
        const reason = verdict(n, forged);
        if (reason === null) { allReject = false; addVote(votes, forged.hash, n.id); }
        await ctx.check(`Caso 1 · ${n.id} revisa el bloque del traidor`, reason !== null, reason ? `rechaza: ${reason}` : 'lo aceptó (mal)');
      }
      addVote(votes, forged.hash, 'N3'); // the traitor votes for its own block
      const best = tally(votes);
      scene('1 · Un traidor propone un bloque falso', draw(nodes, (n) => (n.byz ? 'propone' : 'rechaza')), best,
        'Bloque falso rechazado', allReject && best < QUORUM);
      await ctx.check('Caso 1 · Nadie lo finaliza', allReject && best < QUORUM,
        `${best} voto(s) de ${QUORUM} necesarios · la cadena de los honestos no cambia`);
    }

    // Case 2: equivocation. The traitor sends a different valid block to each honest node.
    ctx.progress('caso 2/3');
    {
      const nodes = makeNodes([3]);
      const honest = nodes.filter((n) => !n.byz);
      const votes = new Map();
      honest.forEach((n, i) => {
        const block = propose(nodes[3], 10 + i);
        if (verdict(n, block) === null) addVote(votes, block.hash, n.id);
        addVote(votes, block.hash, 'N3'); // the traitor backs every version
      });
      const best = tally(votes);
      scene('2a · El traidor manda un bloque distinto a cada nodo', draw(nodes, (n) => (n.byz ? 'A, B y C' : `versión ${'ABC'[honest.indexOf(n)]}`)), best,
        'Sin quórum: no se finaliza ninguna', best < QUORUM);
      await ctx.check('Caso 2 · El traidor manda un bloque distinto a cada nodo', best < QUORUM,
        `3 versiones, la mejor tiene ${best} voto(s); hacen falta ${QUORUM}: no se finaliza ninguna`);
      const leader = honest[0]; // view change: an honest leader proposes, everyone validates it
      const block = propose(leader, 42);
      const finalVotes = new Map();
      for (const n of honest) if (verdict(n, block) === null) addVote(finalVotes, block.hash, n.id);
      const reached = tally(finalVotes) >= QUORUM;
      if (reached) honest.forEach((n) => n.chain.push(structuredClone(block)));
      const tips = new Set(honest.map((n) => n.chain[n.chain.length - 1].hash));
      scene('2b · Cambio de líder: propone un nodo honesto', draw(nodes, (n) => (n.byz ? 'ignorado' : n === leader ? 'propone' : 'acepta')), tally(finalVotes),
        'Bloque finalizado', reached && tips.size === 1);
      await ctx.check('Caso 2 · Cambio de líder: gana el bloque honesto', reached && tips.size === 1,
        `${tally(finalVotes)}/${QUORUM} votos · los ${honest.length} nodos honestos terminan con la misma punta`);
    }

    // Case 3: two traitors out of four. Nothing invalid gets in (safety), but nothing gets agreed (liveness).
    ctx.progress('caso 3/3');
    {
      const nodes = makeNodes([2, 3]);
      const honest = nodes.filter((n) => !n.byz);
      const forged = propose(nodes[3], 7);
      forged.txs[0].amount = 7000;
      const rejected = honest.every((n) => verdict(n, forged) !== null);
      await ctx.check('Caso 3 · Seguridad: el bloque falso se rechaza', rejected, 'ningún nodo honesto acepta un bloque inválido');
      const block = propose(honest[0], 21);
      const votes = new Map();
      for (const n of honest) if (verdict(n, block) === null) addVote(votes, block.hash, n.id);
      const best = tally(votes);
      scene('3 · Dos traidores de cuatro', draw(nodes, (n) => (n.byz ? 'no vota' : 'acepta')), best,
        'Segura, pero detenida: falta quórum', rejected && best < QUORUM);
      await ctx.check('Caso 3 · Vivacidad: sin acuerdo', best < QUORUM,
        `el bloque honesto solo suma ${best}/${QUORUM} votos: la red se detiene`);
      await ctx.check('Caso 3 · Regla n ≥ 3f + 1', true, 'con 2 traidores harían falta 7 nodos; con 4 solo se tolera 1');
    }
    ctx.summary('f = 1 de 4: se tolera · f = 2 de 4: segura pero detenida');
  },
};
