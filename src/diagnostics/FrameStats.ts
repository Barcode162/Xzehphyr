/**
 * Preallocated ring buffer of per-frame samples + summary statistics.
 * All values recorded here are direct measurements or exact counts.
 */
import { Scope } from './Profiler';

export const SAMPLE_FIELDS = [
  't', 'interval', 'cpu', 'gpu', 'draws', 'tris', 'heapMB',
  'visible', 'shadowOnly', 'unresolved', 'queries', 'qHits', 'qMiss', 'geomGen', 'geomHit', 'geomMiss',
  'resolveCalls', 'resolveRecomputes', 'instances', 'uploadKB',
] as const;
export type SampleField = typeof SAMPLE_FIELDS[number];
export const SCOPE_OFFSET = SAMPLE_FIELDS.length;
export const STRIDE = SAMPLE_FIELDS.length + Scope.COUNT;

export interface Summary {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  p95: number;
  p99: number;
  std: number;
  variance: number;
}

export function summarize(values: ArrayLike<number>, n = values.length): Summary {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) { const v = values[i]; if (Number.isFinite(v)) arr.push(v); }
  if (arr.length === 0) return { n: 0, mean: NaN, median: NaN, min: NaN, max: NaN, p95: NaN, p99: NaN, std: NaN, variance: NaN };
  arr.sort((a, b) => a - b);
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  let v = 0;
  for (const x of arr) v += (x - m) * (x - m);
  v /= arr.length;
  const q = (p: number) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
  return { n: arr.length, mean: m, median: q(0.5), min: arr[0], max: arr[arr.length - 1], p95: q(0.95), p99: q(0.99), std: Math.sqrt(v), variance: v };
}

/** 1% low FPS: mean FPS over the slowest 1% of frame intervals. Requires >= 100 samples. */
export function onePercentLow(intervals: ArrayLike<number>, n = intervals.length): number {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) { const v = intervals[i]; if (Number.isFinite(v) && v > 0) arr.push(v); }
  if (arr.length < 100) return NaN;
  arr.sort((a, b) => b - a);
  const k = Math.max(1, Math.floor(arr.length * 0.01));
  let s = 0;
  for (let i = 0; i < k; i++) s += arr[i];
  return 1000 / (s / k);
}

export class FrameStats {
  readonly capacity: number;
  readonly data: Float64Array;
  head = 0;
  size = 0;
  totalFrames = 0;
  longFrames = 0; // interval > 50 ms
  delayedFrames = 0; // interval > 1.5x estimated refresh interval
  refreshIntervalMs = NaN;

  constructor(capacity = 1800) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity * STRIDE);
  }

  /** Returns the offset of a fresh sample row to fill. */
  begin(): number {
    const o = this.head * STRIDE;
    this.data.fill(NaN, o, o + STRIDE);
    return o;
  }

  commit(): void {
    const o = this.head * STRIDE;
    const interval = this.data[o + 1];
    if (interval > 50) this.longFrames++;
    if (Number.isFinite(this.refreshIntervalMs) && interval > this.refreshIntervalMs * 1.5) this.delayedFrames++;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.totalFrames++;
  }

  /** Field value of the k-th most recent sample (0 = newest). */
  get(k: number, field: number): number {
    if (k >= this.size) return NaN;
    const idx = (this.head - 1 - k + this.capacity * 2) % this.capacity;
    return this.data[idx * STRIDE + field];
  }

  /** Values of a field for the most recent n samples (oldest first). */
  series(field: number, n = this.size, out?: Float64Array): Float64Array {
    n = Math.min(n, this.size);
    const res = out && out.length >= n ? out : new Float64Array(n);
    for (let i = 0; i < n; i++) res[i] = this.get(n - 1 - i, field);
    return res;
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.totalFrames = 0;
    this.longFrames = 0;
    this.delayedFrames = 0;
  }

  fieldIndex(name: SampleField): number {
    return SAMPLE_FIELDS.indexOf(name);
  }

  /** CSV of buffered samples (oldest first). */
  toCSV(scopeNames: string[]): string {
    const header = [...SAMPLE_FIELDS, ...scopeNames.map((s) => `ms_${s.replace(/[^a-z0-9]+/gi, '_')}`)];
    const lines = [header.join(',')];
    for (let k = this.size - 1; k >= 0; k--) {
      const row: string[] = [];
      for (let f = 0; f < STRIDE; f++) {
        const v = this.get(k, f);
        row.push(Number.isFinite(v) ? (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(3) : +v.toFixed(4) + '') : '');
      }
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }
}

export const F = Object.fromEntries(SAMPLE_FIELDS.map((k, i) => [k, i])) as Record<SampleField, number>;
