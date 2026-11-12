// Environment + tunables for the demo.
const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const PORT = int(process.env.PORT, 3000);
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';
export const MINE_INTERVAL_MS = int(process.env.MINE_INTERVAL_MS, 12000);
export const DIFFICULTY = int(process.env.DIFFICULTY, 4);
export const MAX_TXS_PER_BLOCK = int(process.env.MAX_TXS_PER_BLOCK, 25);
export const FAUCET_AMOUNT = int(process.env.FAUCET_AMOUNT, 100);
