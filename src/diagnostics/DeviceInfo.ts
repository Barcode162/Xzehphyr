/**
 * Device capability & API availability report.
 * Only reads what the browser voluntarily exposes. Nothing is fingerprinted,
 * bypassed, or transmitted; the report stays local and is downloadable on demand.
 */

// Minimal WebGPU shapes (avoids depending on @webgpu/types for an optional feature).
interface GPUAdapterInfoLike { vendor?: string; architecture?: string; device?: string; description?: string }
interface GPUAdapterLike { features: Set<string>; limits: unknown; info?: GPUAdapterInfoLike }
interface GPULike { requestAdapter(): Promise<GPUAdapterLike | null> }

export interface ApiStatus {
  name: string;
  available: boolean;
  detail: string;
}

export interface DeviceReport {
  generatedAt: string;
  userAgent: string;
  browser: string;
  os: string;
  isIOS: boolean;
  isSafari: boolean;
  isMobile: boolean;
  uaData: unknown;
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number; orientation: string };
  viewport: { width: number; height: number; visualViewport: string };
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  deviceMemoryGB: number | null;
  maxTouchPoints: number;
  touch: boolean;
  crossOriginIsolated: boolean;
  timerResolutionMs: number;
  refreshRateEstimateHz: number | null;
  refreshRateMethod: string;
  webgl: {
    version: string;
    glslVersion: string;
    vendor: string;
    renderer: string;
    unmaskedVendor: string | null;
    unmaskedRenderer: string | null;
    maxTextureSize: number;
    maxRenderbufferSize: number;
    maxViewport: number[];
    maxVertexAttribs: number;
    maxTextureUnits: number;
    maxSamples: number | null;
    antialias: boolean | null;
    extensions: string[];
  } | null;
  webgpu: { available: boolean; adapter: unknown; features: string[]; limits: Record<string, number>; error?: string };
  apis: ApiStatus[];
  iosNotes: string[];
}

function detectBrowser(ua: string): { browser: string; os: string; isIOS: boolean; isSafari: boolean; isMobile: boolean } {
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|Edg\//.test(ua);
  let browser = 'Unknown';
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Edg\/([\d.]+)/))) browser = `Edge ${m[1]}`;
  else if ((m = ua.match(/CriOS\/([\d.]+)/))) browser = `Chrome iOS ${m[1]} (WebKit engine)`;
  else if ((m = ua.match(/FxiOS\/([\d.]+)/))) browser = `Firefox iOS ${m[1]} (WebKit engine)`;
  else if ((m = ua.match(/Chrome\/([\d.]+)/))) browser = `Chrome/Chromium ${m[1]}`;
  else if ((m = ua.match(/Firefox\/([\d.]+)/))) browser = `Firefox ${m[1]}`;
  else if (isSafari && (m = ua.match(/Version\/([\d.]+)/))) browser = `Safari ${m[1]}`;
  let os = 'Unknown';
  if ((m = ua.match(/OS (\d+[_\d]*) like Mac OS X/))) os = `iOS/iPadOS ${m[1].replace(/_/g, '.')}`;
  else if (isIOS) os = 'iPadOS (desktop-class UA)';
  else if ((m = ua.match(/Android ([\d.]+)/))) os = `Android ${m[1]}`;
  else if ((m = ua.match(/Mac OS X ([\d_]+)/))) os = `macOS ${m[1].replace(/_/g, '.')} (UA-frozen value)`;
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  const isMobile = isIOS || /Android|Mobile/.test(ua);
  return { browser, os, isIOS, isSafari, isMobile };
}

/** Estimate the display refresh rate from requestAnimationFrame cadence (median interval). */
export function estimateRefreshRate(frames = 90): Promise<{ hz: number; medianMs: number }> {
  return new Promise((resolve) => {
    const ts: number[] = [];
    const step = (t: number) => {
      ts.push(t);
      if (ts.length < frames) requestAnimationFrame(step);
      else {
        const d: number[] = [];
        for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
        d.sort((a, b) => a - b);
        const med = d[Math.floor(d.length / 2)];
        resolve({ hz: 1000 / med, medianMs: med });
      }
    };
    requestAnimationFrame(step);
  });
}

