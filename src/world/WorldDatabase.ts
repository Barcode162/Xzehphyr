/**
 * WORLD DATABASE — the single source of truth.
 *
 * Entities are rows in a struct-of-arrays table. An entity is an identity plus:
 *   - a reference to a parent reference frame and a *local* reference (never a stored world matrix)
 *   - state, flags and bounds hints
 *   - optional references to procedural, material, physical, acoustic and light descriptors
 *   - typed relationships to other entities
 *
 * Nothing here knows about Three.js, meshes, or GPU resources. An entity with a
 * procedural definition has *no* geometry until some consumer asks for one.
 */
import {
  AcousticDesc, Family, FrameMode, Kind, LightDesc, MaterialDesc, PhysicalDesc, ProceduralDef, Rel,
} from './types';
import { Curve } from './Curve';

export const LOCAL_STRIDE = 8; // x, y, z, qx, qy, qz, qw, uniformScale

export interface EntityInit {
  kind: Kind;
  parent: number;
  mode?: FrameMode;
  x?: number; y?: number; z?: number;
  /** Yaw in radians (most entities only rotate about +Y). */
  yaw?: number;
  /** Full quaternion (overrides yaw). */
  q?: [number, number, number, number];
  scale?: number;
  /** Non-inherited shape scale applied to visual/collider only. */
  shape?: [number, number, number];
  flags?: number;
  def?: number;
  physical?: number;
  acoustic?: number;
  light?: number;
  /** Bounding sphere radius (world units, includes shape scale). */
  radius?: number;
  /** Vertical offset of the bounding sphere center above the entity origin. */
  centerY?: number;
  name?: string;
}

export class WorldDatabase {
  capacity: number;
  count = 0;

  // ---- identity & classification
  kind: Uint8Array;
  flags: Uint32Array;
  // ---- relational spatial reference
  parent: Int32Array;
  firstChild: Int32Array;
  nextSibling: Int32Array;
  mode: Uint8Array;
  local: Float64Array;
  /** Incremented whenever an entity's local reference changes. */
  localVersion: Uint32Array;
  shape: Float32Array;
  // ---- bounds hints (in entity space, world-scaled)
  radius: Float32Array;
  centerY: Float32Array;
  // ---- descriptor references (-1 = none)
  def: Int32Array;
  physical: Int32Array;
  acoustic: Int32Array;
  light: Int32Array;
  // ---- generic per-entity state (4 floats)
  state: Float32Array;

  // ---- descriptor tables (cold data)
  defs: ProceduralDef[] = [];
  materials: MaterialDesc[] = [];
  physicals: PhysicalDesc[] = [];
  acoustics: AcousticDesc[] = [];
  lights: LightDesc[] = [];
  names = new Map<number, string>();
  curves = new Map<number, Curve>();

  // ---- relationships (edge list with per-entity adjacency)
  relCapacity = 1024;
  relCount = 0;
  relFrom = new Int32Array(this.relCapacity);
  relTo = new Int32Array(this.relCapacity);
  relType = new Uint8Array(this.relCapacity);
  relParam = new Float32Array(this.relCapacity);
  relNextOut = new Int32Array(this.relCapacity);
  relHeadOut: Int32Array;

  /** Incremented on any structural change (entity add, re-parent, relation change). */
  structureVersion = 1;
  /** Incremented on any local reference change. Used for per-frame memo invalidation. */
  mutationStamp = 1;

