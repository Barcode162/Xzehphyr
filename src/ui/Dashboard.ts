/**
 * Diagnostics dashboard + developer/mode/benchmark panels.
 * Text updates run at ~4 Hz, graphs at ~8 Hz; the dashboard's own cost is
 * measured and shown (it runs outside the engine frame timer).
 */
import { Engine, ArchId, PRESETS, ArchFlags } from '../engine/Engine';
import { DebugViz, TOGGLE_LABELS, DebugToggles } from '../debug/DebugViz';
import { BenchmarkRunner, SUITES, ScenarioResult, SuiteOptions } from '../bench/Benchmark';
import { memoryEstimates, measureUAMemory } from '../bench/Benchmark';
import { profiler, Scope, SCOPE_NAMES, CROSS_CUTTING, counters } from '../diagnostics/Profiler';
import { F, SCOPE_OFFSET, summarize, onePercentLow } from '../diagnostics/FrameStats';
import { DeviceReport } from '../diagnostics/DeviceInfo';
import { shareOrDownload, copyText, stamp } from '../diagnostics/Export';
import { drawGraph, drawBars, GraphSeries } from './Graph';
import { Kind } from '../world/types';

const TABS = ['Live', 'Systems', 'Memory', 'GPU', 'Device', 'APIs', 'World', 'Dev', 'Mode', 'Bench', 'Export'] as const;
type Tab = typeof TABS[number];

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const fmtInt = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : 'n/a');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Dashboard {
  private panel: HTMLElement;
  private body: HTMLElement;
  private hud: HTMLElement;
  private tab: Tab = 'Live';
  private open = false;
  private lastText = 0;
  private lastGraph = 0;
  private graphBuf = { interval: new Float64Array(600), cpu: new Float64Array(600), gpu: new Float64Array(600) };
  uiCostMs = 0;
  private pairCost = NaN;
  device: DeviceReport | null = null;
  private benchSuite = 'compare';
  private benchOpts: SuiteOptions = { density: 1, frames: 600, stressSteps: [0, 15000, 40000], stressArchs: ['A2', 'C'] };
  private lastSuite: string | null = null;
  private benchMsg = '';
  private benchFrac = 0;
  private expanded = false;

  constructor(private engine: Engine, private debug: DebugViz, private bench: BenchmarkRunner) {
    this.panel = document.getElementById('panel')!;
    this.body = document.getElementById('panel-body')!;
    this.hud = document.getElementById('hud')!;
    const tabs = document.getElementById('panel-tabs')!;
    tabs.innerHTML = TABS.map((t) => `<button data-tab="${t}" class="${t === this.tab ? 'active' : ''}">${t}</button>`).join('');
    tabs.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).dataset.tab as Tab | undefined;
      if (t) this.show(t);
    });
    document.getElementById('panel-close')!.addEventListener('click', () => this.toggle(false));
    this.hud.addEventListener('click', () => { this.expanded = !this.expanded; });
    bench.onProgress = (msg, frac) => { this.benchMsg = msg; this.benchFrac = frac; if (this.tab === 'Bench') this.renderStatic(); };
    this.pairCost = profiler.measurePairCost();
  }

  toggle(force?: boolean, tab?: Tab): void {
    this.open = force ?? !this.open;
    this.panel.classList.toggle('hidden', !this.open);
    if (tab) this.show(tab);
    else if (this.open) this.renderStatic();
  }

  show(t: Tab): void {
    this.tab = t;
    for (const b of Array.from(document.querySelectorAll('#panel-tabs button'))) b.classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    if (!this.open) this.toggle(true);
    this.renderStatic();
  }

  get isOpen(): boolean { return this.open; }

  // ------------------------------------------------------------------ periodic update
  update(now: number): void {
    const t0 = performance.now();
    if (now - this.lastText > 250) {
      this.lastText = now;
      this.engine.perf.sampleHeap();
      this.updateHud();
      if (this.open) this.updateLive();
    }
    if (this.open && now - this.lastGraph > 120 && (this.tab === 'Live')) {
      this.lastGraph = now;
      this.drawLiveGraph();
    }
    this.uiCostMs = this.uiCostMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  private recent(field: number, n: number): number[] {
    const st = this.engine.stats;
    const out: number[] = [];
    for (let k = 0; k < Math.min(n, st.size); k++) out.push(st.get(k, field));
    return out;
  }

  private updateHud(): void {
    const E = this.engine;
    const iv = summarize(this.recent(F.interval, 60));
    const cpu = summarize(this.recent(F.cpu, 60));
    const gpu = summarize(this.recent(F.gpu, 60));
    const fps = 1000 / iv.mean;
    const gpuTxt = E.gpu.available || Number.isFinite(E.webgpuTimestampMs) ? `${fmt(gpu.mean)}ms` : 'n/a';
    const mode = E.arch === 'custom' ? 'custom' : E.arch;
    let html = `<b>${fmt(fps, 0)}</b> fps · ${fmt(iv.mean, 1)}ms · JS ${fmt(cpu.mean, 2)} · GPU ${gpuTxt}<br>` +
      `<span class="mode m-${mode}">${mode}</span> draws ${E.renderInfo.calls} · tris ${fmtInt(E.renderInfo.triangles)}`;
    if (this.expanded) {
      html += `<br>vis ${counters.visible} · shadow-only ${counters.shadowOnly} · unresolved ${counters.unresolved}` +
        `<br>frame: ${esc(E.playerFrameDescription())}`;
    }
    if (this.bench.running) html += `<br><span class="warn">BENCH ${Math.round(this.benchFrac * 100)}% ${esc(this.benchMsg)}</span>`;
    this.hud.innerHTML = html;
  }

  private drawLiveGraph(): void {
    const c = document.getElementById('graph-frame') as HTMLCanvasElement | null;
    if (!c) return;
    const st = this.engine.stats;
    const n = Math.min(300, st.size);
    st.series(F.interval, n, this.graphBuf.interval);
    st.series(F.cpu, n, this.graphBuf.cpu);
    st.series(F.gpu, n, this.graphBuf.gpu);
    const max = Math.max(20, Math.min(100, summarize(this.graphBuf.interval, n).p99 * 1.2));
    const series: GraphSeries[] = [
      { color: '#e8edf2', values: this.graphBuf.interval, count: n, label: 'frame interval' },
      { color: '#ff9f43', values: this.graphBuf.cpu, count: n, label: 'JS' },
    ];
    if (this.engine.gpu.available) series.push({ color: '#2ee59d', values: this.graphBuf.gpu, count: n, label: 'GPU' });
    drawGraph(c, series, max, [8.33, 16.67, 33.33]);
    const c2 = document.getElementById('graph-sub') as HTMLCanvasElement | null;
    if (c2) {
      const rows = this.subsystemRows(120);
      drawBars(c2, rows, 'ms');
    }
  }

  private subsystemRows(n: number): Array<{ label: string; value: number; color: string }> {
    const rows: Array<{ label: string; value: number; color: string }> = [];
    for (let s = 1; s < Scope.COUNT; s++) {
      const v = summarize(this.recent(SCOPE_OFFSET + s, n)).mean;
      if (!Number.isFinite(v) || v === 0) continue;
      rows.push({ label: SCOPE_NAMES[s] + (CROSS_CUTTING.has(s) ? ' ⊂' : ''), value: v, color: CROSS_CUTTING.has(s) ? '#6c8cff' : '#ff9f43' });
    }
    rows.sort((a, b) => b.value - a.value);
    return rows;
  }

  private set(id: string, html: string): void {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  private updateLive(): void {
    const E = this.engine;
    const st = E.stats;
    switch (this.tab) {
      case 'Live': {
        const iv = summarize(this.recent(F.interval, 120));
        const cpu = summarize(this.recent(F.cpu, 120));
        const gpu = summarize(this.recent(F.gpu, 120));
        const low = onePercentLow(this.recent(F.interval, 1000));
        this.set('live-kpis', kv([
          ['FPS (mean interval, 120f)', fmt(1000 / iv.mean, 1), 'measured'],
          ['Frame time avg / min / max', `${fmt(iv.mean)} / ${fmt(iv.min)} / ${fmt(iv.max)} ms`, 'measured (rAF)'],
          ['Frame time p95 / p99', `${fmt(iv.p95)} / ${fmt(iv.p99)} ms`, 'measured'],
          ['Std dev / variance', `${fmt(iv.std)} ms / ${fmt(iv.variance)} ms²`, 'measured'],
          ['1% low FPS (last 1000f)', Number.isFinite(low) ? fmt(low, 1) : 'needs ≥100 frames', 'measured'],
          ['Long frames (>50 ms)', `${st.longFrames}`, 'measured'],
          ['Delayed frames (>1.5× refresh)', Number.isFinite(st.refreshIntervalMs) ? `${st.delayedFrames}` : 'refresh unknown', 'inferred from rAF'],
          ['JS frame time avg / p95', `${fmt(cpu.mean, 3)} / ${fmt(cpu.p95, 3)} ms`, 'measured'],
          ['GPU frame time', E.gpu.available ? `${fmt(gpu.mean, 3)} ms (${E.gpu.resolved} results, ${E.gpu.disjointCount} disjoint, ${E.gpu.rejected} rejected)` : Number.isFinite(E.webgpuTimestampMs) ? `${fmt(gpu.mean, 3)} ms (WebGPU timestamp-query, experimental)` : `unavailable — ${E.gpu.reason}`, E.gpu.available || Number.isFinite(E.webgpuTimestampMs) ? 'measured (GPU timer)' : '—'],
          ['Render submit (CPU, not GPU)', `${fmt(summarize(this.recent(SCOPE_OFFSET + Scope.RenderSubmit, 120)).mean, 3)} ms`, 'measured'],
          ['Draw calls / triangles', `${E.renderInfo.calls} / ${fmtInt(E.renderInfo.triangles)}`, 'renderer counters'],
          ['Visible / shadow-only / unresolved', E.flags.presenter === 'relational' ? `${counters.visible} / ${counters.shadowOnly} / ${counters.unresolved}` : 'n/a (Three.js culls internally)', 'exact'],
          ['Long tasks / LoAF (observer)', E.perf.supported.includes('longtask') || E.perf.supported.includes('long-animation-frame') ? `${E.perf.longTasks} / ${E.perf.longAnimFrames}` : 'not supported by browser', 'PerformanceObserver'],
          ['Dashboard UI cost', `${fmt(this.uiCostMs, 3)} ms per update (outside frame timer)`, 'measured'],
        ]));
        break;
      }
      case 'Systems': {
        const n = 120;
        const sc = (s: Scope) => summarize(this.recent(SCOPE_OFFSET + s, n)).mean;
        const rows: Array<[string, string, string]> = [];
        for (let s = 0; s < Scope.COUNT; s++) rows.push([SCOPE_NAMES[s] + (CROSS_CUTTING.has(s) ? ' (nested)' : ''), profiler.enabled ? `${fmt(sc(s), 4)} ms` : (s === 0 ? `${fmt(sc(s), 4)} ms` : 'profiler off'), 'measured']);
        this.set('sys-scopes', kv(rows));
        const qh = sum(this.recent(F.qHits, n)), qm = sum(this.recent(F.qMiss, n));
        const fs = E.world.frames.stats;
        const overheadEst = this.pairCost * profiler.calls;
        this.set('sys-counters', kv([
          ['World queries / frame', fmt(mean(this.recent(F.queries, n)), 1), 'exact'],
          ['Index nodes visited / objects tested', `${counters.queryNodes} / ${counters.queryTests}`, 'exact (this frame)'],
          ['Query cache hit rate', qh + qm > 0 ? `${fmt((qh / (qh + qm)) * 100, 1)} % (${qh}/${qh + qm})` : 'n/a', 'exact'],
          ['Reference resolutions / recomputes', `${fs.calls} / ${fs.recomputes} (chain steps ${fs.chainSteps})`, 'exact (this frame)'],
          ['Transform cache', E.world.frames.caching ? `hit ${fmt((fs.hits / Math.max(1, fs.calls)) * 100, 1)} %` : 'disabled', 'exact'],
          ['Geometry generated / ms (this frame)', `${counters.geomGenerated} / ${fmt(counters.geomGenMs, 3)}`, 'measured'],
          ['Geometry hits / misses (lifetime)', `${E.store.hitsTotal} / ${E.store.missesTotal}`, 'exact'],
          ['Geometry evicted / disposed (lifetime)', `${E.store.evictedTotal} / ${E.store.disposedTotal}`, 'exact'],
          ['LOD fallbacks / unresolved', `${counters.lodFallbacks} / ${counters.unresolved}`, 'exact'],
          ['Assembly skipped (unchanged)', `${counters.assemblySkipped ? 'yes' : 'no'}`, 'exact'],
          ['Instances written / upload', `${counters.instancesWritten} / ${fmt(counters.uploadBytes / 1024, 1)} KB`, 'exact'],
          ['Terrain field evaluations', `${counters.terrainEvals}`, 'exact'],
          ['Collider candidates / audio sources / lights', `${counters.colliderCandidates} / ${counters.audioSources} / ${counters.lightsActive} of ${counters.lightsConsidered}`, 'exact'],
          ['Reference frame changes (lifetime)', `${E.physics.frameChanges}`, 'exact'],
          ['Timer resolution', `${fmt(profiler.timerResolutionMs * 1000, 1)} µs`, 'measured'],
          ['Profiler overhead', profiler.enabled ? `${profiler.calls} scope pairs × ${fmt(this.pairCost * 1000, 3)} µs ≈ ${fmt(overheadEst, 4)} ms` : 'profiler disabled', 'estimate (calibrated pair cost)'],
        ]));
        const c = document.getElementById('graph-sub2') as HTMLCanvasElement | null;
        if (c) drawBars(c, this.subsystemRows(n), 'ms');
        break;
      }
      case 'Memory': {
        const p = E.perf;
        const est = memoryEstimates(E);
        const rows: Array<[string, string, string]> = [
          ['JS heap used', p.heapAvailable ? `${fmt(p.heapUsedMB, 1)} MB` : 'not exposed by this browser', p.heapAvailable ? 'browser-reported' : '—'],
          ['JS heap total / limit', p.heapAvailable ? `${fmt(p.heapTotalMB, 1)} / ${fmt(p.heapLimitMB, 0)} MB` : 'not exposed', p.heapAvailable ? 'browser-reported' : '—'],
          ['GC events (heap drops >1MB)', p.heapAvailable ? `${p.inferredGCs} (≈${fmt(p.inferredGCFreedMB, 1)} MB freed)` : 'cannot observe', 'inferred'],
          ['Entities / relationships', `${E.world.db.count.toLocaleString()} / ${E.world.db.relationshipCount().toLocaleString()}`, 'exact'],
          ['Spatial index nodes (non-empty) / objects', `${E.index.nonEmptyNodes()} / ${E.index.objectCount}`, 'exact'],
          ['Geometry cache entries', `${E.store.entries.size}`, 'exact'],
          ['Query cache entries', `${E.qcache.size}`, 'exact'],
          ['Renderer geometries / textures / programs', `${E.renderInfo.geometries} / ${E.renderInfo.textures} / ${E.renderInfo.programs}`, 'renderer counters'],
        ];
        for (const [k, v] of Object.entries(est)) rows.push([k.replace(/\.(exactMB|estimateMB|approxMB|cpuExactMB)$/, ''), `${fmt(v, 3)} MB`, k.includes('estimate') ? 'estimate' : k.includes('approx') ? 'approximate' : 'exact (allocated bytes)']);
        this.set('mem-table', kv(rows));
        break;
      }
      case 'GPU': {
        const g = E.glInstr.last;
        const d = this.device?.webgl;
        this.set('gpu-table', kv([
          ['Backend', E.stage.backend === 'webgpu' ? 'WebGPU (experimental)' : 'WebGL', ''],
          ['Renderer / vendor', d ? `${esc(d.renderer)} / ${esc(d.vendor)}` : 'n/a', 'browser-reported'],
          ['Unmasked renderer', d?.unmaskedRenderer ? esc(d.unmaskedRenderer) : 'not exposed', 'browser-reported'],
          ['Draw calls (incl. shadow pass)', `${E.renderInfo.calls}`, 'renderer counter'],
          ['Triangles / points / lines', `${fmtInt(E.renderInfo.triangles)} / ${E.renderInfo.points} / ${E.renderInfo.lines}`, 'renderer counter'],
          ['Shader programs', `${E.renderInfo.programs}`, 'renderer counter'],
          ['Textures / geometries', `${E.renderInfo.textures} / ${E.renderInfo.geometries}`, 'renderer counter'],
          ['Render targets', `1 shadow map (${E.stage.shadowMapSize}²) + default framebuffer`, 'known configuration'],
          ['Drawing buffer', `${E.stage.drawingBufferSize.join('×')} px (pixel ratio ${fmt(E.stage.pixelRatio, 2)})`, 'exact'],
          ['GPU timing', E.gpu.available ? `${fmt(E.gpu.lastMs, 3)} ms (last), ${E.gpu.resolved} resolved, ${E.gpu.disjointCount} disjoint` : `unavailable: ${E.gpu.reason}`, E.gpu.available ? 'measured' : 'not measurable'],
          ['GL instrumentation', E.glInstr.active ? `draws ${g.drawCalls} (inst ${g.instancedDraws}, ${fmtInt(g.instances)} instances), programs ${g.useProgram}, uploads ${g.bufferUploads} (${fmt(g.bufferUploadBytes / 1024, 1)} KB), tex ${g.textureUploads}, fbo ${g.framebufferBinds}` : 'off (enable in Mode tab)', 'exact counts'],
          ['WebGPU', this.device ? (this.device.webgpu.available ? `available · ${this.device.webgpu.features.includes('timestamp-query') ? 'timestamp-query' : 'no timestamp-query'}` : esc(this.device.webgpu.error ?? 'no')) : '…', 'detected'],
        ]));
        break;
      }
      case 'World': {
        this.set('world-player', `Player reference frame: <b>${esc(E.playerFrameDescription())}</b><br>World position (derived): ${fmt(E.body.x, 1)}, ${fmt(E.body.y, 1)}, ${fmt(E.body.z, 1)} · surface: ${E.body.surface}${E.body.inWater ? ' (in water)' : ''}`);
        break;
      }
      case 'Bench': {
        const el = document.getElementById('bench-progress');
        if (el) el.textContent = this.bench.running ? `${Math.round(this.benchFrac * 100)} % — ${this.benchMsg}` : this.benchMsg;
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ static tab content
  renderStatic(): void {
    const E = this.engine;
    let html = '';
    switch (this.tab) {
      case 'Live':
        html = `<canvas id="graph-frame" class="graph"></canvas>
          <div class="legend">white: rAF frame interval · orange: JS frame time (measured) · green: GPU time (timer query, if exposed)</div>
          <div id="live-kpis"></div>
          <h4>Subsystem time (mean, last 120 frames)</h4><canvas id="graph-sub" class="bars"></canvas>
          <div class="legend">⊂ = nested/cross-cutting (already included in a parent system). All values: direct performance.now() measurements.</div>`;
        break;
      case 'Systems':
        html = `<h4>Subsystem timings (mean, last 120 frames)</h4><canvas id="graph-sub2" class="bars"></canvas><div id="sys-scopes"></div>
          <h4>Engine work counters</h4><div id="sys-counters"></div>`;
        break;
      case 'Memory':
        html = `<div class="legend">"browser-reported" values come from performance.memory (Chromium only; quantized and cached by the browser, may look static). "exact" = bytes of typed arrays this engine allocated. "estimate" = derived (e.g. GPU residency assumed equal to uploaded bytes).</div><div id="mem-table"></div>
          <div class="row"><button id="mem-precise">Measure precise memory (measureUserAgentSpecificMemory)</button></div><div id="mem-precise-out" class="legend"></div>`;
        break;
      case 'GPU':
        html = `<div class="legend">CPU render-submit time is <b>not</b> GPU execution time. GPU time is shown only when a timer-query extension is exposed.</div><div id="gpu-table"></div>
          <div class="row"><button id="btn-backend">${E.stage.backend === 'webgpu' ? 'Switch to WebGL (reload)' : 'Try experimental WebGPU backend (reload)'}</button></div>`;
        break;
      case 'Device':
        html = this.deviceHtml();
        break;
      case 'APIs':
        html = this.apisHtml();
        break;
      case 'World':
        html = this.worldHtml();
        break;
      case 'Dev':
        html = this.devHtml();
        break;
      case 'Mode':
        html = this.modeHtml();
        break;
      case 'Bench':
        html = this.benchHtml();
        break;
      case 'Export':
        html = `<div class="legend">Everything stays on this device. Files are generated locally and offered via download or the share sheet.</div>
          <div class="row"><button id="exp-csv">Performance samples (CSV)</button><button id="exp-json">Benchmark results (JSON)</button></div>
          <div class="row"><button id="exp-device">Device capability report (JSON)</button><button id="exp-copy">Copy last benchmark summary</button></div>
          <div class="row"><button id="exp-reset">Reset live statistics</button></div><div id="exp-msg" class="legend"></div>`;
        break;
    }
    this.body.innerHTML = html;
    this.bind();
    this.updateLive();
    if (this.tab === 'Live') this.drawLiveGraph();
  }

  private deviceHtml(): string {
    const d = this.device;
    if (!d) return 'Collecting…';
    return kv([
      ['Browser', esc(d.browser), 'parsed from UA'],
      ['OS', esc(d.os), 'parsed from UA'],
      ['User agent', `<span class="small">${esc(d.userAgent)}</span>`, 'browser-reported'],
      ['UA client hints', d.uaData ? `<span class="small">${esc(JSON.stringify(d.uaData))}</span>` : 'not exposed', 'browser-reported'],
      ['Screen', `${d.screen.width}×${d.screen.height} (avail ${d.screen.availWidth}×${d.screen.availHeight}), ${d.screen.colorDepth}-bit, ${d.screen.orientation}`, 'browser-reported'],
      ['Viewport', `${d.viewport.width}×${d.viewport.height} · visual ${d.viewport.visualViewport}`, 'browser-reported'],
      ['Device pixel ratio', `${d.devicePixelRatio}`, 'browser-reported'],
      ['Hardware concurrency', `${d.hardwareConcurrency ?? 'n/a'}`, 'browser-reported (may be capped)'],
      ['Device memory hint', d.deviceMemoryGB !== null ? `${d.deviceMemoryGB} GB` : 'not exposed', 'browser hint'],
      ['Touch', `${d.touch ? 'yes' : 'no'} (maxTouchPoints ${d.maxTouchPoints})`, 'browser-reported'],
      ['WebGL', d.webgl ? `${esc(d.webgl.version)} · ${esc(d.webgl.glslVersion)}` : 'n/a', 'browser-reported'],
      ['GPU strings', d.webgl ? `${esc(d.webgl.unmaskedRenderer ?? d.webgl.renderer)} / ${esc(d.webgl.unmaskedVendor ?? d.webgl.vendor)}` : 'n/a', 'browser-reported'],
      ['Limits', d.webgl ? `tex ${d.webgl.maxTextureSize}, rb ${d.webgl.maxRenderbufferSize}, attribs ${d.webgl.maxVertexAttribs}, samples ${d.webgl.maxSamples ?? 'n/a'}` : 'n/a', 'browser-reported'],
      ['WebGPU', d.webgpu.available ? `available: <span class="small">${esc(JSON.stringify(d.webgpu.adapter))}</span>` : esc(d.webgpu.error ?? 'no'), 'detected'],
      ['Refresh rate', d.refreshRateEstimateHz ? `${fmt(d.refreshRateEstimateHz, 1)} Hz` : 'n/a', 'estimate (rAF cadence)'],
      ['Timer resolution', `${fmt(d.timerResolutionMs * 1000, 1)} µs`, 'measured'],
      ['Cross-origin isolated', d.crossOriginIsolated ? 'yes' : 'no', 'browser-reported'],
      ['Extensions', `<span class="small">${d.webgl ? d.webgl.extensions.map(esc).join(', ') : 'n/a'}</span>`, 'browser-reported'],
    ]) + `<div class="row"><button id="exp-device2">Download device report</button></div>`;
  }

  private apisHtml(): string {
    const d = this.device;
    if (!d) return 'Collecting…';
    const rows = d.apis.map((a) => `<tr><td>${a.available ? '<span class="ok">●</span>' : '<span class="no">○</span>'} ${esc(a.name)}</td><td class="small">${esc(a.detail)}</td></tr>`).join('');
    const notes = d.iosNotes.length ? `<h4>iOS / Safari restrictions detected</h4><ul class="small">${d.iosNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<div class="legend">Not running on iOS/Safari. See README → Browser limitations for the iPhone-specific list.</div>';
    return `<table class="t">${rows}</table>${notes}`;
  }

  private worldHtml(): string {
    const E = this.engine;
    const w = E.world;
    const counts = w.db.countByKind();
    const rows = Object.entries(counts).map(([k, v]) => [k, v.toLocaleString(), ''] as [string, string, string]);
    const cfg = E.worldCfg;
    return `<div id="world-player" class="box"></div>` + kv([
      ['Entities', w.db.count.toLocaleString(), 'exact'],
      ['Relationships (typed + parent links)', w.db.relationshipCount().toLocaleString(), 'exact'],
      ['Reference frame depth (tree / bird)', `${w.db.depth(w.db.count > 200 ? findKind(w.db, Kind.Tree) : 0)} / ${w.db.depth(findKind(w.db, Kind.Bird))}`, 'exact'],
      ['Trail length / bridges / lanterns', `${w.trailCurve.length.toFixed(0)} m / ${w.bridges.length} / ${w.lanterns.length}`, 'exact'],
      ['World build time', `${w.buildMs.toFixed(1)} ms (data only, no geometry)`, 'measured'],
      ...rows,
    ]) + `<h4>World configuration</h4>
      <div class="row"><label>Density ×<input id="w-density" type="number" step="0.25" min="0.25" max="4" value="${cfg.density}"></label>
      <label>Extra trees <input id="w-extra" type="number" step="5000" min="0" max="200000" value="${cfg.stress.extraTrees}"></label></div>
      <div class="row"><label>Tall casters <input id="w-tall" type="number" step="50" min="0" max="5000" value="${cfg.stress.tallCasters}"></label>
      <label>Extra lights <input id="w-lights" type="number" step="20" min="0" max="2000" value="${cfg.stress.extraLights}"></label></div>
      <div class="row"><button id="w-rebuild">Rebuild world</button></div>`;
  }

  private devHtml(): string {
    const E = this.engine;
    const T = this.debug.toggles;
    const toggles = (Object.keys(TOGGLE_LABELS) as Array<keyof DebugToggles>).map((k) =>
      `<label class="chk"><input type="checkbox" data-dbg="${k}" ${T[k] ? 'checked' : ''}><span><b>${TOGGLE_LABELS[k][0]}</b><br><span class="small">${TOGGLE_LABELS[k][1]}</span></span></label>`).join('');
    return `<div class="row"><label class="chk"><input type="checkbox" id="dbg-on" ${this.debug.enabled ? 'checked' : ''}><b>Developer visualization</b></label>
      <label class="chk"><input type="checkbox" id="dbg-observer" ${E.stage.useObserver ? 'checked' : ''}><b>Observer (god) view</b></label></div>
      <div class="legend">Observer view renders from above while the <i>player camera</i> still drives every query — drag to orbit, move the runner and watch the requested set change.</div>
      ${toggles}
      <h4>Environment</h4>
      <div class="row"><label>Time of day <input id="dev-tod" type="range" min="0" max="24" step="0.05" value="${E.lighting.timeOfDay}"> <span id="dev-tod-v">${E.lighting.timeOfDay.toFixed(1)}h</span></label></div>
      <h4>Dependency invalidation demo</h4>
      <div class="row"><button id="dev-nudge">Nudge region ahead +2 m</button><button id="dev-unnudge">−2 m</button><button id="dev-trail">Back to trail start</button></div>
      <div class="legend">Moving a region frame re-resolves every descendant (trees re-ground on the terrain), re-indexes them and invalidates only cached queries touching that quadrant.</div>
      <h4>Quality</h4>
      <div class="row"><label>Render scale <select id="q-scale">${[0.5, 0.67, 0.75, 1].map((v) => `<option ${E.stage.renderScale === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Max DPR <select id="q-dpr">${[1, 1.5, 2, 3].map((v) => `<option ${E.stage.maxDpr === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Shadow map <select id="q-shadow">${[512, 1024, 2048, 4096].map((v) => `<option ${E.stage.shadowMapSize === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
      <div class="row"><label>LOD scale <input id="q-lod" type="number" min="0.4" max="2" step="0.05" value="${E.quality.lodScale}"></label>
      <label>Geometry budget ms <input id="q-budget" type="number" min="0.5" max="30" step="0.5" value="${E.quality.geomBudgetMs}"></label></div>`;
  }

  private modeHtml(): string {
    const E = this.engine;
    const archs: ArchId[] = ['A', 'A2', 'B', 'C'];
    const radios = archs.map((a) => `<label class="chk"><input type="radio" name="arch" value="${a}" ${E.arch === a ? 'checked' : ''}><span><b>${PRESETS[a as 'A'].label}</b><br><span class="small">${PRESETS[a as 'A'].description}</span></span></label>`).join('');
    const flagNames: Array<[keyof ArchFlags, string]> = [['transformCache', 'Cached reference resolution'], ['spatialIndex', 'Spatial index (else full scan)'], ['queryCache', 'Query result cache'], ['geometryCache', 'Geometry LRU cache (else keep-while-observed)'], ['instanceCache', 'Instance transform cache + skip unchanged assembly'], ['prefetch', 'Anticipatory generation of nearby terrain/water/grass (idle budget)']];
    const flags = flagNames.map(([k, l]) => `<label class="chk"><input type="checkbox" data-flag="${k}" ${E.flags[k] ? 'checked' : ''} ${E.flags.presenter !== 'relational' ? 'disabled' : ''}>${l}</label>`).join('');
    return `${radios}<h4>Relational flags (custom)</h4>${flags}
      <h4>Instrumentation</h4>
      <label class="chk"><input type="checkbox" id="m-prof" ${profiler.enabled ? 'checked' : ''}>Per-subsystem profiler (disable to measure its overhead)</label>
      <label class="chk"><input type="checkbox" id="m-gl" ${E.glInstr.active ? 'checked' : ''} ${E.webgl ? '' : 'disabled'}>WebGL call instrumentation (counts uploads/draws; adds overhead)</label>
      <label class="chk"><input type="checkbox" id="m-gpu" ${E.gpu.enabled ? 'checked' : ''} ${E.gpu.available ? '' : 'disabled'}>GPU timer queries ${E.gpu.available ? '' : '(unavailable)'}</label>
      <label class="chk"><input type="checkbox" id="m-audio" ${E.audio.enabled ? 'checked' : ''}>Audio output (${esc(E.audio.state)})</label>`;
  }

  private benchHtml(): string {
    const o = this.benchOpts;
    const suites = Object.entries(SUITES).map(([k, s]) => `<option value="${k}" ${k === this.benchSuite ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const desc = SUITES[this.benchSuite].description;
    return `<div class="row"><select id="b-suite">${suites}</select></div><div class="legend">${esc(desc)}</div>
      <div class="row"><label>Frames <input id="b-frames" type="number" min="120" max="1700" step="60" value="${o.frames}"></label>
      <label>Density × <input id="b-density" type="number" min="0.25" max="4" step="0.25" value="${o.density}"></label></div>
      <div class="row"><label class="chk"><input type="checkbox" id="b-umem" ${this.bench.preciseMemory ? 'checked' : ''}>Precise memory after each scenario (measureUserAgentSpecificMemory; Chromium + isolation; slow)</label></div>
      <div class="row"><label>D: extra trees per step <input id="b-steps" type="text" value="${o.stressSteps.join(',')}"></label>
      <label>D: architectures <input id="b-archs" type="text" value="${o.stressArchs.join(',')}"></label></div>
      <div class="row"><button id="b-run" ${this.bench.running ? 'disabled' : ''}>Run</button><button id="b-again" ${this.bench.running || !this.lastSuite ? 'disabled' : ''}>Run again</button>
      <button id="b-cancel" ${this.bench.running ? '' : 'disabled'}>Cancel</button><button id="b-reset">Reset results</button></div>
      <div id="bench-progress" class="legend">${esc(this.benchMsg)}</div>
      <div class="legend">Each scenario: fixed 1/60 s step, scripted trail-relative camera, cold caches, warm-up recorded separately. Keep the screen awake and the tab in the foreground. If FPS sits at the refresh rate, compare JS / GPU time.</div>
      ${resultsTable(this.bench.results)}`;
  }

  // ------------------------------------------------------------------ bindings
  private bind(): void {
    const E = this.engine;
    const on = (id: string, ev: string, fn: (e: Event) => void) => document.getElementById(id)?.addEventListener(ev, fn);
    on('mem-precise', 'click', async () => {
      this.set('mem-precise-out', 'Measuring (the browser waits for a garbage collection, up to ~20 s)…');
      const mb = await measureUAMemory();
      this.set('mem-precise-out', mb === null ? 'Unavailable: requires Chromium with cross-origin isolation (or timed out).' : `Total ${fmt(mb, 2)} MB (browser-reported, all JS realms of this page)`);
    });
    on('btn-backend', 'click', () => {
      const u = new URL(location.href);
      u.searchParams.set('backend', E.stage.backend === 'webgpu' ? 'webgl' : 'webgpu');
      location.href = u.toString();
    });
    // dev
    on('dbg-on', 'change', (e) => { this.debug.setEnabled((e.target as HTMLInputElement).checked); });
    on('dbg-observer', 'change', (e) => { E.stage.useObserver = (e.target as HTMLInputElement).checked; if (E.stage.useObserver && !this.debug.enabled) { this.debug.setEnabled(true); this.renderStatic(); } });
    for (const el of Array.from(document.querySelectorAll('[data-dbg]'))) {
      el.addEventListener('change', (e) => {
        const k = (e.target as HTMLElement).dataset.dbg as keyof DebugToggles;
        this.debug.toggles[k] = (e.target as HTMLInputElement).checked;
        if (!this.debug.enabled) this.debug.setEnabled(true);
        this.debug.rebind();
      });
    }
    on('dev-tod', 'input', (e) => { E.lighting.timeOfDay = +(e.target as HTMLInputElement).value; this.set('dev-tod-v', `${E.lighting.timeOfDay.toFixed(1)}h`); });
    on('dev-nudge', 'click', () => E.nudgeRegion(2));
    on('dev-unnudge', 'click', () => E.nudgeRegion(-2));
    on('dev-trail', 'click', () => E.placeOnTrail(40));
    on('q-scale', 'change', (e) => { E.stage.renderScale = +(e.target as HTMLSelectElement).value; E.stage.resize(); });
    on('q-dpr', 'change', (e) => { E.stage.maxDpr = +(e.target as HTMLSelectElement).value; E.stage.resize(); });
    on('q-shadow', 'change', (e) => { E.stage.setShadowMapSize(+(e.target as HTMLSelectElement).value); });
    on('q-lod', 'change', (e) => { E.quality.lodScale = +(e.target as HTMLInputElement).value; });
    on('q-budget', 'change', (e) => { E.quality.geomBudgetMs = +(e.target as HTMLInputElement).value; });
    // mode
    for (const el of Array.from(document.querySelectorAll('input[name="arch"]'))) {
      el.addEventListener('change', async (e) => {
        const v = (e.target as HTMLInputElement).value as ArchId;
        await E.setArchitecture(v);
        if (E.flags.presenter === 'relational') E.prewarm(400);
        this.renderStatic();
      });
    }
    for (const el of Array.from(document.querySelectorAll('[data-flag]'))) {
      el.addEventListener('change', async (e) => {
        const k = (e.target as HTMLElement).dataset.flag as keyof ArchFlags;
        await E.setArchitecture('custom', { [k]: (e.target as HTMLInputElement).checked } as Partial<ArchFlags>);
        this.renderStatic();
      });
    }
    on('m-prof', 'change', (e) => { profiler.enabled = (e.target as HTMLInputElement).checked; });
    on('m-gl', 'change', (e) => { if ((e.target as HTMLInputElement).checked) E.glInstr.enable(); else E.glInstr.disable(); });
    on('m-gpu', 'change', (e) => { E.gpu.enabled = (e.target as HTMLInputElement).checked; });
    on('m-audio', 'change', async (e) => { if ((e.target as HTMLInputElement).checked) await E.audio.enable(); else E.audio.disable(); this.renderStatic(); });
    // world
    on('w-rebuild', 'click', async () => {
      const val = (id: string) => +(document.getElementById(id) as HTMLInputElement).value;
      const cfg = { ...E.worldCfg, density: val('w-density'), stress: { extraTrees: val('w-extra'), tallCasters: val('w-tall'), extraLights: val('w-lights') } };
      E.loadWorld(cfg);
      this.debug.rebind();
      if (E.flags.presenter !== 'relational') { const a = E.arch; E.arch = 'C'; E.flags = { ...PRESETS.C }; await E.setArchitecture(a); }
      E.prewarm(400);
      this.renderStatic();
    });
    // bench
    on('b-suite', 'change', (e) => { this.benchSuite = (e.target as HTMLSelectElement).value; this.renderStatic(); });
    const readOpts = () => {
      const g = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
      this.benchOpts = {
        frames: Math.max(120, Math.min(1700, +g('b-frames') || 600)),
        density: Math.max(0.25, Math.min(4, +g('b-density') || 1)),
        stressSteps: g('b-steps').split(',').map((s) => Math.max(0, Math.round(+s))).filter((v) => Number.isFinite(v)),
        stressArchs: g('b-archs').split(',').map((s) => s.trim().toUpperCase()).filter((s) => ['A', 'A2', 'B', 'C'].includes(s)) as ArchId[],
      };
    };
    on('b-umem', 'change', (e) => { this.bench.preciseMemory = (e.target as HTMLInputElement).checked; });
    const run = async (suite: string) => {
      readOpts();
      this.lastSuite = suite;
      const list = SUITES[suite].build(this.benchOpts);
      this.debug.setEnabled(false);
      E.stage.useObserver = false;
      const p = this.bench.runSuite(list);
      this.renderStatic();
      await p;
      this.renderStatic();
    };
    on('b-run', 'click', () => void run(this.benchSuite));
    on('b-again', 'click', () => { if (this.lastSuite) void run(this.lastSuite); });
    on('b-cancel', 'click', () => this.bench.cancel());
    on('b-reset', 'click', () => { this.bench.clear(); this.benchMsg = ''; this.renderStatic(); });
    // export
    const msg = (t: string) => this.set('exp-msg', esc(t));
    on('exp-csv', 'click', async () => msg(`CSV: ${await shareOrDownload(`rwe-samples-${stamp()}.csv`, E.stats.toCSV(SCOPE_NAMES), 'text/csv')}`));
    on('exp-json', 'click', async () => msg(`JSON: ${await shareOrDownload(`rwe-benchmark-${stamp()}.json`, this.bench.exportJSON(), 'application/json')}`));
    const dev = async () => msg(`Device report: ${await shareOrDownload(`rwe-device-${stamp()}.json`, JSON.stringify(this.device, null, 2), 'application/json')}`);
    on('exp-device', 'click', dev);
    on('exp-device2', 'click', dev);
    on('exp-copy', 'click', async () => {
      const ok = await copyText(summaryText(this.bench.results));
      msg(ok ? 'Copied.' : 'Clipboard not available.');
    });
    on('exp-reset', 'click', () => { E.stats.reset(); E.perf.reset(); msg('Live statistics reset.'); });
  }
}

function kv(rows: Array<[string, string, string]>): string {
  return `<table class="t">${rows.map(([k, v, s]) => `<tr><td>${k}</td><td>${v}</td><td class="src">${s}</td></tr>`).join('')}</table>`;
}
function sum(a: number[]): number { let s = 0; for (const v of a) if (Number.isFinite(v)) s += v; return s; }
function mean(a: number[]): number { let s = 0, c = 0; for (const v of a) if (Number.isFinite(v)) { s += v; c++; } return c ? s / c : NaN; }
function findKind(db: { count: number; kind: Uint8Array }, k: Kind): number {
  for (let i = 0; i < db.count; i++) if (db.kind[i] === k) return i;
  return 0;
}

export function resultsTable(results: ScenarioResult[]): string {
  if (!results.length) return '<div class="legend">No results yet.</div>';
  const base = results[0];
  const rows = results.map((r) => {
    const d = (v: number, b: number) => (Number.isFinite(v) && Number.isFinite(b) && b !== 0 ? `${v >= b ? '+' : ''}${(((v - b) / b) * 100).toFixed(0)}%` : '');
    return `<tr>
      <td>${esc(r.scenario.label)}<br><span class="small">${r.entityCount.toLocaleString()} entities${r.vsyncLimited ? ' · vsync-capped' : ''}</span></td>
      <td>${fmt(r.fpsFromMeanInterval, 1)}<br><span class="small">1%: ${fmt(r.onePercentLowFps, 1)}</span></td>
      <td>${fmt(r.interval.mean)}<br><span class="small">p95 ${fmt(r.interval.p95)}</span></td>
      <td>${fmt(r.cpu.mean, 3)}<br><span class="small">p95 ${fmt(r.cpu.p95, 3)} ${r !== base ? d(r.cpu.mean, base.cpu.mean) : ''}</span></td>
      <td>${r.gpu.available ? fmt(r.gpu.mean, 3) : 'n/a'}</td>
      <td>${fmt(r.draws.mean, 0)}<br><span class="small">${fmtInt(r.triangles.mean)} tris</span></td>
      <td>${fmt(r.visibleMean, 0)} / ${fmt(r.shadowOnlyMean, 0)}<br><span class="small">unres ${fmt(r.unresolvedFramesPct, 1)}%</span></td>
      <td>${fmt(r.queriesPerFrame, 1)}<br><span class="small">hit ${Number.isFinite(r.queryCacheHitRate) ? (r.queryCacheHitRate * 100).toFixed(0) + '%' : 'n/a'}</span></td>
      <td>${r.geometryGenerated}<br><span class="small">${fmt(r.geometryGenMsTotal, 1)} ms</span></td>
      <td>${r.memory.uaSpecificMemoryMB !== null ? fmt(r.memory.uaSpecificMemoryMB, 0) + ' MB*' : r.memory.browserHeapEndMB !== null ? fmt(r.memory.browserHeapEndMB, 0) + ' MB' : 'n/a'}<br><span class="small">geo ${fmt(r.memory.estimates['gpuGeometry.estimateMB'], 1)} MB est</span></td>
    </tr>${r.yawSectors ? `<tr><td colspan="10" class="small">camera yaw sectors (JS ms / draws / visible / shadow-only): ${r.yawSectors.map((s) => `${s.sectorDeg}°: ${fmt(s.cpuMean, 2)}/${fmt(s.drawsMean, 0)}/${fmt(s.visibleMean, 0)}/${fmt(s.shadowOnlyMean, 0)}`).join(' · ')}</td></tr>` : ''}`;
  }).join('');
  return `<div class="scroll-x"><table class="t bench"><tr><th>Scenario</th><th>FPS</th><th>Frame ms</th><th>JS ms (Δ vs first)</th><th>GPU ms</th><th>Draws</th><th>Vis / shadow</th><th>Queries</th><th>Geom gen</th><th>Heap</th></tr>${rows}</table></div>`;
}

export function summaryText(results: ScenarioResult[]): string {
  return results.map((r) => `${r.scenario.label}: fps ${fmt(r.fpsFromMeanInterval, 1)} (1% ${fmt(r.onePercentLowFps, 1)}), frame ${fmt(r.interval.mean)} ms, JS ${fmt(r.cpu.mean, 3)} ms (p95 ${fmt(r.cpu.p95, 3)}), GPU ${r.gpu.available ? fmt(r.gpu.mean, 3) + ' ms' : 'n/a'}, draws ${fmt(r.draws.mean, 0)}, tris ${fmtInt(r.triangles.mean)}, entities ${r.entityCount}`).join('\n');
}

