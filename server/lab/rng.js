// Seeded PRNG (mulberry32) so a failing run can be reproduced from the seed shown on screen.
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)), // inclusive
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    hex: (len) => Array.from({ length: len }, () => Math.floor(next() * 16).toString(16)).join(''),
    // Weighted pick: entries are [value, weight].
    weighted(entries) {
      const total = entries.reduce((n, [, w]) => n + w, 0);
      let r = next() * total;
      for (const [value, w] of entries) { r -= w; if (r < 0) return value; }
      return entries[entries.length - 1][0];
    },
  };
}

// Each suite gets its own stream derived from the run seed, so adding/removing a suite does not shift the others.
export function deriveSeed(seed, id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (seed ^ h) >>> 0;
}
