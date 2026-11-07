/**
 * Third-person follow camera. Produces a camera pose; the Observation built from
 * it is what drives every demand-driven query.
 */
import { clamp, damp, dampAngle } from '../util/math';
import { TerrainField } from '../world/TerrainField';

export class CameraController {
  yaw = Math.PI; // orbit angle around the player (0 = camera on +Z side)
  pitch = 0.32;
  distance = 5.6;
  targetDistance = 5.6;
  x = 0; y = 0; z = 0;
  tx = 0; ty = 0; tz = 0;
  private lastLook = -10;
  autoFollow = true;
  occlusion = 1;
  private initialized = false;

  look(dx: number, dy: number, zoom: number, time: number): void {
    if (dx !== 0 || dy !== 0) this.lastLook = time;
    this.yaw -= dx * 0.0055;
    this.pitch = clamp(this.pitch + dy * 0.0042, -0.35, 1.25);
    if (zoom !== 0) this.targetDistance = clamp(this.targetDistance + zoom * 0.01, 2.8, 14);
  }

  /** Forward direction on the ground plane the player should move relative to. */
  groundForward(out: { x: number; z: number }): void {
    out.x = -Math.sin(this.yaw);
    out.z = -Math.cos(this.yaw);
  }

  update(px: number, py: number, pz: number, playerYaw: number, moving: boolean, dt: number, time: number, terrain: TerrainField,
    occlude: ((ax: number, ay: number, az: number, bx: number, by: number, bz: number) => number) | null): void {
    // gently swing behind a moving runner if the user is not steering the camera
    if (this.autoFollow && moving && time - this.lastLook > 1.6) {
      const behind = playerYaw + Math.PI;
      this.yaw = dampAngle(this.yaw, behind, 1.2, dt);
    }
    const tx = px, ty = py + 1.55, tz = pz;
    if (!this.initialized) { this.tx = tx; this.ty = ty; this.tz = tz; this.initialized = true; }
    this.tx = damp(this.tx, tx, 14, dt);
    this.ty = damp(this.ty, ty, 9, dt);
    this.tz = damp(this.tz, tz, 14, dt);
    this.distance = damp(this.distance, this.targetDistance, 6, dt);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dx = Math.sin(this.yaw) * cp, dy = sp, dz = Math.cos(this.yaw) * cp;
    let d = this.distance;
    if (occlude) {
      const f = occlude(this.tx, this.ty, this.tz, this.tx + dx * d, this.ty + dy * d, this.tz + dz * d);
      this.occlusion = damp(this.occlusion, f, f < this.occlusion ? 20 : 3, dt);
      d *= Math.max(0.35, this.occlusion);
    }
    let cx = this.tx + dx * d, cy = this.ty + dy * d, cz = this.tz + dz * d;
    const ground = terrain.height(cx, cz) + 0.7;
    if (cy < ground) cy = ground;
    this.x = cx; this.y = cy; this.z = cz;
  }

  /** Directly set pose (benchmarks / scripted cameras). */
  setPose(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
    this.x = x; this.y = y; this.z = z;
    this.tx = tx; this.ty = ty; this.tz = tz;
    this.initialized = true;
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0.32;
    this.initialized = false;
  }
}
