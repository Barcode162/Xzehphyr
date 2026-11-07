/**
 * Deterministic random number generation.
 * Every procedural definition in the world database carries a seed so that any
 * consumer (geometry, physics, audio) can regenerate identical results on demand.
 */

export type Rng = () => number;

/** mulberry32: tiny, fast, deterministic 32-bit PRNG. Returns [0,1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash (for deriving child seeds without allocating RNG state). */
export function hash32(x: number): number {
  x = x | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x = x ^ (x >>> 16);
  return x >>> 0;
}

export function hash2(a: number, b: number): number {
  return hash32(Math.imul(a | 0, 0x9e3779b1) ^ hash32(b));
}

/** Hash to float [0,1). */
export function hashFloat(a: number, b = 0): number {
  return hash2(a, b) / 4294967296;
}

export function randRange(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function randInt(rng: Rng, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}
