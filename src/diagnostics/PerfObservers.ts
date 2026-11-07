/**
 * PerformanceObserver integration (where supported) + heap observation.
 *   - longtask, long-animation-frame: Chromium only
 *   - event: input latency (Chromium)
 *   - resource: local asset load timing
 * GC observations are *inferred* from drops in performance.memory.usedJSHeapSize
 * (Chromium only) and labeled as such; there is no direct GC event API.
 */

export interface LongTaskEntry { start: number; duration: number; kind: string; }

export class PerfObservers {
  longTasks = 0;
  longTaskMs = 0;
  longAnimFrames = 0;
  longAnimFrameMs = 0;
  lastLoaf: { duration: number; blockingDuration: number; scripts: number } | null = null;
  eventLatencies: number[] = [];
  recent: LongTaskEntry[] = [];
  supported: string[] = [];
  private observers: PerformanceObserver[] = [];
  // heap
  heapUsedMB = NaN;
  heapTotalMB = NaN;
  heapLimitMB = NaN;
  private lastHeap = NaN;
  inferredGCs = 0;
  inferredGCFreedMB = 0;
  readonly heapAvailable: boolean;

  constructor() {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.heapAvailable = !!mem;
    if (typeof PerformanceObserver === 'undefined') return;
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? [];
    this.supported = [...types];
    const tryObserve = (type: string, cb: (list: PerformanceObserverEntryList) => void, extra: Record<string, unknown> = {}) => {
      if (!types.includes(type)) return;
      try {
        const o = new PerformanceObserver(cb);
        o.observe({ type, buffered: false, ...extra } as PerformanceObserverInit);
        this.observers.push(o);
      } catch { /* unsupported */ }
    };
    tryObserve('longtask', (list) => {
      for (const e of list.getEntries()) {
        this.longTasks++;
        this.longTaskMs += e.duration;
        this.pushRecent({ start: e.startTime, duration: e.duration, kind: 'longtask' });
      }
    });
    tryObserve('long-animation-frame', (list) => {
      for (const e of list.getEntries()) {
        this.longAnimFrames++;
        this.longAnimFrameMs += e.duration;
        const x = e as PerformanceEntry & { blockingDuration?: number; scripts?: unknown[] };
        this.lastLoaf = { duration: e.duration, blockingDuration: x.blockingDuration ?? NaN, scripts: x.scripts?.length ?? 0 };
        this.pushRecent({ start: e.startTime, duration: e.duration, kind: 'long-animation-frame' });
      }
    });
    tryObserve('event', (list) => {
      for (const e of list.getEntries()) {
        const x = e as PerformanceEntry & { processingStart?: number };
        if (x.processingStart) {
          this.eventLatencies.push(e.duration);
          if (this.eventLatencies.length > 50) this.eventLatencies.shift();
        }
      }
    }, { durationThreshold: 16 });
  }

  private pushRecent(e: LongTaskEntry): void {
    this.recent.push(e);
    if (this.recent.length > 30) this.recent.shift();
  }

  /** Sample heap (cheap; call ~4x/s). */
  sampleHeap(): void {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (!mem) return;
    const used = mem.usedJSHeapSize / 1048576;
    if (Number.isFinite(this.lastHeap) && used < this.lastHeap - 1) {
      this.inferredGCs++;
      this.inferredGCFreedMB += this.lastHeap - used;
    }
    this.lastHeap = used;
    this.heapUsedMB = used;
    this.heapTotalMB = mem.totalJSHeapSize / 1048576;
    this.heapLimitMB = mem.jsHeapSizeLimit / 1048576;
  }

  resourceTimings(): Array<{ name: string; type: string; durationMs: number; transferBytes: number; decodedBytes: number }> {
    if (typeof performance.getEntriesByType !== 'function') return [];
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
      name: r.name.replace(location.origin, ''),
      type: r.initiatorType,
      durationMs: +r.duration.toFixed(2),
      transferBytes: r.transferSize ?? NaN,
      decodedBytes: r.decodedBodySize ?? NaN,
    }));
  }

  navigationTiming(): Record<string, number> | null {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return null;
    return {
      domContentLoadedMs: +nav.domContentLoadedEventEnd.toFixed(1),
      loadEventMs: +nav.loadEventEnd.toFixed(1),
      transferBytes: nav.transferSize,
    };
  }

  reset(): void {
    this.longTasks = 0; this.longTaskMs = 0; this.longAnimFrames = 0; this.longAnimFrameMs = 0;
    this.inferredGCs = 0; this.inferredGCFreedMB = 0; this.recent.length = 0;
  }
}
