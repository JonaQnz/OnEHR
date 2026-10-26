/** Deterministic PRNG (mulberry32) so a scenario + seed always produces the
 * same output - the dry-run preview and a real generate run must be
 * byte-identical for the same seed (see engine/submission/dryRun.ts). */
export type Rng = () => number;

export function createRng(seed = 1): Rng {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box-Muller, drawn from the same seeded
 * uniform generator so it stays deterministic too. */
export function gaussian(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
