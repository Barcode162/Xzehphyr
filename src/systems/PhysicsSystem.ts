/**
 * COLLISION & PHYSICS — independent evaluation system.
 *
 * Uses its *own* representation: analytic shapes derived from physical
 * descriptors (vertical cylinders for trunks/posts, spheres for rocks, a deck
 * box with rails for bridges) and the analytic terrain field. No visual mesh is
 * ever consulted, and none needs to exist for collision to work.
 *
 * Broadphase: spatial discovery over Collider-flagged entities, cached per
 * 4 m cell of the character position (query region = cell expanded by a margin,
 * so the cached candidate set is valid anywhere inside the cell).
 */
import { Discovery } from '../spatial/Discovery';
import { QueryCache, cacheKey } from '../spatial/QueryCache';
import { WorldDatabase } from '../world/WorldDatabase';
import { FrameSystem } from '../world/FrameSystem';
import { TerrainField } from '../world/TerrainField';
import { ColliderShape, Flag, FrameMode, Kind, SurfaceType } from '../world/types';
import { IntList, clamp, quatRotateInv, yawFromQuat } from '../util/math';
import { profiler, Scope, counters } from '../diagnostics/Profiler';
import { CurveProjection } from '../world/Curve';

export interface MoveIntent {
  /** Desired world-space horizontal direction (unit or zero). */
  dirX: number;
  dirZ: number;
  /** 0..1 magnitude (walk below ~0.6, run above). */
  magnitude: number;
  sprint: boolean;
  jump: boolean;
}

export interface Contact {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  entity: number;
}

export class CharacterBody {
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0;
  grounded = false;
  surface: SurfaceType = 'dirt';
  inWater = false;
  onBridge = -1;
  speed = 0;
  /** Distance travelled on the ground (drives the gait cycle). */
  stride = 0;
  jumpCount = 0;
  landedImpulse = 0;
  airTime = 0;
}

export class PhysicsSystem {
  readonly radius = 0.38;
  readonly height = 1.8;
  walkSpeed = 3.0;
  runSpeed = 6.8;
  sprintSpeed = 9.5;
  gravity = 25;
  jumpVelocity = 8.6;
  readonly candidates = new IntList(256);
  readonly contacts: Contact[] = [];
  /** Broadphase box (debug): minX, minY, minZ, maxX, maxY, maxZ. */
  readonly broadphase = new Float64Array(6);
  frameChanges = 0;
  lastFrameName = '';
  private cell = 4;
  private margin = 4;
  private tmp = new Float64Array(4);
  private proj: CurveProjection = { s: 0, lateral: 0, dist: 0, seg: 0 };
  steps = 0;
  fromCache = false;

  constructor(
    private db: WorldDatabase,
    private frames: FrameSystem,
    private terrain: TerrainField,
    private discovery: Discovery,
    private qcache: QueryCache,
    private trail: number,
    private regionAt: (x: number, z: number) => number,
    private worldHalf: number,
  ) {
    for (let i = 0; i < 16; i++) this.contacts.push({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, entity: -1 });
  }
  contactCount = 0;

  /** Read the character's world pose from its relational reference. */
  readBody(entity: number, body: CharacterBody): void {
    const o = this.frames.resolve(entity);
    const W = this.frames.world;
    body.x = W[o]; body.y = W[o + 1]; body.z = W[o + 2];
    body.yaw = yawFromQuat(W, o + 3);
  }

  private broadphaseQuery(x: number, y: number, z: number): IntList {
    profiler.begin(Scope.PhysQuery);
    const c = this.cell, m = this.margin;
    const qx = Math.floor(x / c), qz = Math.floor(z / c), qy = Math.floor(y / 8);
    const key = cacheKey(qx, qz, qy, 0x50485953);
    profiler.begin(Scope.CacheLookup);
    let list = this.qcache.lookup(key, this.discovery.index, this.db.structureVersion);
    profiler.end(Scope.CacheLookup);
    this.fromCache = list !== null;
    const bp = this.broadphase;
    bp[0] = qx * c - m; bp[1] = qy * 8 - 12; bp[2] = qz * c - m;
    bp[3] = (qx + 1) * c + m; bp[4] = (qy + 1) * 8 + 12; bp[5] = (qz + 1) * c + m;
    if (!list) {
      this.candidates.clear();
      this.discovery.aabb(bp[0], bp[1], bp[2], bp[3], bp[4], bp[5], Flag.Collider, this.candidates);
      list = this.candidates;
      this.qcache.store(key, list, this.discovery.lastMask, this.discovery.index, this.db.structureVersion);
    }
    if (this.fromCache) counters.qcacheHits++; else counters.qcacheMisses++;
    counters.colliderCandidates = list.length;
    profiler.end(Scope.PhysQuery);
    return list;
  }

