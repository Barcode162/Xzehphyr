/**
 * Optional WebGL call instrumentation (counts, not timings). Wraps a handful of
 * context methods to count draw calls, instanced primitives, program switches,
 * buffer upload bytes and texture uploads per frame. Wrapping adds JS overhead,
 * so it can be toggled off (restores the original methods).
 */

export interface GLCounts {
  drawCalls: number;
  instancedDraws: number;
  instances: number;
  useProgram: number;
  bufferUploadBytes: number;
  bufferUploads: number;
  textureUploads: number;
  framebufferBinds: number;
}

type AnyFn = (...args: unknown[]) => unknown;

export class GLInstrument {
  readonly counts: GLCounts = { drawCalls: 0, instancedDraws: 0, instances: 0, useProgram: 0, bufferUploadBytes: 0, bufferUploads: 0, textureUploads: 0, framebufferBinds: 0 };
  readonly last: GLCounts = { ...this.counts };
  private originals = new Map<string, AnyFn>();
  active = false;

  constructor(private gl: WebGLRenderingContext | WebGL2RenderingContext | null) {}

  enable(): void {
    if (this.active || !this.gl) return;
    const gl = this.gl as unknown as Record<string, AnyFn>;
    const c = this.counts;
    const wrap = (name: string, fn: (orig: AnyFn) => AnyFn) => {
      const orig = gl[name];
      if (typeof orig !== 'function') return;
      this.originals.set(name, orig);
      gl[name] = fn(orig.bind(this.gl));
    };
    wrap('drawElements', (o) => (...a) => { c.drawCalls++; return o(...a); });
    wrap('drawArrays', (o) => (...a) => { c.drawCalls++; return o(...a); });
    wrap('drawElementsInstanced', (o) => (...a) => { c.drawCalls++; c.instancedDraws++; c.instances += a[4] as number; return o(...a); });
    wrap('drawArraysInstanced', (o) => (...a) => { c.drawCalls++; c.instancedDraws++; c.instances += a[3] as number; return o(...a); });
    wrap('useProgram', (o) => (...a) => { c.useProgram++; return o(...a); });
    wrap('bindFramebuffer', (o) => (...a) => { c.framebufferBinds++; return o(...a); });
    const bytesOf = (v: unknown, extra: unknown[]) => {
      if (typeof v === 'number') return v;
      if (v && typeof (v as ArrayBufferView).byteLength === 'number') {
        // bufferSubData(target, offset, src, srcOffset, length) — length is in elements
        const view = v as ArrayBufferView & { BYTES_PER_ELEMENT?: number };
        const len = extra[1] as number | undefined;
        if (typeof len === 'number' && len > 0 && view.BYTES_PER_ELEMENT) return len * view.BYTES_PER_ELEMENT;
        return view.byteLength;
      }
      return 0;
    };
    wrap('bufferData', (o) => (...a) => { c.bufferUploads++; c.bufferUploadBytes += bytesOf(a[1], []); return o(...a); });
    wrap('bufferSubData', (o) => (...a) => { c.bufferUploads++; c.bufferUploadBytes += bytesOf(a[2], a.slice(3)); return o(...a); });
    wrap('texImage2D', (o) => (...a) => { c.textureUploads++; return o(...a); });
    wrap('texSubImage2D', (o) => (...a) => { c.textureUploads++; return o(...a); });
    wrap('texImage3D', (o) => (...a) => { c.textureUploads++; return o(...a); });
    this.active = true;
  }

  disable(): void {
    if (!this.active || !this.gl) return;
    const gl = this.gl as unknown as Record<string, AnyFn>;
    for (const [name, fn] of this.originals) gl[name] = fn;
    this.originals.clear();
    this.active = false;
  }

  /** Snapshot this frame's counts into `last` and reset. */
  endFrame(): void {
    const c = this.counts, l = this.last;
    l.drawCalls = c.drawCalls; l.instancedDraws = c.instancedDraws; l.instances = c.instances; l.useProgram = c.useProgram;
    l.bufferUploadBytes = c.bufferUploadBytes; l.bufferUploads = c.bufferUploads; l.textureUploads = c.textureUploads; l.framebufferBinds = c.framebufferBinds;
    c.drawCalls = 0; c.instancedDraws = 0; c.instances = 0; c.useProgram = 0; c.bufferUploadBytes = 0; c.bufferUploads = 0; c.textureUploads = 0; c.framebufferBinds = 0;
  }
}