  /** Listeners notified when an entity's local reference or parent changes (index maintenance etc.). */
  private moveListeners: Array<(e: number) => void> = [];

  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.kind = new Uint8Array(capacity);
    this.flags = new Uint32Array(capacity);
    this.parent = new Int32Array(capacity).fill(-1);
    this.firstChild = new Int32Array(capacity).fill(-1);
    this.nextSibling = new Int32Array(capacity).fill(-1);
    this.mode = new Uint8Array(capacity);
    this.local = new Float64Array(capacity * LOCAL_STRIDE);
    this.localVersion = new Uint32Array(capacity);
    this.shape = new Float32Array(capacity * 3);
    this.radius = new Float32Array(capacity);
    this.centerY = new Float32Array(capacity);
    this.def = new Int32Array(capacity).fill(-1);
    this.physical = new Int32Array(capacity).fill(-1);
    this.acoustic = new Int32Array(capacity).fill(-1);
    this.light = new Int32Array(capacity).fill(-1);
    this.state = new Float32Array(capacity * 4);
    this.relHeadOut = new Int32Array(capacity).fill(-1);
  }

  private grow(min: number): void {
    let cap = this.capacity;
    while (cap < min) cap *= 2;
    const g8 = (a: Uint8Array) => { const n = new Uint8Array(cap); n.set(a); return n; };
    const g32 = (a: Uint32Array) => { const n = new Uint32Array(cap); n.set(a); return n; };
    const gi = (a: Int32Array) => { const n = new Int32Array(cap).fill(-1); n.set(a); return n; };
    const gf = (a: Float32Array, s: number) => { const n = new Float32Array(cap * s); n.set(a); return n; };
    this.kind = g8(this.kind);
    this.flags = g32(this.flags);
    this.parent = gi(this.parent);
    this.firstChild = gi(this.firstChild);
    this.nextSibling = gi(this.nextSibling);
    this.mode = g8(this.mode);
    const nl = new Float64Array(cap * LOCAL_STRIDE); nl.set(this.local); this.local = nl;
    this.localVersion = g32(this.localVersion);
    this.shape = gf(this.shape, 3);
    this.radius = gf(this.radius, 1);
    this.centerY = gf(this.centerY, 1);
    this.def = gi(this.def);
    this.physical = gi(this.physical);
    this.acoustic = gi(this.acoustic);
    this.light = gi(this.light);
    this.state = gf(this.state, 4);
    this.relHeadOut = gi(this.relHeadOut);
    this.capacity = cap;
  }

  onMove(fn: (e: number) => void): void {
    this.moveListeners.push(fn);
  }

  // ------------------------------------------------------------------ descriptors
  addDef(d: Omit<ProceduralDef, 'id'>): number {
    const id = this.defs.length;
    this.defs.push({ ...d, id });
    return id;
  }
  addMaterial(m: Omit<MaterialDesc, 'id'>): number {
    const id = this.materials.length;
    this.materials.push({ ...m, id });
    return id;
  }
  addPhysical(p: Omit<PhysicalDesc, 'id'>): number {
    const id = this.physicals.length;
    this.physicals.push({ ...p, id });
    return id;
  }
  addAcoustic(a: Omit<AcousticDesc, 'id'>): number {
    const id = this.acoustics.length;
    this.acoustics.push({ ...a, id });
    return id;
  }
  addLight(l: Omit<LightDesc, 'id'>): number {
    const id = this.lights.length;
    this.lights.push({ ...l, id });
    return id;
  }

  // ------------------------------------------------------------------ entities
  create(init: EntityInit): number {
    if (this.count >= this.capacity) this.grow(this.count + 1);
    const e = this.count++;
    this.kind[e] = init.kind;
    this.flags[e] = init.flags ?? 0;
    this.mode[e] = init.mode ?? FrameMode.Local;
    const o = e * LOCAL_STRIDE;
    const L = this.local;
    L[o] = init.x ?? 0;
    L[o + 1] = init.y ?? 0;
    L[o + 2] = init.z ?? 0;
    if (init.q) {
      L[o + 3] = init.q[0]; L[o + 4] = init.q[1]; L[o + 5] = init.q[2]; L[o + 6] = init.q[3];
    } else {
      const h = (init.yaw ?? 0) * 0.5;
      L[o + 3] = 0; L[o + 4] = Math.sin(h); L[o + 5] = 0; L[o + 6] = Math.cos(h);
    }
    L[o + 7] = init.scale ?? 1;
    const so = e * 3;
    const sh = init.shape ?? [1, 1, 1];
    this.shape[so] = sh[0]; this.shape[so + 1] = sh[1]; this.shape[so + 2] = sh[2];
    this.radius[e] = init.radius ?? 0.5;
    this.centerY[e] = init.centerY ?? 0;
    this.def[e] = init.def ?? -1;
    this.physical[e] = init.physical ?? -1;
    this.acoustic[e] = init.acoustic ?? -1;
    this.light[e] = init.light ?? -1;
    this.localVersion[e] = 1;
    this.parent[e] = -1;
    this.firstChild[e] = -1;
    this.nextSibling[e] = -1;
    this.relHeadOut[e] = -1;
    if (init.name) this.names.set(e, init.name);
    this.linkParent(e, init.parent);
    this.structureVersion++;
    return e;
  }

  private linkParent(e: number, p: number): void {
    this.parent[e] = p;
    if (p >= 0) {
      this.nextSibling[e] = this.firstChild[p];
      this.firstChild[p] = e;
    }
  }

  private unlinkParent(e: number): void {
    const p = this.parent[e];
    if (p < 0) return;
    let c = this.firstChild[p];
    let prev = -1;
    while (c >= 0) {
      if (c === e) {
        if (prev < 0) this.firstChild[p] = this.nextSibling[c];
        else this.nextSibling[prev] = this.nextSibling[c];
        break;
      }
      prev = c;
      c = this.nextSibling[c];
    }
    this.nextSibling[e] = -1;
    this.parent[e] = -1;
  }

  /** Update an entity's local reference (position in its current frame). */
  setLocal(e: number, x: number, y: number, z: number): void {
    const o = e * LOCAL_STRIDE;
    this.local[o] = x;
    this.local[o + 1] = y;
    this.local[o + 2] = z;
    this.touch(e);
  }

  setLocalYaw(e: number, yaw: number): void {
    const o = e * LOCAL_STRIDE;
    const h = yaw * 0.5;
    this.local[o + 3] = 0;
    this.local[o + 4] = Math.sin(h);
    this.local[o + 5] = 0;
    this.local[o + 6] = Math.cos(h);
    this.touch(e);
  }

  /** Mark local reference changed (after direct writes into `local`). */
  touch(e: number): void {
    this.localVersion[e]++;
    this.mutationStamp++;
    const ls = this.moveListeners;
    for (let i = 0; i < ls.length; i++) ls[i](e);
  }

  /**
   * Reference change: move an entity into a different parent frame with a new
   * local reference. Callers compute the new local reference (see FrameSystem.reexpress).
   */
  reparent(e: number, newParent: number, mode: FrameMode): void {
    if (this.parent[e] === newParent && this.mode[e] === mode) return;
    this.unlinkParent(e);
    this.linkParent(e, newParent);
    this.mode[e] = mode;
    this.structureVersion++;
    this.touch(e);
  }

  /** Iterate children of a frame (allocation-free callback). */
  forEachChild(p: number, fn: (c: number) => void): void {
    let c = this.firstChild[p];
    while (c >= 0) {
      fn(c);
      c = this.nextSibling[c];
    }
  }

  /** Depth-first visit of all descendants. */
  forEachDescendant(p: number, fn: (c: number) => void): void {
    const stack: number[] = [p];
    while (stack.length) {
      const n = stack.pop()!;
      let c = this.firstChild[n];
      while (c >= 0) {
        fn(c);
        stack.push(c);
        c = this.nextSibling[c];
      }
    }
  }

  depth(e: number): number {
    let d = 0;
    let p = this.parent[e];
    while (p >= 0) { d++; p = this.parent[p]; }
    return d;
  }

  // ------------------------------------------------------------------ relationships
  relate(from: number, type: Rel, to: number, param = 0): number {
    if (this.relCount >= this.relCapacity) {
      const cap = this.relCapacity * 2;
      const gi = (a: Int32Array) => { const n = new Int32Array(cap); n.set(a); return n; };
      this.relFrom = gi(this.relFrom);
      this.relTo = gi(this.relTo);
      this.relNextOut = gi(this.relNextOut);
      const t = new Uint8Array(cap); t.set(this.relType); this.relType = t;
      const p = new Float32Array(cap); p.set(this.relParam); this.relParam = p;
      this.relCapacity = cap;
    }
    const r = this.relCount++;
    this.relFrom[r] = from;
    this.relTo[r] = to;
    this.relType[r] = type;
    this.relParam[r] = param;
    this.relNextOut[r] = this.relHeadOut[from];
    this.relHeadOut[from] = r;
    this.structureVersion++;
    return r;
  }

  /** First target of a given relation type from an entity, or -1. */
  related(from: number, type: Rel): number {
    let r = this.relHeadOut[from];
    while (r >= 0) {
      if (this.relType[r] === type) return this.relTo[r];
      r = this.relNextOut[r];
    }
    return -1;
  }

  forEachRelation(from: number, fn: (type: Rel, to: number, param: number) => void): void {
    let r = this.relHeadOut[from];
    while (r >= 0) {
      fn(this.relType[r] as Rel, this.relTo[r], this.relParam[r]);
      r = this.relNextOut[r];
    }
  }

  /** Total relationships: explicit typed edges + spatial parent links. */
  relationshipCount(): number {
    let parentLinks = 0;
    for (let i = 0; i < this.count; i++) if (this.parent[i] >= 0) parentLinks++;
    return this.relCount + parentLinks;
  }

  // ------------------------------------------------------------------ helpers
  defOf(e: number): ProceduralDef | null {
    const d = this.def[e];
    return d >= 0 ? this.defs[d] : null;
  }

  familyOf(e: number): Family {
    const d = this.def[e];
    return d >= 0 ? this.defs[d].family : Family.None;
  }

  countByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.count; i++) {
      const k = Kind[this.kind[i]];
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  /** Bytes used by the entity table (typed arrays actually allocated). Exact for our own storage. */
  storageBytes(): number {
    return this.kind.byteLength + this.flags.byteLength + this.parent.byteLength + this.firstChild.byteLength +
      this.nextSibling.byteLength + this.mode.byteLength + this.local.byteLength + this.localVersion.byteLength +
      this.shape.byteLength + this.radius.byteLength + this.centerY.byteLength + this.def.byteLength +
      this.physical.byteLength + this.acoustic.byteLength + this.light.byteLength + this.state.byteLength +
      this.relHeadOut.byteLength + this.relFrom.byteLength + this.relTo.byteLength + this.relType.byteLength +
      this.relParam.byteLength + this.relNextOut.byteLength;
  }
}
