/**
 * Renderer-agnostic geometry representation.
 * The geometry evaluator produces plain typed arrays; the presentation layer
 * decides how (and whether) to upload them to a GPU.
 */

export interface GeometryGroup {
  start: number;
  count: number;
  materialIndex: number;
}

export interface GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  /** RGBA8 normalized vertex colors. */
  colors: Uint8Array;
  index: Uint16Array | Uint32Array;
  groups: GeometryGroup[] | null;
  vertexCount: number;
  triangleCount: number;
  /** Exact byte size of the arrays above (CPU side). */
  bytes: number;
  /** Optional instance payload (e.g. grass clump transforms for a terrain patch). */
  instances?: Float32Array;
  instanceCount?: number;
}

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  groups: GeometryGroup[] = [];
  private groupStart = 0;
  private groupMat = -1;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  beginGroup(materialIndex: number): void {
    this.endGroup();
    this.groupStart = this.idx.length;
    this.groupMat = materialIndex;
  }
  endGroup(): void {
    if (this.groupMat >= 0 && this.idx.length > this.groupStart) {
      this.groups.push({ start: this.groupStart, count: this.idx.length - this.groupStart, materialIndex: this.groupMat });
    }
    this.groupMat = -1;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(r, g, b);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Tapered cylinder (frustum) along +Y from y0 to y1. */
  cylinder(
    cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, seg: number,
    color0: [number, number, number], color1: [number, number, number], capTop = false, bendX = 0, bendZ = 0,
  ): void {
    const base = this.vertexCount;
    const slope = (r0 - r1) / Math.max(0.001, y1 - y0);
    for (let ring = 0; ring < 2; ring++) {
      const y = ring === 0 ? y0 : y1;
      const r = ring === 0 ? r0 : r1;
      const c = ring === 0 ? color0 : color1;
      const ox = ring === 0 ? 0 : bendX, oz = ring === 0 ? 0 : bendZ;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nl = Math.sqrt(1 + slope * slope);
        this.vertex(cx + ox + ca * r, y, cz + oz + sa * r, ca / nl, slope / nl, sa / nl, c[0], c[1], c[2]);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i, b = base + i + 1, c = base + seg + 1 + i, d = base + seg + 2 + i;
      this.tri(a, c, b);
      this.tri(b, c, d);
    }
    if (capTop && r1 > 0.001) {
      const center = this.vertex(cx + bendX, y1, cz + bendZ, 0, 1, 0, color1[0], color1[1], color1[2]);
      const ringStart = this.vertexCount;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        this.vertex(cx + bendX + Math.cos(a) * r1, y1, cz + bendZ + Math.sin(a) * r1, 0, 1, 0, color1[0], color1[1], color1[2]);
      }
      for (let i = 0; i < seg; i++) this.tri(center, ringStart + i + 1, ringStart + i);
    }
  }

  /** Cone with jagged rim (pine tier). Flat-ish shading via split vertices per facet. */
  cone(
    cx: number, cz: number, yBase: number, height: number, radius: number, seg: number,
    jag: (i: number) => number, colBase: [number, number, number], colTip: [number, number, number], droop = 0.25,
  ): void {
    const tipY = yBase + height;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const r0 = radius * jag(i), r1 = radius * jag((i + 1) % seg);
      const x0 = cx + Math.cos(a0) * r0, z0 = cz + Math.sin(a0) * r0;
      const x1 = cx + Math.cos(a1) * r1, z1 = cz + Math.sin(a1) * r1;
      const y0 = yBase - droop * r0 * 0.4, y1 = yBase - droop * r1 * 0.4;
      // facet normal
      const ux = x1 - cx, uy = y1 - tipY, uz = z1 - cz;
      const vx = x0 - cx, vy = y0 - tipY, vz = z0 - cz;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      // bias normals upward/outward for softer foliage lighting
      const am = (a0 + a1) * 0.5;
      nx = nx * 0.6 + Math.cos(am) * 0.4; nz = nz * 0.6 + Math.sin(am) * 0.4; ny = ny * 0.8 + 0.3;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl; ny /= nl; nz /= nl;
      const t = this.vertex(cx, tipY, cz, nx, ny, nz, colTip[0], colTip[1], colTip[2]);
      const b0 = this.vertex(x0, y0, z0, nx, ny, nz, colBase[0], colBase[1], colBase[2]);
      const b1 = this.vertex(x1, y1, z1, nx, ny, nz, colBase[0], colBase[1], colBase[2]);
      this.tri(t, b1, b0);
      // underside (darker), so tiers read as volumes from below
      const d = 0.55;
      const u0 = this.vertex(x0, y0, z0, 0, -1, 0, colBase[0] * d, colBase[1] * d, colBase[2] * d);
      const u1 = this.vertex(x1, y1, z1, 0, -1, 0, colBase[0] * d, colBase[1] * d, colBase[2] * d);
      const uc = this.vertex(cx, yBase + height * 0.12, cz, 0, -1, 0, colBase[0] * d, colBase[1] * d, colBase[2] * d);
      this.tri(uc, u0, u1);
    }
  }

  /** Displaced icosphere blob. `displace(nx,ny,nz)` returns radius multiplier. */
  blob(
    cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, detail: number,
    displace: (x: number, y: number, z: number) => number,
    color: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => [number, number, number],
    flat = true, flattenBottom = 0,
  ): void {
    const { verts, faces } = icosphere(detail);
    const P: number[] = [];
    for (let i = 0; i < verts.length; i += 3) {
      const x = verts[i], y = verts[i + 1], z = verts[i + 2];
      const d = displace(x, y, z);
      let py = cy + y * ry * d;
      if (flattenBottom > 0 && py < cy - ry * flattenBottom) py = cy - ry * flattenBottom + (py - (cy - ry * flattenBottom)) * 0.15;
      P.push(cx + x * rx * d, py, cz + z * rz * d);
    }
    if (flat) {
      for (let f = 0; f < faces.length; f += 3) {
        const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const qx = P[c], qy = P[c + 1], qz = P[c + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const mx = (ax + bx + qx) / 3, my = (ay + by + qy) / 3, mz = (az + bz + qz) / 3;
        const c0 = color(mx, my, mz, nx, ny, nz);
        const i0 = this.vertex(ax, ay, az, nx, ny, nz, c0[0], c0[1], c0[2]);
        const i1 = this.vertex(bx, by, bz, nx, ny, nz, c0[0], c0[1], c0[2]);
        const i2 = this.vertex(qx, qy, qz, nx, ny, nz, c0[0], c0[1], c0[2]);
        this.tri(i0, i1, i2);
      }
    } else {
      const base = this.vertexCount;
      for (let i = 0; i < P.length; i += 3) {
        const x = verts[i], y = verts[i + 1], z = verts[i + 2];
        const c0 = color(P[i], P[i + 1], P[i + 2], x, y, z);
        this.vertex(P[i], P[i + 1], P[i + 2], x, y, z, c0[0], c0[1], c0[2]);
      }
      for (let f = 0; f < faces.length; f += 3) this.tri(base + faces[f], base + faces[f + 1], base + faces[f + 2]);
    }
  }

  /** Axis-aligned box in local space, then rotated by yaw about Y around (ox, oz). */
  box(
    cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
    color: [number, number, number], yaw = 0, shadeTop = 1.08, shadeSide = 0.9,
  ): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const R = (x: number, z: number): [number, number] => [cx + x * c + z * s, cz - x * s + z * c];
    const faces: Array<[number, number, number, number[][]]> = [
      [0, 1, 0, [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]],
      [0, -1, 0, [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [1, 0, 0, [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
      [-1, 0, 0, [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [0, 0, 1, [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [0, 0, -1, [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]]],
    ];
    for (const [nx, ny, nz, q] of faces) {
      const k = ny > 0 ? shadeTop : ny < 0 ? 0.6 : shadeSide;
      const wnx = nx * c + nz * s, wnz = -nx * s + nz * c;
      const base = this.vertexCount;
      for (const v of q) {
        const [x, z] = R(v[0], v[2]);
        this.vertex(x, cy + v[1], z, wnx, ny, wnz, color[0] * k, color[1] * k, color[2] * k);
      }
      this.tri(base, base + 1, base + 2);
      this.tri(base, base + 2, base + 3);
    }
  }

  /** Double-sided quad strip (for fern fronds / grass blades). */
  quadDouble(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number, c0: [number, number, number], c1: [number, number, number],
  ): void {
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const s2 = side === 0 ? 1 : 0.82;
      const i0 = this.vertex(ax, ay, az, nx * sgn, ny, nz * sgn, c0[0] * s2, c0[1] * s2, c0[2] * s2);
      const i1 = this.vertex(bx, by, bz, nx * sgn, ny, nz * sgn, c0[0] * s2, c0[1] * s2, c0[2] * s2);
      const i2 = this.vertex(cx, cy, cz, nx * sgn, ny, nz * sgn, c1[0] * s2, c1[1] * s2, c1[2] * s2);
      const i3 = this.vertex(dx, dy, dz, nx * sgn, ny, nz * sgn, c1[0] * s2, c1[1] * s2, c1[2] * s2);
      if (side === 0) { this.tri(i0, i1, i2); this.tri(i0, i2, i3); } else { this.tri(i0, i2, i1); this.tri(i0, i3, i2); }
    }
  }

  build(): GeometryData {
    this.endGroup();
    const vc = this.vertexCount;
    const positions = new Float32Array(this.pos);
    const normals = new Float32Array(this.nor);
    const colors = new Uint8Array(vc * 4);
    for (let i = 0; i < vc; i++) {
      colors[i * 4] = clamp255(this.col[i * 3]);
      colors[i * 4 + 1] = clamp255(this.col[i * 3 + 1]);
      colors[i * 4 + 2] = clamp255(this.col[i * 3 + 2]);
      colors[i * 4 + 3] = 255;
    }
    const index = vc > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx);
    return {
      positions, normals, colors, index,
      groups: this.groups.length ? this.groups : null,
      vertexCount: vc,
      triangleCount: this.idx.length / 3,
      bytes: positions.byteLength + normals.byteLength + colors.byteLength + index.byteLength,
    };
  }
}

function clamp255(v: number): number {
  const x = Math.round(v * 255);
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

const icoCache = new Map<number, { verts: number[]; faces: number[] }>();

/** Unit icosphere (shared vertices) at a subdivision level. Cached (pure function of detail). */
export function icosphere(detail: number): { verts: number[]; faces: number[] } {
  const cached = icoCache.get(detail);
  if (cached) return cached;
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const norm = (v: number[]) => {
    for (let i = 0; i < v.length; i += 3) {
      const l = Math.hypot(v[i], v[i + 1], v[i + 2]);
      v[i] /= l; v[i + 1] /= l; v[i + 2] /= l;
    }
  };
  norm(verts);
  for (let d = 0; d < detail; d++) {
    const mid = new Map<string, number>();
    const nf: number[] = [];
    const getMid = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let m = mid.get(k);
      if (m === undefined) {
        const x = (verts[a * 3] + verts[b * 3]) / 2, y = (verts[a * 3 + 1] + verts[b * 3 + 1]) / 2, z = (verts[a * 3 + 2] + verts[b * 3 + 2]) / 2;
        const l = Math.hypot(x, y, z);
        verts.push(x / l, y / l, z / l);
        m = verts.length / 3 - 1;
        mid.set(k, m);
      }
      return m;
    };
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
      nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = nf;
    verts = verts.slice();
  }
  const r = { verts, faces };
  icoCache.set(detail, r);
  return r;
}
