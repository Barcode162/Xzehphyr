/**
 * GEOMETRY EVALUATION — demand-driven generation with an optional cache.
 *
 * Consumers (camera visibility, shadow contributors) *request* a representation
 * by key (procedural def × LOD). Missing representations are queued and
 * generated under a per-frame time budget, nearest first.
 *
 * Retention policies:
 *   - retain = true  (Test C): LRU cache bounded by a byte budget.
 *   - retain = false (Test B): representations are kept only while some consumer
 *     requested them this frame; anything unobserved is disposed at frame end and
 *     must be regenerated when observed again.
 */
import { GeometryData } from './MeshBuilder';
import { GrassPayload } from './Generators';
import { counters } from '../diagnostics/Profiler';

export interface GeomEntry {
  key: number;
  def: number;
  lod: number;
  geometry: GeometryData | null;
  grass: GrassPayload | null;
  bytes: number;
  lastUsed: number;
  generatedFrame: number;
  genMs: number;
  /** Presentation-side handle (GPU buffers). Owned by the presentation layer. */
  gpu: unknown;
}

export type GenerateFn = (def: number, lod: number) => { geometry?: GeometryData; grass?: GrassPayload };

export const keyOf = (def: number, lod: number) => def * 4 + lod;

export class GeometryStore {
  entries = new Map<number, GeomEntry>();
  retain = true;
  budgetBytes = 96 * 1024 * 1024;
  frame = 0;
  totalBytes = 0;
  private pending = new Map<number, number>(); // key -> priority (lower = sooner)
  private pendingKeys: number[] = [];
  onDispose: ((e: GeomEntry) => void) | null = null;
  generate: GenerateFn;
  // lifetime stats
  generatedTotal = 0;
  generatedMsTotal = 0;
  evictedTotal = 0;
  disposedTotal = 0;
  hitsTotal = 0;
  missesTotal = 0;
  /** Generations per family/kind label (for reports). */
  genByLabel = new Map<string, number>();
  labelOf: (def: number, lod: number) => string = () => 'geometry';

  constructor(generate: GenerateFn) {
    this.generate = generate;
  }

  beginFrame(frame: number): void {
    this.frame = frame;
  }

  /** Request a representation. Returns it if available, else queues generation and returns null. */
  request(key: number, priority: number): GeomEntry | null {
    const e = this.entries.get(key);
    if (e) {
      if (e.lastUsed !== this.frame) {
        e.lastUsed = this.frame;
        counters.geomCacheHits++;
        this.hitsTotal++;
      }
      return e;
    }
    const p = this.pending.get(key);
    if (p === undefined) {
      this.pending.set(key, priority);
      this.pendingKeys.push(key);
      counters.geomCacheMisses++;
      this.missesTotal++;
    } else if (priority < p) {
      this.pending.set(key, priority);
    }
    return null;
  }

  /** Peek without marking use or queueing. */
  peek(key: number): GeomEntry | undefined {
    return this.entries.get(key);
  }

  /** Mark an entry as used this frame without counting a request (fallback usage). */
  touch(e: GeomEntry): void {
    e.lastUsed = this.frame;
  }

  get pendingCount(): number {
    return this.pendingKeys.length;
  }

  /** Generate queued representations within a time budget. Always generates at least one. */
  process(budgetMs: number): number {
    if (this.pendingKeys.length === 0) return 0;
    const pend = this.pending;
    this.pendingKeys.sort((a, b) => (pend.get(a) ?? 0) - (pend.get(b) ?? 0));
    const t0 = performance.now();
    let made = 0;
    let i = 0;
    for (; i < this.pendingKeys.length; i++) {
      if (made > 0 && performance.now() - t0 > budgetMs) break;
      const key = this.pendingKeys[i];
      const def = Math.floor(key / 4), lod = key % 4;
      const g0 = performance.now();
      const res = this.generate(def, lod);
      const ms = performance.now() - g0;
      const bytes = (res.geometry?.bytes ?? 0) + (res.grass?.bytes ?? 0);
      const entry: GeomEntry = {
        key, def, lod, geometry: res.geometry ?? null, grass: res.grass ?? null, bytes,
        lastUsed: this.frame, generatedFrame: this.frame, genMs: ms, gpu: null,
      };
      this.entries.set(key, entry);
      this.totalBytes += bytes;
      this.generatedTotal++;
      this.generatedMsTotal += ms;
      counters.geomGenerated++;
      counters.geomGenMs += ms;
      const label = this.labelOf(def, lod);
      this.genByLabel.set(label, (this.genByLabel.get(label) ?? 0) + 1);
      pend.delete(key);
      made++;
    }
    this.pendingKeys.splice(0, i);
    return made;
  }

  /** Drop queued requests that were not re-requested (e.g. camera turned away). */
  private prunePending(): void {
    // keep it simple: the queue is rebuilt from fresh requests each frame
    this.pending.clear();
    this.pendingKeys.length = 0;
  }

  endFrame(): void {
    this.prunePending();
    if (!this.retain) {
      for (const e of this.entries.values()) {
        if (e.lastUsed !== this.frame) {
          this.dispose(e);
          counters.geomDisposed++;
        }
      }
      return;
    }
    if (this.totalBytes <= this.budgetBytes) return;
    const list = [...this.entries.values()].filter((e) => e.lastUsed !== this.frame).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of list) {
      if (this.totalBytes <= this.budgetBytes) break;
      this.dispose(e);
      this.evictedTotal++;
      counters.geomEvicted++;
    }
  }

  private dispose(e: GeomEntry): void {
    this.entries.delete(e.key);
    this.totalBytes -= e.bytes;
    this.disposedTotal++;
    if (this.onDispose) this.onDispose(e);
  }

  clear(): void {
    for (const e of [...this.entries.values()]) this.dispose(e);
    this.prunePending();
  }

  resetStats(): void {
    this.generatedTotal = 0;
    this.generatedMsTotal = 0;
    this.evictedTotal = 0;
    this.disposedTotal = 0;
    this.hitsTotal = 0;
    this.missesTotal = 0;
    this.genByLabel.clear();
  }
}
