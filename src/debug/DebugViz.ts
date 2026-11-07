/**
 * DEVELOPER VISUALIZATION — makes the invisible architecture visible.
 *
 * Every overlay is drawn from engine/system state, never from the renderer:
 *   entity references (points colored by which systems requested them),
 *   reference frames (axis triads), parent/child + typed relationships,
 *   spatial index nodes (visited by which query), camera observation region,
 *   shadow receiver region + shadow capsules, light influence spheres,
 *   collision broadphase/candidates/contacts, and geometry state
 *   (generated recently / cached / unresolved).
 * Use the observer (god) view to watch requested information change as the
 * player camera moves.
 */
import * as THREE from 'three';
import { Engine } from '../engine/Engine';
import { LAYER_DEBUG } from '../render/Stage';
import { Flag, FrameMode, Kind, Rel, ColliderShape, Family } from '../world/types';
import { IntList } from '../util/math';
import { keyOf } from '../geometry/GeometryStore';

export interface DebugToggles {
  entities: boolean;
  frames: boolean;
  relations: boolean;
  index: boolean;
  observation: boolean;
  lights: boolean;
  shadows: boolean;
  collision: boolean;
  generated: boolean;
  cached: boolean;
  unresolved: boolean;
}

export const TOGGLE_LABELS: Record<keyof DebugToggles, [string, string]> = {
  entities: ['World entity references', 'Points: grey = data only · green = visible · violet = shadow-only · red = collider candidate · cyan = audible · yellow = active light'],
  frames: ['Local coordinate frames', 'Axis triads (R=X, G=Y, B=Z) at reference frames: regions, trail stations, bridges, player and its current parent frame'],
  relations: ['Parent–child relationships', 'White: spatial parent links near the player. Orange: typed relations (PerchedOn, On, Spans, Illuminates)'],
  index: ['Spatial index regions', 'Quadtree nodes visited this frame — green: camera, violet: shadow, red: collision, yellow: lights, cyan: audio'],
  observation: ['Camera observation region', 'Player-camera frustum (white) and shadow receiver region (violet)'],
  lights: ['Light influence regions', 'Influence spheres: yellow = selected into the light pool, dim = considered/rejected. Sun direction arrow'],
  shadows: ['Shadow contributors', 'Off-screen casters whose swept shadow capsule reaches the receiver region; candidate search region box'],
  collision: ['Collision queries', 'Broadphase box (red), candidate colliders (orange, analytic shapes), contacts (white normals)'],
  generated: ['Generated geometry', 'Bright green markers/outlines: representation generated in the last second'],
  cached: ['Cached geometry', 'Blue markers/outlines: representation served from the geometry cache'],
  unresolved: ['Unresolved procedural geometry', 'Grey markers: requested but not yet generated (time budget) — the entity exists only as data'],
};

export class DebugViz {
  toggles: DebugToggles = {
    entities: true, frames: false, relations: false, index: true, observation: true, lights: false,
    shadows: true, collision: false, generated: true, cached: false, unresolved: true,
  };
  enabled = false;
  private lines: THREE.LineSegments;
  private lpos: Float32Array;
  private lcol: Float32Array;
  private ln = 0;
  private readonly maxLines = 120000;
  private points: THREE.Points;
  private ppos: Float32Array;
  private pcol: Float32Array;
  private pn = 0;
  private readonly maxPoints = 140000;
  private visited = new IntList(4096);
  private tmp = new Float64Array(8);
  /** Entity → bit flags of requesting systems this frame (for the entity point cloud). */
  private reqBits = new Uint8Array(0);

