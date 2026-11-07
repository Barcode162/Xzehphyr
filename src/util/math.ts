/**
 * Small allocation-free math helpers working on plain numbers and typed arrays.
 * The world database stores transforms as packed Float32/Float64 arrays rather
 * than as Three.js objects, so the world representation is renderer independent.
 */

export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Exponential smoothing factor independent of frame rate. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function angleWrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const d = angleWrap(target - current);
  return current + d * (1 - Math.exp(-lambda * dt));
}

/** Quaternion from yaw (rotation about +Y). Writes into out at offset. */
export function quatFromYaw(out: Float64Array | Float32Array | number[], o: number, yaw: number): void {
  const h = yaw * 0.5;
  out[o] = 0;
  out[o + 1] = Math.sin(h);
  out[o + 2] = 0;
  out[o + 3] = Math.cos(h);
}

/** Quaternion multiply a*b -> out (all as 4-tuples at offsets). Safe for aliasing via temporaries. */
export function quatMul(
  a: ArrayLike<number>, ao: number,
  b: ArrayLike<number>, bo: number,
  out: Float64Array | Float32Array | number[], oo: number,
): void {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[oo] = ax * bw + aw * bx + ay * bz - az * by;
  out[oo + 1] = ay * bw + aw * by + az * bx - ax * bz;
  out[oo + 2] = az * bw + aw * bz + ax * by - ay * bx;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Rotate vector (vx,vy,vz) by quaternion q at offset qo. Writes into out[oo..oo+2]. */
export function quatRotate(
  q: ArrayLike<number>, qo: number,
  vx: number, vy: number, vz: number,
  out: Float64Array | Float32Array | number[], oo: number,
): void {
  const qx = q[qo], qy = q[qo + 1], qz = q[qo + 2], qw = q[qo + 3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[oo] = vx + qw * tx + (qy * tz - qz * ty);
  out[oo + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[oo + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** Inverse-rotate (conjugate) vector by quaternion. */
export function quatRotateInv(
  q: ArrayLike<number>, qo: number,
  vx: number, vy: number, vz: number,
  out: Float64Array | Float32Array | number[], oo: number,
): void {
  const qx = -q[qo], qy = -q[qo + 1], qz = -q[qo + 2], qw = q[qo + 3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[oo] = vx + qw * tx + (qy * tz - qz * ty);
  out[oo + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[oo + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** Yaw angle (about +Y) extracted from a quaternion. */
export function yawFromQuat(q: ArrayLike<number>, o: number): number {
  const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}

/**
 * Write a column-major 4x4 matrix (Three.js / WebGL layout) from position,
 * quaternion and non-uniform scale into out at offset (16 floats).
 */
export function composeMatrix(
  out: Float32Array, o: number,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number, qw: number,
  sx: number, sy: number, sz: number,
): void {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = px;
  out[o + 13] = py;
  out[o + 14] = pz;
  out[o + 15] = 1;
}

/** Fast yaw-only matrix compose (most vegetation instances only rotate about Y). */
export function composeYawMatrix(
  out: Float32Array, o: number,
  px: number, py: number, pz: number,
  yaw: number, sx: number, sy: number, sz: number,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[o] = c * sx; out[o + 1] = 0; out[o + 2] = -s * sx; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = sy; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = s * sz; out[o + 9] = 0; out[o + 10] = c * sz; out[o + 11] = 0;
  out[o + 12] = px; out[o + 13] = py; out[o + 14] = pz; out[o + 15] = 1;
}

/** Growable typed array helper for allocation-light result lists. */
export class IntList {
  data: Int32Array;
  length = 0;
  constructor(capacity = 256) {
    this.data = new Int32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const n = new Int32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    this.data[this.length++] = v;
  }
  clear(): void {
    this.length = 0;
  }
  copyFrom(other: IntList): void {
    if (this.data.length < other.length) this.data = new Int32Array(Math.max(other.length, this.data.length * 2));
    this.data.set(other.data.subarray(0, other.length));
    this.length = other.length;
  }
  get byteSize(): number {
    return this.data.byteLength;
  }
}

/** Growable float array for instance matrices etc. */
export class FloatList {
  data: Float32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Float32Array(capacity);
  }
  ensure(extra: number): void {
    const need = this.length + extra;
    if (need > this.data.length) {
      let cap = this.data.length * 2;
      while (cap < need) cap *= 2;
      const n = new Float32Array(cap);
      n.set(this.data.subarray(0, this.length));
      this.data = n;
    }
  }
  clear(): void {
    this.length = 0;
  }
}
