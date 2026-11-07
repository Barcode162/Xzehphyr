/**
 * Curve reference frame (trails, streams).
 *
 * A curve is a procedural definition (control points) from which a uniform
 * arc-length polyline is derived once. Entities can be positioned *along* a curve
 * (arc length s, lateral offset, height above the curve profile) instead of
 * storing absolute coordinates. Orientation per segment is piecewise constant so
 * that world -> curve -> world round trips are exact on the segment band.
 */

export interface CurveProjection {
  s: number;
  lateral: number;
  dist: number;
  seg: number;
}

export class Curve {
  readonly closed: boolean;
  readonly n: number; // number of samples (= segments for closed curves)
  readonly spacing: number;
  readonly length: number;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  /** Per-segment unit direction and heading (yaw). */
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  readonly heading: Float64Array;
  /** Height profile per sample (curve-local y). Filled by the terrain definition. */
  profile: Float32Array;
  halfWidth: number;

  // nearest-segment acceleration grid (CSR)
  private gridCell = 16;
  private gridMinX = 0;
  private gridMinZ = 0;
  private gridW = 0;
  private gridH = 0;
  private cellStart: Int32Array = new Int32Array(0);
  private cellItems: Int32Array = new Int32Array(0);
  private influence = 0;

  constructor(points: Array<[number, number]>, closed: boolean, desiredSpacing = 1, halfWidth = 1.5) {
    this.closed = closed;
    this.halfWidth = halfWidth;
    // 1) dense Catmull-Rom sampling
    const dense: number[] = [];
    const m = points.length;
    const segs = closed ? m : m - 1;
    const SUB = 24;
    const P = (i: number) => {
      if (closed) return points[((i % m) + m) % m];
      return points[Math.max(0, Math.min(m - 1, i))];
    };
    for (let i = 0; i < segs; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB, t2 = t * t, t3 = t2 * t;
        const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
        const z = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
        dense.push(x, z);
      }
    }
    if (closed) dense.push(dense[0], dense[1]);
    else dense.push(points[m - 1][0], points[m - 1][1]);
    // 2) cumulative arc length
    const dn = dense.length / 2;
    const cum = new Float64Array(dn);
    for (let i = 1; i < dn; i++) {
      const ddx = dense[i * 2] - dense[i * 2 - 2];
      const ddz = dense[i * 2 + 1] - dense[i * 2 - 1];
      cum[i] = cum[i - 1] + Math.sqrt(ddx * ddx + ddz * ddz);
    }
    const total = cum[dn - 1];
    const segCount = Math.max(2, Math.round(total / desiredSpacing));
    this.spacing = total / segCount;
    this.length = total;
    this.n = closed ? segCount : segCount + 1;
    this.px = new Float64Array(this.n);
    this.pz = new Float64Array(this.n);
    // 3) uniform resample
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const s = i * this.spacing;
      while (j < dn - 2 && cum[j + 1] < s) j++;
      const segLen = cum[j + 1] - cum[j] || 1;
      const t = Math.min(1, Math.max(0, (s - cum[j]) / segLen));
      this.px[i] = dense[j * 2] + (dense[j * 2 + 2] - dense[j * 2]) * t;
      this.pz[i] = dense[j * 2 + 1] + (dense[j * 2 + 3] - dense[j * 2 + 1]) * t;
    }
    const nSeg = this.segmentCount;
    this.dx = new Float64Array(nSeg);
    this.dz = new Float64Array(nSeg);
    this.heading = new Float64Array(nSeg);
    for (let i = 0; i < nSeg; i++) {
      const i1 = (i + 1) % this.n;
      let ddx = this.px[i1] - this.px[i];
      let ddz = this.pz[i1] - this.pz[i];
      const l = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
      ddx /= l; ddz /= l;
      this.dx[i] = ddx;
      this.dz[i] = ddz;
      this.heading[i] = Math.atan2(ddx, ddz);
    }
    this.profile = new Float32Array(this.n);
  }

  get segmentCount(): number {
    return this.closed ? this.n : this.n - 1;
  }

  /** Normalize arc length (wrap for closed curves, clamp for open). */
  wrapS(s: number): number {
    if (this.closed) {
      const L = this.segmentCount * this.spacing;
      s = s % L;
      if (s < 0) s += L;
      return s;
    }
    return Math.max(0, Math.min(this.segmentCount * this.spacing - 1e-6, s));
  }

  segmentAt(s: number): number {
    const i = Math.floor(this.wrapS(s) / this.spacing);
    return Math.min(i, this.segmentCount - 1);
  }

  /** Position (curve-local xz) at arc length s → out[0]=x, out[1]=z, out[2]=heading, out[3]=profile height. */
  sample(s: number, out: Float64Array | number[]): void {
    s = this.wrapS(s);
    const i = Math.min(Math.floor(s / this.spacing), this.segmentCount - 1);
    const t = (s - i * this.spacing) / this.spacing;
    const i1 = (i + 1) % this.n;
    out[0] = this.px[i] + (this.px[i1] - this.px[i]) * t;
    out[1] = this.pz[i] + (this.pz[i1] - this.pz[i]) * t;
    out[2] = this.heading[i];
    out[3] = this.profile[i] + (this.profile[i1] - this.profile[i]) * t;
  }

  /** Smooth heading (interpolated between adjacent segments) for visual uses such as camera guidance. */
  smoothHeading(s: number): number {
    s = this.wrapS(s);
    const f = s / this.spacing - 0.5;
    let i = Math.floor(f);
    const t = f - i;
    const nSeg = this.segmentCount;
    const ia = this.closed ? ((i % nSeg) + nSeg) % nSeg : Math.max(0, Math.min(nSeg - 1, i));
    const ib = this.closed ? (ia + 1) % nSeg : Math.max(0, Math.min(nSeg - 1, i + 1));
    const x = this.dx[ia] * (1 - t) + this.dx[ib] * t;
    const z = this.dz[ia] * (1 - t) + this.dz[ib] * t;
    return Math.atan2(x, z);
  }

  profileAt(s: number): number {
    s = this.wrapS(s);
    const i = Math.min(Math.floor(s / this.spacing), this.segmentCount - 1);
    const t = (s - i * this.spacing) / this.spacing;
    const i1 = (i + 1) % this.n;
    return this.profile[i] + (this.profile[i1] - this.profile[i]) * t;
  }

  private projectSegment(i: number, x: number, z: number, out: CurveProjection): void {
    const i1 = (i + 1) % this.n;
    const ax = this.px[i], az = this.pz[i];
    const ex = this.px[i1] - ax, ez = this.pz[i1] - az;
    const len2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + ex * t, cz = az + ez * t;
    const rx = x - cx, rz = z - cz;
    const d = Math.sqrt(rx * rx + rz * rz);
    if (d < out.dist) {
      out.dist = d;
      out.seg = i;
      out.s = (i + t) * this.spacing;
      // right vector = (dz, -dx)
      out.lateral = rx * this.dz[i] - rz * this.dx[i];
    }
  }

  /** Project near a known arc length (used for entities that move along the curve). */
  projectNear(x: number, z: number, hintS: number, window: number, out: CurveProjection): CurveProjection {
    out.dist = Infinity;
    out.seg = -1;
    const nSeg = this.segmentCount;
    const c = Math.floor(this.wrapS(hintS) / this.spacing);
    const w = Math.ceil(window / this.spacing);
    for (let k = -w; k <= w; k++) {
      let i = c + k;
      if (this.closed) i = ((i % nSeg) + nSeg) % nSeg;
      else if (i < 0 || i >= nSeg) continue;
      this.projectSegment(i, x, z, out);
    }
    return out;
  }

  /** Exhaustive projection (O(n)). Used only for validation and as a fallback. */
  projectBrute(x: number, z: number, out: CurveProjection): CurveProjection {
    out.dist = Infinity;
    out.seg = -1;
    for (let i = 0; i < this.segmentCount; i++) this.projectSegment(i, x, z, out);
    return out;
  }

  /** Build the nearest-segment grid. Queries beyond `influence` return dist = Infinity. */
  buildAccel(influence: number, cellSize = 16): void {
    this.influence = influence;
    this.gridCell = cellSize;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    minX -= influence + cellSize; minZ -= influence + cellSize;
    maxX += influence + cellSize; maxZ += influence + cellSize;
    this.gridMinX = minX;
    this.gridMinZ = minZ;
    this.gridW = Math.ceil((maxX - minX) / cellSize);
    this.gridH = Math.ceil((maxZ - minZ) / cellSize);
    const cells = this.gridW * this.gridH;
    const counts = new Int32Array(cells + 1);
    const nSeg = this.segmentCount;
    const forCells = (i: number, fn: (c: number) => void) => {
      const i1 = (i + 1) % this.n;
      const x0 = Math.min(this.px[i], this.px[i1]) - influence, x1 = Math.max(this.px[i], this.px[i1]) + influence;
      const z0 = Math.min(this.pz[i], this.pz[i1]) - influence, z1 = Math.max(this.pz[i], this.pz[i1]) + influence;
      const cx0 = Math.floor((x0 - minX) / cellSize), cx1 = Math.floor((x1 - minX) / cellSize);
      const cz0 = Math.floor((z0 - minZ) / cellSize), cz1 = Math.floor((z1 - minZ) / cellSize);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.gridW + cx);
    };
    for (let i = 0; i < nSeg; i++) forCells(i, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let i = 0; i < nSeg; i++) forCells(i, (c) => { items[fill[c]++] = i; });
    this.cellStart = counts;
    this.cellItems = items;
  }

  /** Nearest point on the curve within the acceleration influence radius. */
  nearest(x: number, z: number, out: CurveProjection): CurveProjection {
    out.dist = Infinity;
    out.seg = -1;
    const cx = Math.floor((x - this.gridMinX) / this.gridCell);
    const cz = Math.floor((z - this.gridMinZ) / this.gridCell);
    if (cx < 0 || cz < 0 || cx >= this.gridW || cz >= this.gridH) return out;
    const c = cz * this.gridW + cx;
    const a = this.cellStart[c], b = this.cellStart[c + 1];
    for (let k = a; k < b; k++) this.projectSegment(this.cellItems[k], x, z, out);
    if (out.dist > this.influence) out.dist = Infinity;
    return out;
  }

  accelBytes(): number {
    return this.cellStart.byteLength + this.cellItems.byteLength;
  }

  /** Copy transformed into another frame (translation + yaw). Used to derive world-space carving curves. */
  static transformed(src: Curve, ox: number, oy: number, oz: number, yaw: number): Curve {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const pts: Array<[number, number]> = [];
    // re-derive from samples (already uniform) — use them as dense control points
    const n = src.closed ? src.n : src.n;
    for (let i = 0; i < n; i++) {
      const x = src.px[i], z = src.pz[i];
      pts.push([ox + x * c + z * s, oz - x * s + z * c]);
    }
    const out = Curve.fromSamples(pts, src.closed, src.halfWidth);
    for (let i = 0; i < out.n && i < src.n; i++) out.profile[i] = src.profile[i] + oy;
    return out;
  }

  /** Construct directly from already-uniform samples without re-splining. */
  static fromSamples(pts: Array<[number, number]>, closed: boolean, halfWidth: number): Curve {
    const c = Object.create(Curve.prototype) as Curve;
    const n = pts.length;
    const px = new Float64Array(n), pz = new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = pts[i][0]; pz[i] = pts[i][1]; }
    let total = 0;
    const nSeg = closed ? n : n - 1;
    for (let i = 0; i < nSeg; i++) {
      const i1 = (i + 1) % n;
      total += Math.hypot(px[i1] - px[i], pz[i1] - pz[i]);
    }
    const dx = new Float64Array(nSeg), dz = new Float64Array(nSeg), heading = new Float64Array(nSeg);
    for (let i = 0; i < nSeg; i++) {
      const i1 = (i + 1) % n;
      let ddx = px[i1] - px[i], ddz = pz[i1] - pz[i];
      const l = Math.hypot(ddx, ddz) || 1;
      ddx /= l; ddz /= l;
      dx[i] = ddx; dz[i] = ddz; heading[i] = Math.atan2(ddx, ddz);
    }
    Object.assign(c, {
      closed, n, spacing: total / nSeg, length: total, px, pz, dx, dz, heading,
      profile: new Float32Array(n), halfWidth,
      gridCell: 16, gridMinX: 0, gridMinZ: 0, gridW: 0, gridH: 0,
      cellStart: new Int32Array(0), cellItems: new Int32Array(0), influence: 0,
    });
    return c;
  }
}
