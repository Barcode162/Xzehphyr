/**
 * BENCHMARK SUITE — reproducible scenarios.
 *
 * Reproducibility:
 *   - fixed world seed and configuration per scenario
 *   - fixed simulation step (1/60 s per frame) so every run produces the same
 *     sequence of camera poses regardless of the achieved frame rate
 *   - scripted, trail-relative camera paths (no user input)
 *   - optional cold start (all caches cleared) with a separately reported warm-up phase
 *
 * What is measured per frame: rAF interval, JS frame time, subsystem times,
 * draw calls / triangles (Three.js renderer counters), GPU time when a timer
 * extension exists, plus exact engine work counters.
 */
import { Engine, ArchId, ArchFlags, PRESETS, ScriptPose } from '../engine/Engine';
import { StressConfig, WorldConfig, DEFAULT_WORLD } from '../world/WorldGenerator';
import { FrameStats, F, SCOPE_OFFSET, Summary, summarize, onePercentLow } from '../diagnostics/FrameStats';
import { profiler, Scope, SCOPE_NAMES, CROSS_CUTTING } from '../diagnostics/Profiler';

export type ScriptId = 'trail-run' | 'yaw-sweep' | 'static' | 'flyover';

export interface Scenario {
  id: string;
  label: string;
  arch: ArchId;
  flags?: Partial<ArchFlags>;
  density: number;
  stress: StressConfig;
  script: ScriptId;
  frames: number;
  warmup: number;
  coldStart: boolean;
  instrumentation: boolean;
  timeOfDay: number;
  startS: number;
  group: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  archLabel: string;
  startedAt: string;
  wallMs: number;
  frames: number;
  entityCount: number;
  relationshipCount: number;
  worldBuildMs: number;
  conventionalBuildMs: number | null;
  interval: Summary;
  fpsMean: number;
  fpsFromMeanInterval: number;
  onePercentLowFps: number;
  cpu: Summary;
  gpu: Summary & { available: boolean; reason: string };
  scopesMean: Record<string, number>;
  scopesP95: Record<string, number>;
  draws: Summary;
  triangles: Summary;
  visibleMean: number;
  shadowOnlyMean: number;
  unresolvedMean: number;
  unresolvedFramesPct: number;
  queriesPerFrame: number;
  queryCacheHitRate: number;
  geometryGenerated: number;
  geometryGenMsTotal: number;
  geometryCacheHits: number;
  geometryCacheMisses: number;
  geometryEvicted: number;
  geometryDisposed: number;
  resolveCallsPerFrame: number;
  resolveRecomputesPerFrame: number;
  instancesPerFrame: number;
  uploadKBPerFrame: number;
  longFrames: number;
  delayedFrames: number;
  vsyncLimited: boolean;
  memory: {
    /** performance.measureUserAgentSpecificMemory() total (browser-reported; cross-origin isolated Chromium only). */
    uaSpecificMemoryMB: number | null;
    browserHeapStartMB: number | null;
    browserHeapEndMB: number | null;
    browserHeapPeakMB: number | null;
    estimates: Record<string, number>;
  };
  warmupPhase: { frames: number; cpuMean: number; cpuMax: number; geometryGenerated: number; unresolvedMean: number };
  yawSectors?: Array<{ sectorDeg: number; cpuMean: number; drawsMean: number; trianglesMean: number; visibleMean: number; shadowOnlyMean: number }>;
  samples: { interval: number[]; cpu: number[]; gpu: number[]; draws: number[]; triangles: number[] };
  notes: string[];
}

const ALL_OFF_STRESS: StressConfig = { extraTrees: 0, tallCasters: 0, extraLights: 0 };

export function makeScript(id: ScriptId, startS: number, frames: number): (frame: number, t: number) => ScriptPose {
  let f0 = -1;
  return (frame) => {
    if (f0 < 0) f0 = frame;
    const k = frame - f0;
    const t = k / 60; // fixed 60 Hz simulation time
    switch (id) {
      case 'trail-run':
        return { s: startS + t * 7, lateral: Math.sin(t * 0.7) * 0.6, camYaw: Math.sin(t * 0.45) * 0.55, camPitch: 0.3 + Math.sin(t * 0.3) * 0.08, camDist: 5.8 };
      case 'yaw-sweep': {
        const a = (k / Math.max(1, frames)) * Math.PI * 2;
        return { s: startS, lateral: 0, camYaw: a, camPitch: 0.22, camDist: 5.8 };
      }
      case 'flyover':
        return { s: startS + t * 14, lateral: 0, camYaw: 0, camPitch: 0.62, camDist: 26, camHeight: 6 };
      default:
        return { s: startS, lateral: 0, camYaw: 0.4, camPitch: 0.3, camDist: 5.8 };
    }
  };
}

