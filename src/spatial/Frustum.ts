/**
 * Renderer-agnostic convex volume (6 planes). Plane i: (nx, ny, nz, d), inside when n·p + d >= 0.
 * Built from camera parameters so that the observation query does not depend on Three.js.
 */
export class ConvexVolume {
  planes = new Float64Array(24);
  count = 6;
  /** 8 corner points (for debug drawing and light-space fitting). */
  corners = new Float64Array(24);

  setFromPerspective(
    px: number, py: number, pz: number,
    // camera basis: forward (fx,fy,fz), up (ux,uy,uz), right (rx,ry,rz) — orthonormal
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
    rx: number, ry: number, rz: number,
    fovY: number, aspect: number, near: number, far: number,
  ): this {
    const th = Math.tan(fovY * 0.5);
    const tw = th * aspect;
    // near
    this.setPlane(0, fx, fy, fz, px + fx * near, py + fy * near, pz + fz * near);
    // far
    this.setPlane(1, -fx, -fy, -fz, px + fx * far, py + fy * far, pz + fz * far);
    // left/right/top/bottom: normals = normalize(forward * t ± side)
    let nx = fx * tw + rx, ny = fy * tw + ry, nz = fz * tw + rz; // left plane normal (points inward)
    this.setPlaneN(2, nx, ny, nz, px, py, pz);
    nx = fx * tw - rx; ny = fy * tw - ry; nz = fz * tw - rz; // right
    this.setPlaneN(3, nx, ny, nz, px, py, pz);
    nx = fx * th - ux; ny = fy * th - uy; nz = fz * th - uz; // top
    this.setPlaneN(4, nx, ny, nz, px, py, pz);
    nx = fx * th + ux; ny = fy * th + uy; nz = fz * th + uz; // bottom
    this.setPlaneN(5, nx, ny, nz, px, py, pz);
    // corners
    const C = this.corners;
    let k = 0;
    for (const d of [near, far]) {
      const hh = d * th, hw = d * tw;
      for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
        C[k++] = px + fx * d + rx * hw * sx + ux * hh * sy;
        C[k++] = py + fy * d + ry * hw * sx + uy * hh * sy;
        C[k++] = pz + fz * d + rz * hw * sx + uz * hh * sy;
      }
    }
    this.count = 6;
    return this;
  }

  private setPlane(i: number, nx: number, ny: number, nz: number, x: number, y: number, z: number): void {
    const P = this.planes;
    P[i * 4] = nx; P[i * 4 + 1] = ny; P[i * 4 + 2] = nz;
    P[i * 4 + 3] = -(nx * x + ny * y + nz * z);
  }
  private setPlaneN(i: number, nx: number, ny: number, nz: number, x: number, y: number, z: number): void {
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this.setPlane(i, nx / l, ny / l, nz / l, x, y, z);
  }

  copy(o: ConvexVolume): this {
    this.planes.set(o.planes);
    this.corners.set(o.corners);
    this.count = o.count;
    return this;
  }

  /** Sphere test: 0 = outside, 1 = intersecting, 2 = fully inside. */
  sphere(x: number, y: number, z: number, r: number): number {
    const P = this.planes;
    let inside = 2;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const d = P[o] * x + P[o + 1] * y + P[o + 2] * z + P[o + 3];
      if (d < -r) return 0;
      if (d < r) inside = 1;
    }
    return inside;
  }

  /** AABB test: 0 outside, 1 intersecting, 2 inside. */
  aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    const P = this.planes;
    let result = 2;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const nx = P[o], ny = P[o + 1], nz = P[o + 2], d = P[o + 3];
      // positive vertex
      const vx = nx >= 0 ? maxX : minX, vy = ny >= 0 ? maxY : minY, vz = nz >= 0 ? maxZ : minZ;
      if (nx * vx + ny * vy + nz * vz + d < 0) return 0;
      const wx = nx >= 0 ? minX : maxX, wy = ny >= 0 ? minY : maxY, wz = nz >= 0 ? minZ : maxZ;
      if (nx * wx + ny * wy + nz * wz + d < 0) result = 1;
    }
    return result;
  }

  /** Capsule (segment a→b with radius r) intersects the volume (conservative per-plane test). */
  capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    const P = this.planes;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const da = P[o] * ax + P[o + 1] * ay + P[o + 2] * az + P[o + 3];
      const db = P[o] * bx + P[o + 1] * by + P[o + 2] * bz + P[o + 3];
      if (da < -r && db < -r) return false;
    }
    return true;
  }

  /** XZ bounding box of the corners. */
  xzBounds(out: Float64Array | number[]): void {
    const C = this.corners;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = C[i * 3], y = C[i * 3 + 1], z = C[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    out[0] = minX; out[1] = minZ; out[2] = maxX; out[3] = maxZ; out[4] = minY; out[5] = maxY;
  }

  /** Quantized hash of the planes (for query-result caching keyed by exact observation). */
  hash(quant = 200): number {
    let h = 2166136261;
    const P = this.planes;
    for (let i = 0; i < this.count * 4; i++) {
      h ^= Math.round(P[i] * quant);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
}
