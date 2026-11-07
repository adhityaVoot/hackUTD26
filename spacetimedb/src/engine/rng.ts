/** Seeded RNG. Callers pass the returned function; nothing here reads Math.random. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller. Uses two draws from `r`. */
export function normal(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormal(r: () => number, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * normal(r));
}

/** Knuth's method. `lambda` is the mean count. */
export function poisson(r: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= r();
  } while (p > limit && k < 10_000);
  return k - 1;
}

/** Stable 32-bit mix of numeric parts (household, path, category, …). */
export function seedFor(...parts: number[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
  }
  return h >>> 0;
}