export function scenario(partial: Partial<Scenario> & Pick<Scenario, 'id' | 'arch'>): Scenario {
  return {
    label: partial.id,
    density: 1,
    stress: { ...ALL_OFF_STRESS },
    script: 'trail-run',
    frames: 600,
    warmup: 90,
    coldStart: true,
    instrumentation: true,
    timeOfDay: 16.2,
    startS: 40,
    group: 'compare',
    ...partial,
  } as Scenario;
}

export const SUITES: Record<string, { label: string; description: string; build: (opts: SuiteOptions) => Scenario[] }> = {
  compare: {
    label: 'A / A2 / B / C comparison',
    description: 'Same world, same scripted trail run (600 frames @ fixed 1/60 s), cold start, each architecture.',
    build: (o) => (['A', 'A2', 'B', 'C'] as ArchId[]).map((a) => scenario({ id: `${a}-trail`, label: `${PRESETS[a as 'A'].label} · trail run`, arch: a, density: o.density, frames: o.frames, group: 'compare' })),
  },
  sweep: {
    label: 'Camera direction sweep',
    description: 'Fixed position, camera orbits 360°. Measures how cost depends on view direction (A2 vs C).',
    build: (o) => (['A2', 'C'] as ArchId[]).map((a) => scenario({ id: `${a}-sweep`, label: `${PRESETS[a as 'A'].label} · 360° sweep`, arch: a, script: 'yaw-sweep', density: o.density, frames: o.frames, group: 'sweep' })),
  },
  static: {
    label: 'Static camera (cache effectiveness)',
    description: 'Camera does not move. Shows query-cache / assembly-skip benefit and the conventional per-frame traversal cost.',
    build: (o) => (['A', 'A2', 'C'] as ArchId[]).map((a) => scenario({ id: `${a}-static`, label: `${PRESETS[a as 'A'].label} · static`, arch: a, script: 'static', density: o.density, frames: Math.min(o.frames, 400), group: 'static' })),
  },
  ablation: {
    label: 'Ablation (C minus one optimization)',
    description: 'C with each optimization disabled in turn, to attribute savings.',
    build: (o) => {
      const base = { ...PRESETS.C };
      const off: Array<[string, Partial<ArchFlags>]> = [
        ['C (all on)', {}],
        ['C − transform cache', { transformCache: false }],
        ['C − spatial index', { spatialIndex: false }],
        ['C − query cache', { queryCache: false }],
        ['C − geometry cache', { geometryCache: false }],
        ['C − instance cache', { instanceCache: false }],
        ['C − prefetch', { prefetch: false }],
      ];
      return off.map(([label, f]) => scenario({ id: `ablation-${label}`, label, arch: 'custom', flags: { ...base, ...f }, density: o.density, frames: o.frames, group: 'ablation' }));
    },
  },
  overhead: {
    label: 'Instrumentation overhead',
    description: 'C with the per-subsystem profiler on vs off (the whole-frame timer stays on in both).',
    build: (o) => [
      scenario({ id: 'C-instr-on', label: 'C · instrumentation ON', arch: 'C', instrumentation: true, density: o.density, frames: o.frames, group: 'overhead' }),
      scenario({ id: 'C-instr-off', label: 'C · instrumentation OFF', arch: 'C', instrumentation: false, density: o.density, frames: o.frames, group: 'overhead' }),
    ],
  },
  stress: {
    label: 'D · Stress (progressive entity counts)',
    description: 'Each step adds off-camera trees, tall shadow casters and extra lights; 360° camera sweep at dusk.',
    build: (o) => {
      const out: Scenario[] = [];
      o.stressSteps.forEach((extra, i) => {
        for (const a of o.stressArchs) {
          out.push(scenario({
            id: `D${i}-${a}`, label: `D step ${i} (+${extra} trees) · ${a}`, arch: a, script: 'yaw-sweep', density: o.density,
            stress: { extraTrees: extra, tallCasters: 150 * (i + 1), extraLights: 60 * (i + 1) }, timeOfDay: 18.2,
            frames: Math.min(o.frames, 480), group: 'stress',
          }));
        }
      });
      return out;
    },
  },
};

