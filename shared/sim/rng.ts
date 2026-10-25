/** mulberry32: tiny, fast, deterministic PRNG whose whole state is one 32-bit integer. */
export function nextRandom(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomInt(state: { rng: number }, maxExclusive: number): number {
  return Math.floor(nextRandom(state) * maxExclusive);
}

export function pick<T>(state: { rng: number }, items: readonly T[]): T {
  return items[randomInt(state, items.length)];
}
