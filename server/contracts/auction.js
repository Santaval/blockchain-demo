// 0xSUBASTA: the contract holds the bids; only the previous highest bidder is refunded and the winner's bid goes to the presenter.
import { getContract } from './engine.js';
import { state, events, createSystemTx, SYSTEM } from '../state.js';

export const AUCTION = '0xSUBASTA';

const fresh = () => ({ item: '', endsAt: 0, open: false, highest: null, bids: [], refunds: [], winner: null });

export default {
  address: AUCTION, name: 'Subasta',
  init: fresh,
  methods: {
    ofertar(ctx) {
      const s = ctx.storage;
      // Block time counts, not the moment the bid was sent.
      if (!s.open || ctx.time >= s.endsAt) throw new Error('Subasta cerrada');
      const min = s.highest ? s.highest.amount : 0;
      if (ctx.value <= min) throw new Error(`La oferta debe superar ${min}`);
      const prev = s.highest;
      if (prev) { // refund only the previous highest bidder
        ctx.transfer(prev.address, prev.amount);
        s.refunds.push({ nick: prev.nick, amount: prev.amount });
        ctx.log(`Reembolso de ${prev.amount} a ${prev.nick}`);
      }
      const nick = ctx.nick(ctx.sender);
      s.highest = { address: ctx.sender, nick, amount: ctx.value };
      s.bids.push({ nick, amount: ctx.value, time: ctx.time });
      ctx.log(`${nick} ofertó ${ctx.value}`);
    },
    cerrar(ctx) {
      const s = ctx.storage;
      if (ctx.sender !== SYSTEM.SISTEMA) throw new Error('Solo el sistema puede cerrar');
      if (!s.open || ctx.time < s.endsAt) throw new Error('Todavía no termina');
      s.open = false;
      if (s.highest) {
        ctx.transfer(SYSTEM.PRESENTADOR, s.highest.amount);
        s.winner = s.highest;
        ctx.log(`Subasta cerrada: ganó ${s.highest.nick} con ${s.highest.amount}`);
      } else ctx.log('Subasta cerrada sin ofertas');
    },
  },
  view: (s) => ({ item: s.item, endsAt: s.endsAt, open: s.open, highest: s.highest, bids: s.bids, refunds: s.refunds, winner: s.winner }),
  viewFor: (s, address) => ({ isHighest: s.highest?.address === address }),
  active: (s) => s.open || s.winner !== null,
};

// Close timer: queues a SISTEMA -> cerrar tx when time is up. Cleared on reset.
let closeTimer = null;
const clearCloseTimer = () => { clearTimeout(closeTimer); closeTimer = null; };
events.on('reset', clearCloseTimer);

export function pushCloseTx() {
  closeTimer = null;
  const tx = createSystemTx(AUCTION, 0, { call: { method: 'cerrar', args: [] } });
  state.mempool.push(tx);
  state.txStatus.set(tx.hash, { status: 'pending' });
  events.emit('mempool:add', tx);
  events.emit('state:changed');
}

// Admin helper (off-chain config). Returns { ok, reason? }.
export function openAuction({ item, seconds } = {}) {
  const s = getContract(AUCTION).storage;
  if (s.open) return { ok: false, reason: 'Ya hay una subasta abierta' };
  const name = typeof item === 'string' ? item.trim() : '';
  if (name.length < 1 || name.length > 60) return { ok: false, reason: 'El artículo debe tener de 1 a 60 caracteres' };
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 600) return { ok: false, reason: 'La duración debe ser de 15 a 600 segundos' };
  // Any balance from a previous run was already paid out, so storage starts fresh.
  Object.assign(s, fresh(), { item: name, endsAt: Date.now() + seconds * 1000, open: true });
  clearCloseTimer();
  closeTimer = setTimeout(pushCloseTx, seconds * 1000);
  closeTimer.unref();
  return { ok: true };
}
