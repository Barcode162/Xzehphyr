/**
 * GPU timing via EXT_disjoint_timer_query_webgl2 (WebGL 2) or
 * EXT_disjoint_timer_query (WebGL 1). Results are asynchronous: a query issued
 * on frame N typically resolves 1–3 frames later; each result is attributed to
 * the frame that issued it. If the extension is missing (e.g. Safari / iOS,
 * Firefox by default) GPU time is reported as unavailable — never estimated.
 * Disjoint events (GPU context switches, throttling) invalidate in-flight queries.
 */

interface Pending {
  query: WebGLQuery;
  frame: number;
}

export class GpuTimer {
  readonly available: boolean;
  readonly reason: string;
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pending: Pending[] = [];
  private pool: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private activeFrame = 0;
  /** Latest resolved GPU frame time (ms) and the frame number it belongs to. */
  lastMs = NaN;
  lastFrame = -1;
  disjointCount = 0;
  /** Results rejected as implausible (> 10 s or negative). */
  rejected = 0;
  resolved = 0;
  enabled = true;
  onResult: ((frame: number, ms: number) => void) | null = null;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext | null) {
    if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      this.available = false;
      this.reason = gl ? 'WebGL 1 context: timer queries not implemented for WebGL 1 in this prototype' : 'no WebGL context (WebGPU backend uses its own timestamp queries)';
      return;
    }
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) {
      this.available = false;
      this.reason = 'EXT_disjoint_timer_query_webgl2 not exposed by this browser/GPU (common on Safari/iOS and Firefox)';
      return;
    }
    this.gl = gl;
    this.ext = ext as unknown as GpuTimer['ext'];
    this.available = true;
    this.reason = 'EXT_disjoint_timer_query_webgl2';
  }

  begin(frame: number): void {
    if (!this.available || !this.enabled || this.active) return;
    const gl = this.gl!;
    const q = this.pool.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q);
    this.active = q;
    this.activeFrame = frame;
  }

  end(): void {
    if (!this.active) return;
    const gl = this.gl!;
    gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
    this.pending.push({ query: this.active, frame: this.activeFrame });
    this.active = null;
  }

  /** Poll completed queries (call once per frame). */
  poll(): void {
    if (!this.available || this.pending.length === 0) return;
    const gl = this.gl!;
    const disjoint = gl.getParameter(this.ext!.GPU_DISJOINT_EXT);
    if (disjoint) {
      this.disjointCount++;
      for (const p of this.pending) this.pool.push(p.query);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length) {
      const p = this.pending[0];
      const ready = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE);
      if (!ready) break;
      const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.pool.push(p.query);
      const ms = ns / 1e6;
      // Some software/virtualized GPUs return garbage without signalling disjoint: reject implausible values.
      if (!(ms >= 0 && ms < 10000)) { this.rejected++; continue; }
      this.lastMs = ms;
      this.lastFrame = p.frame;
      this.resolved++;
      this.onResult?.(p.frame, this.lastMs);
    }
    if (this.pending.length > 8) {
      // never let the queue grow unbounded (e.g. tab throttled)
      for (const p of this.pending.splice(0, this.pending.length - 8)) this.pool.push(p.query);
    }
  }
}
