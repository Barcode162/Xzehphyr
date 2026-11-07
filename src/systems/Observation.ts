/**
 * An observation request: what a camera (or any observer) wants to know.
 * Renderer-agnostic — built from plain numbers.
 */
import { ConvexVolume } from '../spatial/Frustum';

export class Observation {
  frame = 0;
  px = 0; py = 0; pz = 0;
  fx = 0; fy = 0; fz = 1;
  ux = 0; uy = 1; uz = 0;
  rx = 1; ry = 0; rz = 0;
  fovY = 1;
  aspect = 1;
  near = 0.1;
  far = 360;
  volume = new ConvexVolume();
  /** Quantized hash of the observation (exact-repeat detection for caches). */
  hash = 0;
  /** LOD distance multiplier (quality setting). */
  lodScale = 1;

  /** Set from yaw/pitch camera description. */
  setFromLook(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fovY: number, aspect: number, near: number, far: number): void {
    this.px = px; this.py = py; this.pz = pz;
    let fx = tx - px, fy = ty - py, fz = tz - pz;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // right = normalize(forward x worldUp)
    let rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    // up = right x forward
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    this.fx = fx; this.fy = fy; this.fz = fz;
    this.rx = rx; this.ry = ry; this.rz = rz;
    this.ux = ux; this.uy = uy; this.uz = uz;
    this.fovY = fovY; this.aspect = aspect; this.near = near; this.far = far;
    this.volume.setFromPerspective(px, py, pz, fx, fy, fz, ux, uy, uz, rx, ry, rz, fovY, aspect, near, far);
    this.hash = this.volume.hash(400);
  }

  /** Build a truncated copy of this observation's frustum (e.g. shadow receiver region). */
  truncated(out: ConvexVolume, far: number): ConvexVolume {
    return out.setFromPerspective(this.px, this.py, this.pz, this.fx, this.fy, this.fz, this.ux, this.uy, this.uz, this.rx, this.ry, this.rz, this.fovY, this.aspect, this.near, far);
  }
}