export interface SuiteOptions {
  density: number;
  frames: number;
  stressSteps: number[];
  stressArchs: ArchId[];
  /** Also call performance.measureUserAgentSpecificMemory() after each scenario (slow: waits for a GC). */
  preciseMemory?: boolean;
}

/** Browser-reported total memory via measureUserAgentSpecificMemory (null when unavailable or timed out). */
export async function measureUAMemory(timeoutMs = 25000): Promise<number | null> {
  const p = performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
  if (typeof p.measureUserAgentSpecificMemory !== 'function' || !(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) return null;
  try {
    const r = await Promise.race([p.measureUserAgentSpecificMemory(), new Promise<null>((res) => setTimeout(() => res(null), timeoutMs))]);
    return r ? r.bytes / 1048576 : null;
  } catch {
    return null;
  }
}

export class BenchmarkRunner {
  running = false;
  cancelled = false;
  results: ScenarioResult[] = [];
  onProgress: ((msg: string, frac: number) => void) | null = null;
  private frameWaiters: Array<{ remaining: number; resolve: () => void }> = [];

  constructor(private engine: Engine, private deviceReport: () => unknown) {}

  /** Called by the main loop after every engine tick. */
  frameDone(): void {
    for (let i = this.frameWaiters.length - 1; i >= 0; i--) {
      const w = this.frameWaiters[i];
      if (--w.remaining <= 0) { this.frameWaiters.splice(i, 1); w.resolve(); }
    }
  }

  private frames(n: number): Promise<void> {
    return new Promise((resolve) => this.frameWaiters.push({ remaining: n, resolve }));
  }

  preciseMemory = false;

  async runSuite(scenarios: Scenario[]): Promise<ScenarioResult[]> {
    if (this.running) return [];
    this.running = true;
    this.cancelled = false;
    const E = this.engine;
    const saved = {
      arch: E.arch, flags: { ...E.flags }, tod: E.lighting.timeOfDay, world: { ...E.worldCfg, stress: { ...E.worldCfg.stress } },
      instr: profiler.enabled, debug: E.debugUpdate,
    };
    const out: ScenarioResult[] = [];
    try {
      for (let i = 0; i < scenarios.length && !this.cancelled; i++) {
        const sc = scenarios[i];
        this.onProgress?.(`(${i + 1}/${scenarios.length}) preparing ${sc.label}`, i / scenarios.length);
        const r = await this.runScenario(sc, (f) => this.onProgress?.(`(${i + 1}/${scenarios.length}) ${sc.label}`, (i + f) / scenarios.length));
        if (r) { out.push(r); this.results.push(r); }
      }
    } finally {
      E.script = null;
      E.fixedDt = null;
      E.benchmarkActive = false;
      profiler.enabled = saved.instr;
      E.lighting.timeOfDay = saved.tod;
      const w = E.worldCfg;
      if (w.density !== saved.world.density || JSON.stringify(w.stress) !== JSON.stringify(saved.world.stress)) {
        E.loadWorld(saved.world);
      }
      await E.setArchitecture(saved.arch, saved.flags);
      E.placeOnTrail(40);
      E.debugUpdate = saved.debug;
      this.running = false;
      this.onProgress?.(this.cancelled ? 'cancelled' : 'done', 1);
    }
    return out;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private async runScenario(sc: Scenario, progress: (f: number) => void): Promise<ScenarioResult | null> {
    const E = this.engine;
    const notes: string[] = [];
    E.benchmarkActive = true;
    E.debugUpdate = null;
    // world
    let worldBuildMs = 0;
    const cfg: WorldConfig = { ...DEFAULT_WORLD, density: sc.density, stress: { ...sc.stress } };
    const cur = E.worldCfg;
    if (cur.density !== cfg.density || JSON.stringify(cur.stress) !== JSON.stringify(cfg.stress) || cur.seed !== cfg.seed) {
      E.loadWorld(cfg);
      worldBuildMs = E.world.buildMs;
      await this.frames(2);
    }
    // architecture
    const t0 = performance.now();
    await E.setArchitecture(sc.arch, sc.flags);
    const conventionalBuildMs = E.flags.presenter !== 'relational' ? (E.conventionalStats?.buildMs ?? performance.now() - t0) : null;
    E.lighting.timeOfDay = sc.timeOfDay;
    profiler.enabled = sc.instrumentation;
    E.fixedDt = 1 / 60;
    E.script = makeScript(sc.script, sc.startS, sc.frames);
    if (sc.coldStart) E.coldReset();
    // let a GC opportunity pass between scenarios
    await new Promise((r) => setTimeout(r, 250));
    // ---- warm-up (recorded separately)
    E.stats.reset();
    const genBefore = E.store.generatedTotal;
    await this.frames(sc.warmup);
    const warm = phaseSummary(E.stats);
    const warmGenerated = E.store.generatedTotal - genBefore;
    // ---- measured phase
    E.stats.reset();
    E.perf.reset();
    E.perf.sampleHeap();
    const heapStart = E.perf.heapAvailable ? E.perf.heapUsedMB : null;
    let heapPeak = heapStart ?? NaN;
    const genStart = E.store.generatedTotal, genMsStart = E.store.generatedMsTotal;
    const hitsStart = E.store.hitsTotal, missStart = E.store.missesTotal, evStart = E.store.evictedTotal, dispStart = E.store.disposedTotal;
    const wall0 = performance.now();
    const chunk = 30;
    for (let done = 0; done < sc.frames && !this.cancelled; done += chunk) {
      await this.frames(Math.min(chunk, sc.frames - done));
      E.perf.sampleHeap();
      if (E.perf.heapAvailable) heapPeak = Math.max(heapPeak, E.perf.heapUsedMB);
      progress(Math.min(1, (done + chunk) / sc.frames));
    }
    if (this.cancelled) return null;
    const wallMs = performance.now() - wall0;
    // allow late GPU timer results to land
    await this.frames(4);
    const st = E.stats;
    const series = (field: number) => {
      // oldest-first values of the measured phase (exclude the trailing 4 frames)
      const arr: number[] = [];
      for (let k = st.size - 1; k >= 4; k--) arr.push(st.get(k, field));
      return arr.slice(0, sc.frames);
    };
    const interval = series(F.interval);
    const cpu = series(F.cpu);
    const gpu = series(F.gpu);
    const draws = series(F.draws);
    const tris = series(F.tris);
    const mean = (a: number[]) => { let s = 0, c = 0; for (const v of a) if (Number.isFinite(v)) { s += v; c++; } return c ? s / c : NaN; };
    const intSum = summarize(interval);
    const scopesMean: Record<string, number> = {};
    const scopesP95: Record<string, number> = {};
    if (sc.instrumentation) {
      for (let s = 0; s < Scope.COUNT; s++) {
        const v = series(SCOPE_OFFSET + s);
        const sm = summarize(v);
        const name = SCOPE_NAMES[s] + (CROSS_CUTTING.has(s) ? ' (nested)' : '');
        scopesMean[name] = round(sm.mean, 4);
        scopesP95[name] = round(sm.p95, 4);
      }
    } else {
      scopesMean[SCOPE_NAMES[Scope.Frame]] = round(mean(cpu), 4);
      notes.push('Per-subsystem profiler disabled for this run (overhead measurement); only whole-frame JS time recorded.');
    }
    const qh = series(F.qHits), qm = series(F.qMiss);
    const qhs = qh.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0), qms = qm.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const unresolved = series(F.unresolved);
    const refreshMs = E.stats.refreshIntervalMs;
    const vsyncLimited = Number.isFinite(refreshMs) && intSum.median < refreshMs * 1.15 && intSum.median > refreshMs * 0.85;
    if (vsyncLimited) notes.push(`Median frame interval ≈ display refresh (${refreshMs.toFixed(2)} ms): frame rate is vsync-capped; compare JS/GPU time instead of FPS.`);
    const gpuSum = summarize(gpu);
    if (!E.gpu.available) notes.push(`GPU time unavailable: ${E.gpu.reason}.`);
    if (E.flags.presenter !== 'relational') notes.push('Conventional path: visible/shadow-only counts are not produced (Three.js culls internally).');
    E.perf.sampleHeap();
    const heapEnd = E.perf.heapAvailable ? E.perf.heapUsedMB : null;
    if (heapStart !== null && heapEnd !== null && heapStart === heapEnd && heapEnd === heapPeak) {
      notes.push('performance.memory did not change during the run: Chromium quantizes and caches this value (launch with --enable-precise-memory-info, or enable precise memory measurement). Treat browserHeap* as unreliable for this run.');
    }
    let uaMem: number | null = null;
    if (this.preciseMemory) {
      E.paused = true; // keep the scenario state while waiting for the browser's memory measurement
      uaMem = await measureUAMemory();
      E.paused = false;
      if (uaMem === null) notes.push('measureUserAgentSpecificMemory unavailable (needs cross-origin isolation, Chromium) or timed out.');
    }
    // yaw sectors
    let yawSectors: ScenarioResult['yawSectors'];
    if (sc.script === 'yaw-sweep') {
      const sectors = 8;
      const vis = series(F.visible), sho = series(F.shadowOnly);
      yawSectors = [];
      for (let k = 0; k < sectors; k++) {
        const idx: number[] = [];
        for (let i = 0; i < cpu.length; i++) if (Math.floor((i / cpu.length) * sectors) === k) idx.push(i);
        const pick = (a: number[]) => mean(idx.map((i) => a[i]));
        yawSectors.push({ sectorDeg: k * (360 / sectors), cpuMean: round(pick(cpu), 3), drawsMean: round(pick(draws), 1), trianglesMean: Math.round(pick(tris)), visibleMean: round(pick(vis), 1), shadowOnlyMean: round(pick(sho), 1) });
      }
    }
    const result: ScenarioResult = {
      scenario: sc,
      archLabel: sc.arch === 'custom' ? sc.label : PRESETS[sc.arch].label,
      startedAt: new Date().toISOString(),
      wallMs: round(wallMs, 1),
      frames: interval.length,
      entityCount: E.world.db.count,
      relationshipCount: E.world.db.relationshipCount(),
      worldBuildMs: round(worldBuildMs, 1),
      conventionalBuildMs: conventionalBuildMs !== null ? round(conventionalBuildMs, 1) : null,
      interval: roundSummary(intSum),
      fpsMean: round(mean(interval.map((v) => 1000 / v)), 2),
      fpsFromMeanInterval: round(1000 / intSum.mean, 2),
      onePercentLowFps: round(onePercentLow(interval), 2),
      cpu: roundSummary(summarize(cpu)),
      gpu: { ...roundSummary(gpuSum), available: E.gpu.available, reason: E.gpu.reason },
      scopesMean, scopesP95,
      draws: roundSummary(summarize(draws)),
      triangles: roundSummary(summarize(tris)),
      visibleMean: round(mean(series(F.visible)), 1),
      shadowOnlyMean: round(mean(series(F.shadowOnly)), 1),
      unresolvedMean: round(mean(unresolved), 2),
      unresolvedFramesPct: round((unresolved.filter((v) => v > 0).length / Math.max(1, unresolved.length)) * 100, 1),
      queriesPerFrame: round(mean(series(F.queries)), 2),
      queryCacheHitRate: qhs + qms > 0 ? round(qhs / (qhs + qms), 4) : NaN,
      geometryGenerated: E.store.generatedTotal - genStart,
      geometryGenMsTotal: round(E.store.generatedMsTotal - genMsStart, 2),
      geometryCacheHits: E.store.hitsTotal - hitsStart,
      geometryCacheMisses: E.store.missesTotal - missStart,
      geometryEvicted: E.store.evictedTotal - evStart,
      geometryDisposed: E.store.disposedTotal - dispStart,
      resolveCallsPerFrame: round(mean(series(F.resolveCalls)), 1),
      resolveRecomputesPerFrame: round(mean(series(F.resolveRecomputes)), 1),
      instancesPerFrame: round(mean(series(F.instances)), 1),
      uploadKBPerFrame: round(mean(series(F.uploadKB)), 2),
      longFrames: interval.filter((v) => v > 50).length,
      delayedFrames: Number.isFinite(refreshMs) ? interval.filter((v) => v > refreshMs * 1.5).length : NaN,
      vsyncLimited,
      memory: {
        uaSpecificMemoryMB: uaMem !== null ? round(uaMem, 2) : null,
        browserHeapStartMB: heapStart !== null ? round(heapStart, 1) : null,
        browserHeapEndMB: heapEnd !== null ? round(heapEnd, 1) : null,
        browserHeapPeakMB: E.perf.heapAvailable ? round(heapPeak, 1) : null,
        estimates: memoryEstimates(E),
      },
      warmupPhase: { frames: sc.warmup, cpuMean: round(warm.cpuMean, 3), cpuMax: round(warm.cpuMax, 3), geometryGenerated: warmGenerated, unresolvedMean: round(warm.unresolvedMean, 2) },
      yawSectors,
      samples: { interval: interval.map((v) => round(v, 3)), cpu: cpu.map((v) => round(v, 3)), gpu: gpu.map((v) => round(v, 3)), draws, triangles: tris },
      notes,
    };
    if (E.perf.heapAvailable === false) notes.push('JS heap not exposed by this browser (performance.memory unavailable).');
    return result;
  }

  exportJSON(): string {
    return JSON.stringify({
      generator: 'Relational World Engine benchmark',
      exportedAt: new Date().toISOString(),
      methodology: {
        fixedStep: '1/60 s simulation step per rendered frame (deterministic camera path)',
        timers: 'performance.now() around JS blocks; rAF timestamps for frame intervals; GPU via EXT_disjoint_timer_query_webgl2 when exposed',
        estimates: 'All byte counts under memory.estimates are computed from allocated typed-array sizes; GPU-resident sizes are assumed equal to uploaded sizes (estimate). browserHeap* values are browser-reported (Chromium only).',
      },
      device: this.deviceReport(),
      results: this.results,
    }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2);
  }

  clear(): void {
    this.results = [];
  }
}

function phaseSummary(st: FrameStats): { cpuMean: number; cpuMax: number; unresolvedMean: number } {
  let s = 0, mx = 0, u = 0, c = 0;
  for (let k = 0; k < st.size; k++) {
    const v = st.get(k, F.cpu);
    if (Number.isFinite(v)) { s += v; mx = Math.max(mx, v); c++; }
    const un = st.get(k, F.unresolved);
    if (Number.isFinite(un)) u += un;
  }
  return { cpuMean: c ? s / c : NaN, cpuMax: mx, unresolvedMean: c ? u / c : NaN };
}

export function memoryEstimates(E: Engine): Record<string, number> {
  const w = E.world;
  const rel = E.relational.stats();
  const [bw, bh] = E.stage.drawingBufferSize;
  const sm = E.stage.shadowMapSize;
  const MB = 1048576;
  const est: Record<string, number> = {
    'worldDatabase.exactMB': w.db.storageBytes() / MB,
    'frameCache.exactMB': w.frames.cacheBytes() / MB,
    'spatialIndex.exactMB': E.index.bytes() / MB,
    'queryCache.approxMB': E.qcache.bytes() / MB,
    'generatedGeometry.cpuExactMB': E.store.totalBytes / MB,
    'conventionalGeometry.cpuExactMB': (E.conventionalStats?.geometryBytes ?? 0) / MB,
    'conventionalInstances.cpuExactMB': (E.conventionalStats?.instanceBytes ?? 0) / MB,
    'presentationInstanceBuffers.exactMB': E.relational.instanceBufferBytes() / MB,
    'instanceTransformCache.exactMB': rel.instanceCacheBytes / MB,
    'gpuGeometry.estimateMB': (E.store.totalBytes + (E.conventionalStats?.geometryBytes ?? 0) + (E.conventionalStats?.instanceBytes ?? 0) + E.relational.instanceBufferBytes()) / MB,
    'shadowMap.estimateMB': (sm * sm * 4) / MB,
    'drawingBuffer.estimateMB': (bw * bh * 8) / MB,
  };
  for (const k of Object.keys(est)) est[k] = round(est[k], 3);
  return est;
}

function round(v: number, d: number): number {
  if (!Number.isFinite(v)) return v;
  const k = Math.pow(10, d);
  return Math.round(v * k) / k;
}

function roundSummary(s: Summary): Summary {
  return { n: s.n, mean: round(s.mean, 4), median: round(s.median, 4), min: round(s.min, 4), max: round(s.max, 4), p95: round(s.p95, 4), p99: round(s.p99, 4), std: round(s.std, 4), variance: round(s.variance, 4) };
}
