// 0xVOTACION: one vote per address, results and voters are public.
import { getContract } from './engine.js';

export const VOTING = '0xVOTACION';

export default {
  address: VOTING, name: 'Votación',
  init: () => ({ question: '', options: [], open: false, votes: [] }),
  methods: {
    votar(ctx, opcion) {
      const s = ctx.storage;
      if (!s.open) throw new Error('La votación está cerrada');
      if (!Number.isInteger(opcion) || opcion < 0 || opcion >= s.options.length) throw new Error('Opción inválida');
      if (s.votes.some((v) => v.address === ctx.sender)) throw new Error('Ya votaste');
      if (ctx.value !== 0) throw new Error('La votación no acepta monedas');
      const nick = ctx.nick(ctx.sender);
      s.votes.push({ address: ctx.sender, nick, option: opcion });
      ctx.log(`${nick} votó por ${s.options[opcion]}`);
    },
  },
  view: (s) => ({
    question: s.question, options: s.options, open: s.open, votes: s.votes,
    counts: s.options.map((_, i) => s.votes.filter((v) => v.option === i).length),
  }),
  viewFor: (s, address) => ({ myVote: s.votes.find((v) => v.address === address)?.option ?? null }),
  active: (s) => s.open || s.votes.length > 0,
};

// Admin helpers (off-chain config: they mutate storage directly). Return { ok, reason? }.
const storage = () => getContract(VOTING).storage;

export function configureVoting({ question, options } = {}) {
  const s = storage();
  if (s.open) return { ok: false, reason: 'Cierra la votación antes de configurarla' };
  const q = typeof question === 'string' ? question.trim() : '';
  if (q.length < 1 || q.length > 120) return { ok: false, reason: 'La pregunta debe tener de 1 a 120 caracteres' };
  const opts = Array.isArray(options) ? options.map((o) => (typeof o === 'string' ? o.trim() : '')) : [];
  if (opts.length < 2 || opts.length > 6) return { ok: false, reason: 'Debe haber de 2 a 6 opciones' };
  if (opts.some((o) => o.length < 1 || o.length > 40)) return { ok: false, reason: 'Cada opción debe tener de 1 a 40 caracteres' };
  Object.assign(s, { question: q, options: opts, votes: [] });
  return { ok: true };
}

export function setVotingOpen(open) {
  const s = storage();
  if (open && s.options.length < 2) return { ok: false, reason: 'Configura la votación primero' };
  s.open = open;
  return { ok: true };
}