  constructor(private engine: Engine) {
    this.lpos = new Float32Array(this.maxLines * 6);
    this.lcol = new Float32Array(this.maxLines * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.lpos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lcol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85, fog: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.layers.set(LAYER_DEBUG);
    this.ppos = new Float32Array(this.maxPoints * 3);
    this.pcol = new Float32Array(this.maxPoints * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.ppos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pcol, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ vertexColors: true, size: 3, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.9, fog: false }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 1000;
    this.points.layers.set(LAYER_DEBUG);
    engine.stage.scene.add(this.lines, this.points);
    this.setEnabled(false);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.lines.visible = v;
    this.points.visible = v;
    this.engine.debugCollect = v;
    this.engine.index.recordVisited = v && this.toggles.index ? this.visited : null;
  }

  /** Re-attach after a world reload (new index instance). */
  rebind(): void {
    this.setEnabled(this.enabled);
  }

  // ------------------------------------------------------------------ primitives
  private line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number): void {
    if (this.ln >= this.maxLines) return;
    const o = this.ln * 6;
    const P = this.lpos, C = this.lcol;
    P[o] = ax; P[o + 1] = ay; P[o + 2] = az; P[o + 3] = bx; P[o + 4] = by; P[o + 5] = bz;
    C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = r; C[o + 4] = g; C[o + 5] = b;
    this.ln++;
  }
  private box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, g: number, b: number): void {
    this.line(x0, y0, z0, x1, y0, z0, r, g, b); this.line(x1, y0, z0, x1, y0, z1, r, g, b);
    this.line(x1, y0, z1, x0, y0, z1, r, g, b); this.line(x0, y0, z1, x0, y0, z0, r, g, b);
    this.line(x0, y1, z0, x1, y1, z0, r, g, b); this.line(x1, y1, z0, x1, y1, z1, r, g, b);
    this.line(x1, y1, z1, x0, y1, z1, r, g, b); this.line(x0, y1, z1, x0, y1, z0, r, g, b);
    this.line(x0, y0, z0, x0, y1, z0, r, g, b); this.line(x1, y0, z0, x1, y1, z0, r, g, b);
    this.line(x1, y0, z1, x1, y1, z1, r, g, b); this.line(x0, y0, z1, x0, y1, z1, r, g, b);
  }
  private rect(x0: number, z0: number, x1: number, z1: number, y: number, r: number, g: number, b: number): void {
    this.line(x0, y, z0, x1, y, z0, r, g, b); this.line(x1, y, z0, x1, y, z1, r, g, b);
    this.line(x1, y, z1, x0, y, z1, r, g, b); this.line(x0, y, z1, x0, y, z0, r, g, b);
  }
  private circle(cx: number, cy: number, cz: number, rad: number, seg: number, r: number, g: number, b: number, plane: 0 | 1 | 2 = 0): void {
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a) * rad, s = Math.sin(a) * rad;
      const x = plane === 0 ? cx + c : plane === 1 ? cx + c : cx;
      const y = plane === 0 ? cy : plane === 1 ? cy + s : cy + c;
      const z = plane === 0 ? cz + s : plane === 1 ? cz : cz + s;
      if (i > 0) this.line(px, py, pz, x, y, z, r, g, b);
      px = x; py = y; pz = z;
    }
  }
  private axes(e: number, size: number): void {
    const fs = this.engine.world.frames;
    const o = fs.resolve(e);
    const W = fs.world;
    const x = W[o], y = W[o + 1], z = W[o + 2];
    const qx = W[o + 3], qy = W[o + 4], qz = W[o + 5], qw = W[o + 6];
    const rot = (vx: number, vy: number, vz: number) => {
      const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
      return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
    };
    const ax = rot(size, 0, 0), ay = rot(0, size, 0), az = rot(0, 0, size);
    this.line(x, y, z, x + ax[0], y + ax[1], z + ax[2], 1, 0.2, 0.2);
    this.line(x, y, z, x + ay[0], y + ay[1], z + ay[2], 0.2, 1, 0.2);
    this.line(x, y, z, x + az[0], y + az[1], z + az[2], 0.3, 0.5, 1);
  }
  private point(x: number, y: number, z: number, r: number, g: number, b: number): void {
    if (this.pn >= this.maxPoints) return;
    const o = this.pn * 3;
    this.ppos[o] = x; this.ppos[o + 1] = y; this.ppos[o + 2] = z;
    this.pcol[o] = r; this.pcol[o + 1] = g; this.pcol[o + 2] = b;
    this.pn++;
  }
  private marker(x: number, y: number, z: number, s: number, r: number, g: number, b: number): void {
    this.line(x - s, y, z, x + s, y, z, r, g, b);
    this.line(x, y - s, z, x, y + s, z, r, g, b);
    this.line(x, y, z - s, x, y, z + s, r, g, b);
  }

  // ------------------------------------------------------------------ frame
  update(): void {
    if (!this.enabled) return;
    const E = this.engine;
    const w = E.world;
    const db = w.db, fs = w.frames;
    const T = this.toggles;
    this.ln = 0;
    this.pn = 0;
    E.index.recordVisited = T.index ? this.visited : null;
    const rel = E.flags.presenter === 'relational';
    const frame = E.frame;
    const px = E.body.x, py = E.body.y, pz = E.body.z;

    // per-entity request bits
    if (this.reqBits.length < db.capacity) this.reqBits = new Uint8Array(db.capacity);
    const bits = this.reqBits;
    bits.fill(0, 0, db.count);
    if (rel) {
      for (let i = 0; i < E.vis.visible.length; i++) bits[E.vis.visible.data[i]] |= 1;
      for (let i = 0; i < E.shadow.shadowOnly.length; i++) bits[E.shadow.shadowOnly.data[i]] |= 2;
    }
    for (let i = 0; i < E.physics.candidates.length; i++) bits[E.physics.candidates.data[i]] |= 4;
    for (const a of E.audio.audible) bits[a.entity] |= 8;
    for (const l of E.lighting.active) bits[l.entity] |= 16;

    // 1. entity references
    if (T.entities) {
      const B = this.tmp;
      for (let e = 0; e < db.count; e++) {
        const f = db.flags[e];
        if ((f & (Flag.Visual | Flag.EmitsSound | Flag.EmitsLight | Flag.Collider)) === 0) continue;
        if ((f & Flag.Terrain) !== 0) continue;
        fs.bounds(e, B, 0);
        const b = bits[e];
        let r = 0.45, g = 0.45, bl = 0.5;
        if (b & 16) { r = 1; g = 0.9; bl = 0.2; }
        else if (b & 8) { r = 0.2; g = 0.95; bl = 1; }
        else if (b & 4) { r = 1; g = 0.25; bl = 0.25; }
        else if (b & 2) { r = 0.75; g = 0.35; bl = 1; }
        else if (b & 1) { r = 0.3; g = 1; bl = 0.4; }
        this.point(B[0], B[1], B[2], r, g, bl);
      }
    }

    // 2. reference frames
    if (T.frames) {
      for (let i = 0; i < w.regions.length; i++) this.axes(w.regions[i], 6);
      for (const b of w.bridges) this.axes(b, 4);
      for (let s = 0; s < w.trailCurve.length; s += 25) {
        const t = [0, 0, 0, 0];
        w.trailCurve.sample(s, t);
        const h = t[2];
        const x = t[0], z = t[1], y = t[3] + 0.3;
        this.line(x, y, z, x + Math.cos(h) * 2, y, z - Math.sin(h) * 2, 1, 0.2, 0.2);
        this.line(x, y, z, x, y + 2, z, 0.2, 1, 0.2);
        this.line(x, y, z, x + Math.sin(h) * 2, y, z + Math.cos(h) * 2, 0.3, 0.5, 1);
      }
      this.axes(w.player, 1.2);
      const p = db.parent[w.player];
      if (p >= 0 && db.kind[p] !== Kind.Trail) this.axes(p, 5);
      // highlight the trail-relative station of the player
      if (db.mode[w.player] === FrameMode.Curve) {
        const t = [0, 0, 0, 0];
        w.trailCurve.sample(db.local[w.player * 8], t);
        this.line(t[0], t[3], t[1], px, py + 0.1, pz, 1, 1, 0.3);
        this.marker(t[0], t[3] + 0.1, t[1], 0.5, 1, 1, 0.3);
      }
    }

    // 3. relationships near the player
    if (T.relations) {
      const R2 = 45 * 45;
      const B = this.tmp;
      for (let e = 0; e < db.count; e++) {
        const k = db.kind[e];
        if (k === Kind.Region || k === Kind.Forest || k === Kind.Root || k === Kind.TerrainPatch) continue;
        fs.bounds(e, B, 0);
        const dx = B[0] - px, dz = B[2] - pz;
        if (dx * dx + dz * dz > R2 && e !== w.player) continue;
        const p = db.parent[e];
        if (p >= 0) {
          const po = fs.resolve(p);
          const W = fs.world;
          let tx = W[po], ty = W[po + 1], tz = W[po + 2];
          if (db.mode[e] === FrameMode.Curve) {
            const t = [0, 0, 0, 0];
            w.trailCurve.sample(db.local[e * 8], t);
            if (p === w.trail) { tx = t[0]; ty = t[3]; tz = t[1]; }
          }
          this.line(B[0], B[1], B[2], tx, ty, tz, 0.85, 0.85, 0.9);
        }
        db.forEachRelation(e, (type, to) => {
          if (type === Rel.PartOf) return;
          const o2 = fs.resolve(to);
          const W = fs.world;
          this.line(B[0], B[1], B[2], W[o2], W[o2 + 1] + 0.5, W[o2 + 2], 1, 0.6, 0.15);
        });
      }
    }

    // 4. spatial index nodes visited this frame (levels >= 4, drawn just above local ground)
    if (T.index) {
      const V = this.visited;
      const idx = E.index;
      const dec = [0, 0, 0];
      const terrain = w.terrain;
      for (let i = 0; i < V.length; i += 2) {
        const node = V.data[i], tag = V.data[i + 1];
        idx.decode(node, dec);
        const l = dec[0];
        if (l < 4) continue;
        const cs = idx.cellSize(l);
        const x0 = idx.minX + dec[1] * cs, z0 = idx.minZ + dec[2] * cs;
        const y = terrain.height(x0 + cs / 2, z0 + cs / 2) + 0.4 + (l - 4) * 0.25;
        let r = 0.3, g = 1, b = 0.4;
        if (tag === Flag.Collider) { r = 1; g = 0.3; b = 0.3; }
        else if (tag === Flag.CastsShadow) { r = 0.75; g = 0.4; b = 1; }
        else if (tag === Flag.EmitsLight) { r = 1; g = 0.9; b = 0.2; }
        else if (tag === Flag.EmitsSound) { r = 0.2; g = 0.9; b = 1; }
        const k = 0.45 + 0.55 * ((l - 4) / Math.max(1, idx.maxDepth - 4));
        const inset = (idx.maxDepth - l) * 0.3;
        this.rect(x0 + inset, z0 + inset, x0 + cs - inset, z0 + cs - inset, y, r * k, g * k, b * k);
      }
      V.clear();
    }

    // 5. observation region
    if (T.observation) {
      this.volumeLines(E.obs.volume.corners, 1, 1, 1);
      if (rel || true) this.volumeLines(E.shadow.receiver.corners, 0.75, 0.4, 1);
    }

    // 6. lights
    if (T.lights) {
      const L = E.lighting;
      for (let i = 0; i < L.candidates.length; i++) {
        const e = L.candidates.data[i];
        const li = db.light[e];
        if (li < 0) continue;
        const o = fs.resolve(e);
        const W = fs.world;
        const rad = db.lights[li].range;
        const active = L.active.some((a) => a.entity === e);
        const k = active ? 1 : 0.35;
        this.circle(W[o], W[o + 1] + 1.5, W[o + 2], rad, 24, k, k * 0.85, k * 0.2, 0);
        if (active) this.circle(W[o], W[o + 1] + 1.5, W[o + 2], rad, 24, 1, 0.85, 0.2, 1);
      }
      const sd = L.sunDir;
      this.line(px, py + 2, pz, px + sd[0] * 12, py + 2 + sd[1] * 12, pz + sd[2] * 12, 1, 0.85, 0.3);
    }

    // 7. shadow contributors
    if (T.shadows && rel) {
      const S = E.shadow;
      const c = S.capsules;
      for (let i = 0; i < S.shadowOnly.length; i++) {
        const ax = c[i * 6], ay = c[i * 6 + 1], az = c[i * 6 + 2];
        const dx = c[i * 6 + 3] - ax, dy = c[i * 6 + 4] - ay, dz = c[i * 6 + 5] - az;
        // follow the light direction until it reaches the ground under the caster
        const ground = w.terrain.height(ax, az);
        const t = dy < -1e-3 ? Math.min(1, (ground - ay) / dy) : 1;
        this.line(ax, ay, az, ax + dx * t, ay + dy * t, az + dz * t, 0.7, 0.35, 1);
        this.marker(ax, ay, az, 0.8, 0.85, 0.5, 1);
      }
      const R = S.region;
      this.rect(R[0], R[1], R[2], R[3], py + 0.5, 0.55, 0.3, 0.8);
    }

    // 8. collision
    if (T.collision) {
      const P = E.physics;
      const bp = P.broadphase;
      this.box(bp[0], bp[1], bp[2], bp[3], bp[4], bp[5], 1, 0.25, 0.25);
      for (let i = 0; i < P.candidates.length; i++) {
        const e = P.candidates.data[i];
        const pi = db.physical[e];
        if (pi < 0) continue;
        const ph = db.physicals[pi];
        const o = fs.resolve(e);
        const W = fs.world;
        const s = W[o + 7];
        if (ph.shape === ColliderShape.Cylinder) {
          const r = ph.dims[0] * s, h = Math.min(ph.dims[1] * s, 6);
          this.circle(W[o], W[o + 1] + 0.1, W[o + 2], r, 10, 1, 0.55, 0.15);
          this.circle(W[o], W[o + 1] + h, W[o + 2], r, 10, 1, 0.55, 0.15);
        } else if (ph.shape === ColliderShape.Sphere) {
          const so = e * 3;
          const r = ph.dims[0] * s * Math.max(db.shape[so], db.shape[so + 2]);
          const cy = W[o + 1] + ph.dims[1] * s * db.shape[so + 1];
          this.circle(W[o], cy, W[o + 2], r, 14, 1, 0.55, 0.15, 0);
          this.circle(W[o], cy, W[o + 2], r, 14, 1, 0.55, 0.15, 1);
        } else if (ph.shape === ColliderShape.BridgeDeck) {
          this.axes(e, 3);
        }
      }
      for (let i = 0; i < P.contactCount; i++) {
        const c = P.contacts[i];
        this.line(c.x, c.y, c.z, c.x + c.nx * 1.2, c.y + c.ny * 1.2, c.z + c.nz * 1.2, 1, 1, 1);
      }
      this.circle(px, py + 0.05, pz, P.radius, 12, 1, 1, 1);
    }

    // 9-11. geometry state
    if (rel && (T.generated || T.cached || T.unresolved)) {
      const store = E.store;
      const recent = 60;
      for (let i = 0; i < E.vis.visible.length; i++) {
        const e = E.vis.visible.data[i];
        const def = db.defs[db.def[e]];
        const entry = store.peek(keyOf(def.id, E.vis.lod[i]));
        const B = this.tmp;
        fs.bounds(e, B, 0);
        const isTerrain = def.family === Family.TerrainPatch;
        if (!entry) {
          if (T.unresolved) {
            if (isTerrain) { const h = def.params[2] / 2; this.rect(B[0] - h, B[2] - h, B[0] + h, B[2] + h, B[1], 0.5, 0.5, 0.5); }
            else this.marker(B[0], B[1], B[2], 0.6, 0.6, 0.6, 0.6);
          }
          continue;
        }
        const fresh = frame - entry.generatedFrame < recent;
        if (fresh && T.generated) {
          if (isTerrain) { const h = def.params[2] / 2 - 0.5; this.rect(B[0] - h, B[2] - h, B[0] + h, B[2] + h, B[1] + 0.3, 0.2, 1, 0.3); }
          else this.marker(B[0], B[1] + B[3] * 0.6, B[2], 0.5, 0.2, 1, 0.3);
        } else if (!fresh && T.cached) {
          if (isTerrain) { const h = def.params[2] / 2 - 0.5; this.rect(B[0] - h, B[2] - h, B[0] + h, B[2] + h, B[1] + 0.3, 0.25, 0.5, 1); }
          else this.marker(B[0], B[1] + B[3] * 0.6, B[2], 0.35, 0.25, 0.5, 1);
        }
      }
    }

    const lg = this.lines.geometry;
    lg.setDrawRange(0, this.ln * 2);
    const la = lg.attributes.position as THREE.BufferAttribute, lc = lg.attributes.color as THREE.BufferAttribute;
    la.clearUpdateRanges(); la.addUpdateRange(0, this.ln * 6); la.needsUpdate = true;
    lc.clearUpdateRanges(); lc.addUpdateRange(0, this.ln * 6); lc.needsUpdate = true;
    const pg = this.points.geometry;
    pg.setDrawRange(0, this.pn);
    const pa = pg.attributes.position as THREE.BufferAttribute, pc = pg.attributes.color as THREE.BufferAttribute;
    pa.clearUpdateRanges(); pa.addUpdateRange(0, this.pn * 3); pa.needsUpdate = true;
    pc.clearUpdateRanges(); pc.addUpdateRange(0, this.pn * 3); pc.needsUpdate = true;
  }

  private volumeLines(C: Float64Array, r: number, g: number, b: number): void {
    // corners: near (0..3), far (4..7) ordered (-x,-y), (+x,-y), (-x,+y), (+x,+y)
    const P = (i: number) => [C[i * 3], C[i * 3 + 1], C[i * 3 + 2]] as const;
    const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, c] of edges) {
      const A = P(a), Bv = P(c);
      this.line(A[0], A[1], A[2], Bv[0], Bv[1], Bv[2], r, g, b);
    }
  }

  get lineCount(): number { return this.ln; }
  get pointCount(): number { return this.pn; }
}
