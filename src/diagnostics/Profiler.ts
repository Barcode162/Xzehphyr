/**
 * Instrumentation layer. Every timing here is a *direct measurement* with
 * performance.now() around a block of JavaScript. Nothing is extrapolated.
 *
 * The profiler can be disabled to measure its own overhead: when disabled,
 * begin/end return immediately (only the whole-frame timer keeps running, using
 * two performance.now() calls per frame).
 *
 * NOTE: browsers coarsen performance.now() (Chrome ~5–100 µs depending on
 * cross-origin isolation, Safari/iOS commonly 1 ms historically, Firefox ~1 ms).
 * Per-frame subsystem values are therefore quantized; averages over many frames
 * remain meaningful because block boundaries fall at random phases of the timer grid.
 * The measured timer resolution is reported in the dashboard.
 */

export enum Scope {
  Frame = 0,
  Input,
  Physics,
  PhysQuery,
  Animation,
  Camera,
  Sync,
  Visibility,
  Shadow,
  Lighting,
  Audio,
  Resolve,
  Spatial,
  CacheLookup,
  GeomGen,
  Assembly,
  Conventional,
  DebugViz,
  RenderSubmit,
  Diagnostics,
  COUNT,
}

export const SCOPE_NAMES: string[] = [
  'Frame (JS total)', 'Input', 'Physics', 'Physics queries', 'Animation', 'Camera', 'Index sync',
  'Visibility', 'Shadow contributors', 'Lighting', 'Audio', 'Reference resolution', 'Spatial lookup',
  'Query cache lookup', 'Geometry generation', 'Render assembly', 'Conventional scene update',
  'Debug visualization', 'Render submit (CPU)', 'Diagnostics UI',
];

/** Scopes that are nested inside others (shown as cross-cutting, not summed). */
export const CROSS_CUTTING = new Set<number>([Scope.PhysQuery, Scope.Resolve, Scope.Spatial, Scope.CacheLookup]);

export class Profiler {
  enabled = true;
  readonly acc = new Float64Array(Scope.COUNT);
  private starts = new Float64Array(Scope.COUNT);
  private depth = new Int32Array(Scope.COUNT);
  /** Number of begin/end pairs this frame (for overhead accounting). */
  calls = 0;
  timerResolutionMs = NaN;

  begin(s: Scope): void {
    if (!this.enabled) return;
    if (this.depth[s]++ === 0) this.starts[s] = performance.now();
    this.calls++;
  }

  end(s: Scope): void {
    if (!this.enabled) return;
    if (--this.depth[s] === 0) this.acc[s] += performance.now() - this.starts[s];
  }

  /** Frame timer is always on (it is the baseline for the overhead comparison). */
  frameStart = 0;
  beginFrame(): void {
    this.acc.fill(0);
    this.depth.fill(0);
    this.calls = 0;
    this.frameStart = performance.now();
  }
  endFrame(): void {
    this.acc[Scope.Frame] = performance.now() - this.frameStart;
  }

  /** Measure the smallest observable performance.now() increment. */
  measureTimerResolution(): number {
    let minDelta = Infinity;
    for (let trial = 0; trial < 40; trial++) {
      const t0 = performance.now();
      let t1 = t0;
      let guard = 0;
      while (t1 === t0 && guard++ < 1e6) t1 = performance.now();
      const d = t1 - t0;
      if (d > 0 && d < minDelta) minDelta = d;
    }
    this.timerResolutionMs = minDelta;
    return minDelta;
  }

  /** Measured cost of one begin/end pair (ms), by timing many pairs. */
  measurePairCost(iterations = 20000): number {
    const wasEnabled = this.enabled;
    this.enabled = true;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      this.begin(Scope.Diagnostics);
      this.end(Scope.Diagnostics);
    }
    const t1 = performance.now();
    this.enabled = wasEnabled;
    this.acc[Scope.Diagnostics] = 0;
    return (t1 - t0) / iterations;
  }
}

export const profiler = new Profiler();

/** Per-frame engine counters (exact counts of work performed, not estimates). */
export class FrameCounters {
  queries = 0;
  queryNodes = 0;
  queryTests = 0;
  queryResults = 0;
  resolveCalls = 0;
  resolveRecomputes = 0;
  resolveHits = 0;
  qcacheHits = 0;
  qcacheMisses = 0;
  geomGenerated = 0;
  geomGenMs = 0;
  geomCacheHits = 0;
  geomCacheMisses = 0;
  geomEvicted = 0;
  geomDisposed = 0;
  unresolved = 0;
  lodFallbacks = 0;
  visible = 0;
  shadowOnly = 0;
  shadowCasters = 0;
  colliderCandidates = 0;
  audioSources = 0;
  lightsConsidered = 0;
  lightsActive = 0;
  instancesWritten = 0;
  assemblySkipped = 0;
  uploadBytes = 0;
  terrainEvals = 0;

  private static keys: string[] | null = null;
  reset(): void {
    const keys = FrameCounters.keys ?? (FrameCounters.keys = Object.keys(this).filter((k) => typeof (this as unknown as Record<string, unknown>)[k] === 'number'));
    const self = this as unknown as Record<string, number>;
    for (let i = 0; i < keys.length; i++) self[keys[i]] = 0;
  }

  snapshot(): Record<string, number> {
    return { ...(this as unknown as Record<string, number>) };
  }
}

export const counters = new FrameCounters();
