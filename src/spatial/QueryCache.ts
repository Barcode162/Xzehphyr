/**
 * Cached query results with dependency-driven invalidation.
 *
 * Each entry depends on:
 *   - the spatial-index quadrants it touched (versions snapshotted at store time)
 *   - an "extra" dependency version supplied by the caller (sun direction, light state, ...)
 * An entry is valid only while all dependencies are unchanged. Entries are
 * evicted LRU; result lists are recycled to avoid per-frame allocation.
 */
import { IntList } from '../util/math';
import { SpatialIndex } from './SpatialIndex';

interface Entry {
  key: number;
  result: IntList;
  mask: number;
  quadVers: Uint32Array;
  extraVer: number;
  indexVer: number;
  lastUse: number;
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  evictions: number;
}

export class QueryCache {
  enabled = true;
  maxEntries: number;
  private entries = new Map<number, Entry>();
  private pool: Entry[] = [];
  private tick = 0;
  stats: QueryCacheStats = { hits: 0, misses: 0, invalidations: 0, evictions: 0 };
  /** Lifetime counters (not reset per frame). */
  total: QueryCacheStats = { hits: 0, misses: 0, invalidations: 0, evictions: 0 };

  constructor(maxEntries = 96) {
    this.maxEntries = maxEntries;
  }

  lookup(key: number, index: SpatialIndex, extraVer: number): IntList | null {
    if (!this.enabled) return null;
    this.tick++;
    const e = this.entries.get(key);
    if (!e) { this.stats.misses++; this.total.misses++; return null; }
    let valid = e.extraVer === extraVer;
    if (valid && e.mask !== 0) {
      const qv = index.quadVersion;
      for (let q = 0; q < 16; q++) {
        if ((e.mask & (1 << q)) !== 0 && qv[q] !== e.quadVers[q]) { valid = false; break; }
      }
    }
    if (valid && e.mask === 0 && e.indexVer !== index.version) valid = false;
    if (!valid) {
      this.stats.invalidations++; this.total.invalidations++;
      this.stats.misses++; this.total.misses++;
      this.entries.delete(key);
      this.pool.push(e);
      return null;
    }
    e.lastUse = this.tick;
    this.stats.hits++; this.total.hits++;
    return e.result;
  }

  store(key: number, result: IntList, mask: number, index: SpatialIndex, extraVer: number): void {
    if (!this.enabled) return;
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.maxEntries) this.evictOne();
      e = this.pool.pop() ?? { key, result: new IntList(64), mask: 0, quadVers: new Uint32Array(16), extraVer: 0, indexVer: 0, lastUse: 0 };
      e.key = key;
      this.entries.set(key, e);
    }
    e.result.copyFrom(result);
    e.mask = mask;
    e.quadVers.set(index.quadVersion);
    e.extraVer = extraVer;
    e.indexVer = index.version;
    e.lastUse = this.tick;
  }

  private evictOne(): void {
    let oldest: Entry | null = null;
    for (const e of this.entries.values()) if (!oldest || e.lastUse < oldest.lastUse) oldest = e;
    if (oldest) {
      this.entries.delete(oldest.key);
      this.pool.push(oldest);
      this.stats.evictions++; this.total.evictions++;
    }
  }

  clear(): void {
    for (const e of this.entries.values()) this.pool.push(e);
    this.entries.clear();
  }

  resetStats(): void {
    const s = this.stats;
    s.hits = 0; s.misses = 0; s.invalidations = 0; s.evictions = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  bytes(): number {
    let b = 0;
    for (const e of this.entries.values()) b += e.result.byteSize + 64 + 32;
    return b;
  }
}

/** Combine integers into a 32-bit cache key (FNV-1a style). */
export function cacheKey(a: number, b: number, c: number, d: number, e = 0): number {
  let h = 2166136261;
  h = Math.imul(h ^ (a | 0), 16777619);
  h = Math.imul(h ^ (b | 0), 16777619);
  h = Math.imul(h ^ (c | 0), 16777619);
  h = Math.imul(h ^ (d | 0), 16777619);
  h = Math.imul(h ^ (e | 0), 16777619);
  return h >>> 0;
}
