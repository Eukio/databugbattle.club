// Counter-based RNG (design doc §Determinism). Pure functions of (seed, stream, turn, slot, attempt).

export const STREAM = { MAP: 0, DC_POOL: 1, LAND_POOL: 2, SPREAD: 3, GOLDEN: 9 } as const;

export function fmix32(h: number): number {
  h >>>= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function mix(h: number, v: number): number {
  return fmix32(((h >>> 0) ^ fmix32((v + 0x9e3779b9) >>> 0)) >>> 0);
}

export function rand(seed: number, stream: number, turn: number, slot: number, attempt: number): number {
  return mix(mix(mix(mix(fmix32(seed), stream), turn), slot), attempt);
}

/** Uniform integer in [0, n) with rejection sampling over `attempt`. */
export function uniform(seed: number, stream: number, turn: number, slot: number, n: number): number {
  if (n <= 0 || !Number.isInteger(n)) throw new Error(`uniform: bad n ${n}`);
  const limit = Math.floor(4294967296 / n) * n;
  for (let attempt = 0; ; attempt++) {
    const r = rand(seed, stream, turn, slot, attempt);
    if (r < limit) return r % n;
  }
}

/** Weighted choice: draw in [0, total) and walk candidates in the order given (row-major by construction). */
export function weightedIndex(seed: number, stream: number, turn: number, slot: number, weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = uniform(seed, stream, turn, slot, total);
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  throw new Error('weightedIndex: unreachable');
}

/** The map stream: one slot counter, retries of a single draw use `attempt`. */
export class MapStream {
  slot = 0;
  private readonly seed: number;
  constructor(seed: number) { this.seed = seed; }
  draw(n: number): number {
    const v = uniform(this.seed, STREAM.MAP, 0, this.slot, n);
    this.slot++;
    return v;
  }
}

export function seedToHex(seed: number): string {
  return (seed >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
export function hexToSeed(hex: string): number {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error('seed must be 8 hex digits');
  return parseInt(hex, 16) >>> 0;
}