export async function collectDeviceReport(gl: WebGLRenderingContext | WebGL2RenderingContext | null, timerResolutionMs: number, refresh: { hz: number; medianMs: number } | null): Promise<DeviceReport> {
  const ua = navigator.userAgent;
  const det = detectBrowser(ua);
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<unknown>; brands?: unknown; mobile?: boolean; platform?: string }; gpu?: GPULike };
  let uaData: unknown = null;
  if (nav.userAgentData) {
    uaData = { brands: nav.userAgentData.brands, mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform };
    try {
      if (nav.userAgentData.getHighEntropyValues) {
        uaData = await nav.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'fullVersionList']);
      }
    } catch { /* denied */ }
  }
  let webgl: DeviceReport['webgl'] = null;
  if (gl) {
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const attrs = gl.getContextAttributes();
    webgl = {
      version: gl.getParameter(gl.VERSION),
      glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewport: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      maxSamples: isGL2 ? (gl as WebGL2RenderingContext).getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES) : null,
      antialias: attrs ? attrs.antialias ?? null : null,
      extensions: gl.getSupportedExtensions() ?? [],
    };
  }
  const webgpu: DeviceReport['webgpu'] = { available: false, adapter: null, features: [], limits: {} };
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        webgpu.available = true;
        const info = adapter.info;
        webgpu.adapter = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : 'adapter.info not exposed';
        webgpu.features = Array.from(adapter.features.values()).map(String).sort();
        const lim: Record<string, number> = {};
        for (const k of ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxVertexBuffers', 'maxBindGroups']) {
          const v = (adapter.limits as unknown as Record<string, number>)[k];
          if (typeof v === 'number') lim[k] = v;
        }
        webgpu.limits = lim;
      } else webgpu.error = 'navigator.gpu present but requestAdapter() returned null';
    } catch (e) {
      webgpu.error = String(e);
    }
  } else webgpu.error = 'navigator.gpu not present';

  const perfMem = (performance as Performance & { memory?: unknown }).memory;
  const PO = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null;
  const supportedTypes: string[] = PO && (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ? [...(PO as unknown as { supportedEntryTypes: string[] }).supportedEntryTypes] : [];
  const has = (t: string) => supportedTypes.includes(t);
  const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const timerExt = gl ? !!gl.getExtension(gl2 ? 'EXT_disjoint_timer_query_webgl2' : 'EXT_disjoint_timer_query') : false;
  const apis: ApiStatus[] = [
    { name: 'performance.now()', available: typeof performance !== 'undefined', detail: `measured resolution ≈ ${fmtRes(timerResolutionMs)}` },
    { name: 'crossOriginIsolated (finer timers)', available: !!(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated, detail: 'requires COOP/COEP headers (dev server sets them)' },
    { name: 'requestAnimationFrame', available: typeof requestAnimationFrame !== 'undefined', detail: 'frame cadence source' },
    { name: 'PerformanceObserver', available: !!PO, detail: supportedTypes.length ? `entry types: ${supportedTypes.join(', ')}` : 'supportedEntryTypes not exposed' },
    { name: 'Long Tasks API (longtask)', available: has('longtask'), detail: 'main-thread tasks > 50 ms' },
    { name: 'Long Animation Frames (long-animation-frame)', available: has('long-animation-frame'), detail: 'frames > 50 ms with script attribution' },
    { name: 'Event Timing (event)', available: has('event'), detail: 'input event processing latency' },
    { name: 'Resource Timing (resource)', available: has('resource') || typeof performance.getEntriesByType === 'function', detail: 'load timing of local assets' },
    { name: 'performance.memory (JS heap)', available: !!perfMem, detail: perfMem ? 'non-standard, Chromium only, bucketed values' : 'not exposed (Safari, Firefox)' },
    { name: 'measureUserAgentSpecificMemory', available: typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory === 'function', detail: 'requires cross-origin isolation' },
    { name: 'navigator.deviceMemory', available: typeof nav.deviceMemory === 'number', detail: typeof nav.deviceMemory === 'number' ? `${nav.deviceMemory} GB (rounded hint)` : 'not exposed (Safari, Firefox)' },
    { name: 'navigator.hardwareConcurrency', available: typeof navigator.hardwareConcurrency === 'number', detail: `${navigator.hardwareConcurrency ?? 'n/a'} (Safari may cap/round this value)` },
    { name: 'User-Agent Client Hints', available: !!nav.userAgentData, detail: nav.userAgentData ? 'Chromium only' : 'not exposed (Safari, Firefox)' },
    { name: 'WebGL 2', available: gl2, detail: gl ? String(gl.getParameter(gl.VERSION)) : 'no context' },
    { name: 'WEBGL_debug_renderer_info', available: !!(gl && gl.getExtension('WEBGL_debug_renderer_info')), detail: 'unmasked GPU strings; Safari returns a generic "Apple GPU"' },
    { name: 'GPU timer queries', available: timerExt, detail: timerExt ? 'EXT_disjoint_timer_query(_webgl2)' : 'unavailable — GPU time will be reported as n/a' },
    { name: 'WebGPU (navigator.gpu)', available: webgpu.available, detail: webgpu.available ? `features: ${webgpu.features.length}${webgpu.features.includes('timestamp-query') ? ' (timestamp-query)' : ' (no timestamp-query)'}` : webgpu.error ?? '' },
    { name: 'Web Audio', available: typeof AudioContext !== 'undefined' || 'webkitAudioContext' in window, detail: 'starts only after a user gesture' },
    { name: 'Touch events', available: 'ontouchstart' in window, detail: `maxTouchPoints=${navigator.maxTouchPoints}` },
    { name: 'Pointer Lock', available: 'pointerLockElement' in document, detail: 'not used (touch-first controls)' },
    { name: 'Fullscreen API (element)', available: !!document.documentElement.requestFullscreen, detail: 'iPhone Safari: not available for non-video elements; use Add to Home Screen' },
    { name: 'Screen Wake Lock', available: 'wakeLock' in navigator, detail: 'not requested' },
    { name: 'Battery Status', available: 'getBattery' in navigator, detail: 'not used' },
    { name: 'Network Information', available: 'connection' in navigator, detail: 'not used' },
    { name: 'OffscreenCanvas', available: typeof OffscreenCanvas !== 'undefined', detail: 'not used' },
    { name: 'SharedArrayBuffer', available: typeof SharedArrayBuffer !== 'undefined', detail: 'requires cross-origin isolation' },
  ];
  const iosNotes: string[] = [];
  if (det.isIOS || det.isSafari) {
    iosNotes.push(
      'All iOS browsers use WebKit; Chrome/Firefox on iOS have the same API surface as Safari.',
      'performance.memory, navigator.deviceMemory and UA Client Hints are not exposed: JS heap usage cannot be measured.',
      'EXT_disjoint_timer_query is not exposed: WebGL GPU execution time cannot be measured; only CPU submission time is shown.',
      'Long Tasks / Long Animation Frame observers are not supported: long frames are detected from rAF intervals only.',
      'WEBGL_debug_renderer_info reports a generic "Apple GPU" string; the exact GPU model is not exposed.',
      'performance.now() is coarsened; per-frame subsystem timings are quantized. Use averages over many frames.',
      'requestAnimationFrame is commonly capped at 60 Hz (ProMotion displays may be limited unless enabled in Safari settings) and at 30 Hz in Low Power Mode.',
      'Fullscreen API is unavailable for canvas on iPhone; "Add to Home Screen" gives a standalone, chrome-less view.',
      'Web Audio requires a user gesture and is muted by the hardware silent switch for some configurations.',
      'WebGPU availability depends on the iOS/Safari version; it is detected, not assumed.',
    );
  }
  return {
    generatedAt: new Date().toISOString(),
    userAgent: ua,
    browser: det.browser,
    os: det.os,
    isIOS: det.isIOS,
    isSafari: det.isSafari,
    isMobile: det.isMobile,
    uaData,
    screen: {
      width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth,
      orientation: (screen.orientation && screen.orientation.type) || 'n/a',
    },
    viewport: {
      width: window.innerWidth, height: window.innerHeight,
      visualViewport: window.visualViewport ? `${window.visualViewport.width.toFixed(0)}x${window.visualViewport.height.toFixed(0)} @scale ${window.visualViewport.scale}` : 'n/a',
    },
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    maxTouchPoints: navigator.maxTouchPoints,
    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    crossOriginIsolated: !!(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated,
    timerResolutionMs,
    refreshRateEstimateHz: refresh ? refresh.hz : null,
    refreshRateMethod: 'median requestAnimationFrame interval over 90 idle frames (estimate; the browser may cap rAF below the panel rate)',
    webgl,
    webgpu,
    apis,
    iosNotes,
  };
}

function fmtRes(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  return ms >= 0.1 ? `${ms.toFixed(3)} ms` : `${(ms * 1000).toFixed(1)} µs`;
}
