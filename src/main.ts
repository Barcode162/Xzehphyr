/**
 * Relational World Engine — entry point.
 * URL parameters:
 *   ?backend=webgl|webgpu   rendering backend (WebGPU is experimental)
 *   ?quality=mobile|desktop quality preset (default: auto)
 *   ?arch=A|A2|B|C          initial architecture (default: C)
 *   ?autobench=<suite>      run a benchmark suite automatically (frames=<n>)
 */
import './style.css';
import { Stage } from './render/Stage';
import { Engine, ArchId, QUALITY_DESKTOP, QUALITY_MOBILE } from './engine/Engine';
import { Input } from './game/Input';
import { DEFAULT_WORLD } from './world/WorldGenerator';
import { DebugViz } from './debug/DebugViz';
import { BenchmarkRunner, SUITES } from './bench/Benchmark';
import { Dashboard } from './ui/Dashboard';
import { profiler } from './diagnostics/Profiler';
import { collectDeviceReport, estimateRefreshRate } from './diagnostics/DeviceInfo';

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('status')!;
const setStatus = (s: string) => { statusEl.textContent = s; statusEl.style.display = s ? 'block' : 'none'; };

function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios || /Android|Mobile/.test(ua) || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 900);
}

async function boot(): Promise<void> {
  setStatus('Measuring timer resolution…');
  profiler.measureTimerResolution();
  const mobile = params.get('quality') ? params.get('quality') === 'mobile' : isMobileDevice();
  const quality = { ...(mobile ? QUALITY_MOBILE : QUALITY_DESKTOP) };
  document.body.classList.toggle('mobile', mobile);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let backend: 'webgl' | 'webgpu' = params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
  const nav = navigator as Navigator & { gpu?: unknown };
  if (backend === 'webgpu' && !nav.gpu) {
    setStatus('WebGPU not available — falling back to WebGL');
    backend = 'webgl';
  }
  let stage = new Stage({ canvas, backend, antialias: true, shadowMapSize: quality.shadowMapSize });
  try {
    await stage.init({ canvas, backend, antialias: true, shadowMapSize: quality.shadowMapSize });
  } catch (e) {
    console.warn('Backend init failed, falling back to WebGL', e);
    if (backend === 'webgpu') {
      backend = 'webgl';
      stage = new Stage({ canvas, backend, antialias: true, shadowMapSize: quality.shadowMapSize });
      await stage.init({ canvas, backend, antialias: true, shadowMapSize: quality.shadowMapSize });
    } else {
      setStatus(`WebGL unavailable: ${String(e)}`);
      return;
    }
  }
  stage.maxDpr = quality.maxDpr;
  stage.renderScale = quality.renderScale;
  stage.resize();

  const input = new Input(document.getElementById('touch-surface')!, document.getElementById('btn-jump')!, document.getElementById('btn-sprint')!);
  const engine = new Engine(stage, input, quality);
  engine.onStatus = setStatus;
  setStatus('Building world database…');
  await new Promise((r) => setTimeout(r, 0));
  engine.loadWorld({ ...DEFAULT_WORLD, stress: { ...DEFAULT_WORLD.stress } });
  engine.placeOnTrail(40);
  const arch = (params.get('arch') ?? 'C').toUpperCase() as ArchId;
  await engine.setArchitecture(['A', 'A2', 'B', 'C'].includes(arch) ? arch : 'C');
  setStatus('Requesting initial observation…');
  engine.prewarm(mobile ? 350 : 600);

  const debug = new DebugViz(engine);
  engine.debugUpdate = () => debug.update();
  let deviceReport: unknown = null;
  const bench = new BenchmarkRunner(engine, () => deviceReport);
  const dash = new Dashboard(engine, debug, bench);
  setStatus('');

  // toolbar
  const tb = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  tb('tb-stats', () => dash.isOpen ? dash.toggle(false) : dash.show('Live'));
  tb('tb-dev', () => { if (!debug.enabled) debug.setEnabled(true); dash.show('Dev'); });
  tb('tb-mode', () => dash.show('Mode'));
  tb('tb-bench', () => dash.show('Bench'));
  tb('tb-viz', () => { debug.setEnabled(!debug.enabled); document.getElementById('tb-viz')!.classList.toggle('on', debug.enabled); });
  tb('tb-god', () => { stage.useObserver = !stage.useObserver; if (stage.useObserver && !debug.enabled) debug.setEnabled(true); document.getElementById('tb-god')!.classList.toggle('on', stage.useObserver); document.getElementById('tb-viz')!.classList.toggle('on', debug.enabled); });

  // start overlay (audio needs a user gesture on iOS)
  const overlay = document.getElementById('start')!;
  const start = async (withAudio: boolean) => {
    overlay.style.display = 'none';
    if (withAudio) await engine.audio.enable();
  };
  document.getElementById('start-audio')!.addEventListener('click', () => void start(true));
  document.getElementById('start-silent')!.addEventListener('click', () => void start(false));

  // lifecycle: no work while hidden
  let running = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { running = false; engine.audio.suspend(); }
    else { running = true; engine.audio.resume(); lastResume = performance.now(); requestAnimationFrame(loop); }
  });
  let lastResume = 0;
  window.addEventListener('resize', () => stage.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => stage.resize(), 250));

  let errors = 0;
  const loop = (now: number) => {
    if (!running) return;
    try {
      if (now - lastResume < 50) { engine.tick(now); engine.stats.reset(); } // discard the resume frame
      else engine.tick(now);
      bench.frameDone();
      dash.update(now);
    } catch (e) {
      // never let one bad frame kill the loop; surface it instead of hiding it
      errors++;
      console.error(e);
      setStatus(`Frame error #${errors}: ${e instanceof Error ? e.message : String(e)}`);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // automation hook (local only; used by the headless verification script)
  const hook = { engine, bench, dash, debug, SUITES, report: null as unknown };
  (window as unknown as { __rwe: unknown }).__rwe = hook;

  // device capabilities (async; refresh-rate estimate needs idle-ish frames)
  const refresh = await estimateRefreshRate(90);
  engine.stats.refreshIntervalMs = refresh.medianMs;
  const report = await collectDeviceReport(engine.webgl, profiler.timerResolutionMs, refresh);
  deviceReport = report;
  dash.device = report;

  hook.report = report;
  const auto = params.get('autobench');
  if (auto && SUITES[auto]) {
    const frames = +(params.get('frames') ?? 300);
    const list = SUITES[auto].build({ density: +(params.get('density') ?? 1), frames, stressSteps: (params.get('steps') ?? '0,15000').split(',').map(Number), stressArchs: ['A2', 'C'] });
    overlay.style.display = 'none';
    bench.preciseMemory = params.get('umem') === '1';
    await bench.runSuite(list);
    (window as unknown as { __rweDone: boolean }).__rweDone = true;
  }
}

boot().catch((e) => {
  console.error(e);
  setStatus(`Startup failed: ${e instanceof Error ? e.message : String(e)}`);
});