  private addContact(x: number, y: number, z: number, nx: number, ny: number, nz: number, e: number): void {
    if (this.contactCount >= this.contacts.length) return;
    const c = this.contacts[this.contactCount++];
    c.x = x; c.y = y; c.z = z; c.nx = nx; c.ny = ny; c.nz = nz; c.entity = e;
  }

  /** One fixed physics step for a character. */
  step(body: CharacterBody, intent: MoveIntent, dt: number): void {
    if (!(dt > 0)) return;
    profiler.begin(Scope.Physics);
    this.steps++;
    this.contactCount = 0;
    const db = this.db, frames = this.frames, terrain = this.terrain;
    // --- desired velocity
    let target = intent.magnitude < 0.62 ? this.walkSpeed * (intent.magnitude / 0.62) : this.runSpeed;
    if (intent.sprint && intent.magnitude > 0.3) target = this.sprintSpeed;
    if (body.inWater) target *= 0.55;
    const rate = body.grounded ? 11 : 2.2;
    const tvx = intent.dirX * target, tvz = intent.dirZ * target;
    const k = 1 - Math.exp(-rate * dt);
    body.vx += (tvx - body.vx) * k;
    body.vz += (tvz - body.vz) * k;
    if (intent.jump && (body.grounded || body.inWater)) {
      body.vy = this.jumpVelocity * (body.inWater ? 0.7 : 1);
      body.grounded = false;
      body.jumpCount++;
    }
    body.vy -= this.gravity * dt;
    let nx = body.x + body.vx * dt;
    let ny = body.y + body.vy * dt;
    let nz = body.z + body.vz * dt;

    // --- broadphase
    const list = this.broadphaseQuery(nx, ny, nz);
    const W = frames.world;
    const R = this.radius;
    let support = -Infinity;
    let supportSurface: SurfaceType | null = null;
    let onBridge = -1;
    for (let i = 0; i < list.length; i++) {
      const e = list.data[i];
      const pi = db.physical[e];
      if (pi < 0) continue;
      const phys = db.physicals[pi];
      const o = frames.resolve(e);
      const ex = W[o], ey = W[o + 1], ez = W[o + 2], s = W[o + 7];
      const so = e * 3;
      switch (phys.shape) {
        case ColliderShape.Cylinder: {
          const cr = phys.dims[0] * s * Math.max(db.shape[so], db.shape[so + 2]);
          const ch = phys.dims[1] * s * db.shape[so + 1];
          if (ny > ey + ch || ny + this.height < ey - 0.5) break;
          const dx = nx - ex, dz = nz - ez;
          const d2 = dx * dx + dz * dz;
          const minD = cr + R;
          if (d2 < minD * minD) {
            const d = Math.sqrt(d2) || 1e-4;
            const ux = dx / d, uz = dz / d;
            nx = ex + ux * minD;
            nz = ez + uz * minD;
            const vn = body.vx * ux + body.vz * uz;
            if (vn < 0) { body.vx -= vn * ux; body.vz -= vn * uz; }
            this.addContact(ex + ux * cr, ny + 1, ez + uz * cr, ux, 0, uz, e);
          }
          break;
        }
        case ColliderShape.Sphere: {
          const sr = phys.dims[0] * s * Math.max(db.shape[so], db.shape[so + 2]);
          const scy = ey + phys.dims[1] * s * db.shape[so + 1];
          // closest point on the character's vertical segment
          const segLo = ny + R, segHi = ny + this.height - R;
          const py = clamp(scy, segLo, segHi);
          const dx = nx - ex, dy = py - scy, dz = nz - ez;
          const d2 = dx * dx + dy * dy + dz * dz;
          const minD = sr + R;
          if (d2 < minD * minD) {
            const d = Math.sqrt(d2) || 1e-4;
            const ux = dx / d, uy = dy / d, uz = dz / d;
            if (uy > 0.55) {
              // standing on top of a rock
              const top = scy + Math.sqrt(Math.max(0, minD * minD - dx * dx - dz * dz)) - R;
              if (top > support) { support = top; supportSurface = phys.surface; }
            } else {
              const push = minD - d;
              nx += ux * push; nz += uz * push;
              const vn = body.vx * ux + body.vz * uz;
              if (vn < 0) { body.vx -= vn * ux; body.vz -= vn * uz; }
            }
            this.addContact(ex + ux * sr, scy + uy * sr, ez + uz * sr, ux, uy, uz, e);
          }
          break;
        }
        case ColliderShape.BridgeDeck: {
          const [halfLen, halfW, , railH] = phys.dims;
          // into the bridge frame
          quatRotateInv(W, o + 3, nx - ex, ny - ey, nz - ez, this.tmp, 0);
          const lx = this.tmp[0], ly = this.tmp[1], lz = this.tmp[2];
          if (Math.abs(lz) <= halfLen + 0.2 && Math.abs(lx) <= halfW + 0.6) {
            if (ly > -0.65 && ly < 0.9) {
              const top = ey; // deck surface at the bridge origin height
              if (top > support) { support = top; supportSurface = 'wood'; onBridge = e; }
              // rails keep the runner on the deck
              if (Math.abs(lz) < halfLen - 0.3 && ly < railH && Math.abs(lx) > halfW - R) {
                const clx = Math.sign(lx) * (halfW - R);
                const c = Math.cos(yawFromQuat(W, o + 3)), sn = Math.sin(yawFromQuat(W, o + 3));
                const dlx = clx - lx;
                nx += dlx * c; nz += -dlx * sn;
                this.addContact(nx, ny + 1, nz, -Math.sign(lx) * c, 0, Math.sign(lx) * sn, e);
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }
    // --- terrain support (analytic field)
    const th = terrain.height(nx, nz);
    if (th > support) { support = th; supportSurface = null; }
    const wasGrounded = body.grounded;
    const snap = wasGrounded && body.vy <= 0 ? 0.45 : 0.02;
    if (ny <= support + snap && body.vy <= 0.5) {
      if (!wasGrounded) body.landedImpulse = Math.min(1, -body.vy / 14);
      ny = support;
      body.vy = 0;
      body.grounded = true;
      body.airTime = 0;
    } else {
      body.grounded = false;
      body.airTime += dt;
    }
    // --- water
    const wl = terrain.waterLevel(nx, nz);
    body.inWater = wl > ny + 0.15 && onBridge < 0;
    // --- world bounds
    const lim = this.worldHalf - 2;
    nx = clamp(nx, -lim, lim);
    nz = clamp(nz, -lim, lim);
    const hs = Math.hypot(nx - body.x, nz - body.z);
    if (body.grounded) body.stride += hs;
    body.speed = hs / dt;
    body.x = nx; body.y = ny; body.z = nz;
    body.onBridge = onBridge;
    body.surface = supportSurface ?? (body.inWater ? 'water' : terrain.surfaceAt(nx, nz, ny));
    profiler.end(Scope.Physics);
  }

  /**
   * Write the body back into the world database, choosing the most meaningful
   * reference frame: bridge (Local) > trail (Curve) > region (Grounded).
   * This is a *reference change* whenever the chosen frame differs from the current one.
   */
  writeBack(entity: number, body: CharacterBody): void {
    const db = this.db;
    const prevParent = db.parent[entity];
    let parent: number;
    let mode: FrameMode;
    let hint = -1;
    if (body.onBridge >= 0) {
      parent = body.onBridge; mode = FrameMode.Local;
    } else {
      const curve = db.curves.get(this.trail)!;
      const p = prevParent === this.trail
        ? curve.projectNear(body.x, body.z, db.local[entity * 8], 6, this.proj)
        : curve.nearest(body.x, body.z, this.proj);
      if (p.dist < this.terrain.trailHalfWidth + 0.6) {
        parent = this.trail; mode = FrameMode.Curve;
        hint = prevParent === this.trail ? db.local[entity * 8] : p.s;
      } else {
        parent = this.regionAt(body.x, body.z); mode = FrameMode.Grounded;
      }
    }
    if (parent !== prevParent) this.frameChanges++;
    this.frames.reexpress(entity, parent, mode, body.x, body.y, body.z, body.yaw, hint);
    this.lastFrameName = db.names.get(parent) ?? `${Kind[db.kind[parent]]} #${parent}`;
  }

  /** Segment vs trunk cylinders (camera occlusion). Returns the hit fraction (1 = clear). */
  raycastTrunks(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad: number): number {
    const db = this.db, frames = this.frames, W = frames.world;
    const minX = Math.min(ax, bx) - 2, maxX = Math.max(ax, bx) + 2;
    const minZ = Math.min(az, bz) - 2, maxZ = Math.max(az, bz) + 2;
    this.rayList.clear();
    profiler.begin(Scope.PhysQuery);
    this.discovery.aabb(minX, Math.min(ay, by) - 20, minZ, maxX, Math.max(ay, by) + 5, maxZ, Flag.Collider, this.rayList);
    profiler.end(Scope.PhysQuery);
    let best = 1;
    const dx = bx - ax, dz = bz - az;
    const a2 = dx * dx + dz * dz;
    if (a2 < 1e-6) return 1;
    for (let i = 0; i < this.rayList.length; i++) {
      const e = this.rayList.data[i];
      const pi = db.physical[e];
      if (pi < 0) continue;
      const phys = db.physicals[pi];
      if (phys.shape !== ColliderShape.Cylinder) continue;
      const o = frames.resolve(e);
      const s = W[o + 7];
      const r = phys.dims[0] * s + pad;
      const h = phys.dims[1] * s;
      const fx = ax - W[o], fz = az - W[o + 2];
      const b = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - r * r;
      const disc = b * b - 4 * a2 * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a2);
      if (t < 0 || t > best) continue;
      const y = ay + (by - ay) * t;
      if (y < W[o + 1] - 1 || y > W[o + 1] + h) continue;
      best = t;
    }
    return best;
  }
  private rayList = new IntList(128);
}
