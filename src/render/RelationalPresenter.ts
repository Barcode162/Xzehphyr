/**
 * DEMAND-DRIVEN RENDER ASSEMBLY (Tests B and C).
 *
 * Inputs are system results, not a scene:
 *   - VisibilitySystem: visible entities + LOD
 *   - ShadowSystem: shadow-only contributors
 *   - GeometryStore: representations (generated on request)
 * The presenter turns those into a small, flat set of draw batches:
 *   one InstancedMesh per (archetype, LOD) for the camera pass, one per
 *   (archetype, LOD) on a shadow-only layer for off-screen casters, pooled meshes
 *   for unique entities (terrain patches, water, bridges), and a single grass batch.
 */
import * as THREE from 'three';
import { Stage, LAYER_MAIN, LAYER_SHADOW_ONLY } from './Stage';
import { toBufferGeometry } from './Materials';
import { WorldDatabase } from '../world/WorldDatabase';
import { FrameSystem } from '../world/FrameSystem';
import { Family } from '../world/types';
import { GeometryStore, GeomEntry, keyOf } from '../geometry/GeometryStore';
import { GrassPayload, GRASS_CELL } from '../geometry/Generators';
import { VisibilitySystem } from '../systems/VisibilitySystem';
import { ShadowSystem } from '../systems/ShadowSystem';
import { Observation } from '../systems/Observation';
import { composeMatrix } from '../util/math';
import { profiler, Scope, counters } from '../diagnostics/Profiler';

interface Bucket {
  key: number;
  family: Family;
  lod: number;
  geometry: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh;
  shadowMesh: THREE.InstancedMesh;
  count: number;
  shadowCount: number;
}

interface UniqueSlot {
  mesh: THREE.Mesh;
  key: number;
  usedFrame: number;
}

const SHARED_FAMILIES = new Set([Family.Pine, Family.Oak, Family.Birch, Family.Rock, Family.Bush, Family.Fern, Family.Lantern, Family.StressPillar]);

export class RelationalPresenter {
  readonly root = new THREE.Group();
  private buckets = new Map<number, Bucket>();
  private bucketList: Bucket[] = [];
  private unique = new Map<number, UniqueSlot>(); // entity -> slot
  private grass: THREE.InstancedMesh;
  private grassGeo: THREE.BufferGeometry;
  private grassCapacity = 6000;
  grassCount = 0;
  grassDistance = 34;
  /** Cached instance matrices per entity (Test C instance cache). */
  private instMats = new Float32Array(0);
  private instVer = new Uint32Array(0);
  instanceCache = true;
  skipUnchanged = true;
  private lastSignature = -1;
  private frame = 0;
  private tmpMat = new Float32Array(16);
  /** Visible terrain patch entities this frame (debug). */
  readonly drawnUnique: number[] = [];
  unresolvedEntities: number[] = [];

  constructor(
    private stage: Stage,
    private db: WorldDatabase,
    private frames: FrameSystem,
    private store: GeometryStore,
    grassGeometry: THREE.BufferGeometry,
  ) {
    this.root.name = 'relational-presentation';
    this.grassGeo = grassGeometry;
    this.grass = this.makeInstanced(grassGeometry, stage.materials.get('grass'), this.grassCapacity);
    this.grass.castShadow = false;
    this.grass.receiveShadow = true;
    this.root.add(this.grass);
    store.onDispose = (e) => this.onDispose(e);
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false; // culling already done by the visibility system
    m.matrixAutoUpdate = false;
    m.matrixWorldAutoUpdate = false;
    return m;
  }

  private materialFor(family: Family): THREE.Material | THREE.Material[] {
    const M = this.stage.materials;
    switch (family) {
      case Family.Pine: case Family.Oak: case Family.Birch: case Family.Bush: case Family.Fern: return M.get('vegetation');
      case Family.Lantern: return M.lanternMaterials();
      case Family.TerrainPatch: return M.get('terrain');
      case Family.WaterPatch: return M.get('water');
      default: return M.get('rigid');
    }
  }

  private gpuGeometry(entry: GeomEntry): THREE.BufferGeometry {
    if (!entry.gpu) entry.gpu = toBufferGeometry(entry.geometry!);
    return entry.gpu as THREE.BufferGeometry;
  }

  private bucketFor(entry: GeomEntry, family: Family): Bucket {
    let b = this.buckets.get(entry.key);
    if (b) return b;
    const geo = this.gpuGeometry(entry);
    const mat = this.materialFor(family);
    const cap = 64;
    const mesh = this.makeInstanced(geo, mat, cap);
    mesh.layers.set(LAYER_MAIN);
    const casts = family !== Family.Fern && entry.lod < 2;
    mesh.castShadow = casts;
    mesh.receiveShadow = true;
    const shadowMesh = this.makeInstanced(geo, mat, 16);
    shadowMesh.layers.set(LAYER_SHADOW_ONLY);
    shadowMesh.castShadow = true;
    shadowMesh.receiveShadow = false;
    b = { key: entry.key, family, lod: entry.lod, geometry: geo, mesh, shadowMesh, count: 0, shadowCount: 0 };
    this.buckets.set(entry.key, b);
    this.bucketList.push(b);
    this.root.add(mesh, shadowMesh);
    return b;
  }

  private onDispose(e: GeomEntry): void {
    const b = this.buckets.get(e.key);
    if (b) {
      this.root.remove(b.mesh, b.shadowMesh);
      b.mesh.dispose();
      b.shadowMesh.dispose();
      this.buckets.delete(e.key);
      this.bucketList.splice(this.bucketList.indexOf(b), 1);
    }
    for (const [ent, slot] of this.unique) {
      if (slot.key === e.key) {
        this.root.remove(slot.mesh);
        this.unique.delete(ent);
      }
    }
    if (e.gpu) (e.gpu as THREE.BufferGeometry).dispose();
    e.gpu = null;
  }

  private ensureCapacity(mesh: THREE.InstancedMesh, need: number): void {
    const cap = mesh.instanceMatrix.count;
    if (need <= cap) return;
    let n = cap;
    while (n < need) n *= 2;
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);
    attr.setUsage(THREE.DynamicDrawUsage);
    attr.array.set(mesh.instanceMatrix.array.subarray(0, cap * 16));
    mesh.instanceMatrix = attr;
  }

  /** Compute (or fetch cached) instance matrix for an entity into out[o..o+15]. */
  private writeMatrix(e: number, out: Float32Array, o: number): void {
    const fs = this.frames;
    const wo = fs.resolve(e);
    if (this.instanceCache) {
      if (this.instVer.length < this.db.capacity) {
        const n = new Float32Array(this.db.capacity * 16); n.set(this.instMats); this.instMats = n;
        const v = new Uint32Array(this.db.capacity); v.set(this.instVer); this.instVer = v;
      }
      const ver = fs.worldVersion[e];
      const mo = e * 16;
      if (this.instVer[e] !== ver) {
        this.compose(e, wo, this.instMats, mo);
        this.instVer[e] = ver;
      }
      const src = this.instMats;
      for (let i = 0; i < 16; i++) out[o + i] = src[mo + i];
      return;
    }
    this.compose(e, wo, out, o);
  }

  private compose(e: number, wo: number, out: Float32Array, o: number): void {
    const W = this.frames.world;
    const s = W[wo + 7];
    const so = e * 3, S = this.db.shape;
    composeMatrix(out, o, W[wo], W[wo + 1], W[wo + 2], W[wo + 3], W[wo + 4], W[wo + 5], W[wo + 6], s * S[so], s * S[so + 1], s * S[so + 2]);
  }

  /** Resolve a representation with LOD fallback. */
  private acquire(def: number, lod: number, lodCount: number, priority: number): GeomEntry | null {
    const store = this.store;
    const e = store.request(keyOf(def, lod), priority);
    if (e) return e;
    // fallback: nearest available LOD (coarser first, then finer)
    for (let d = 1; d < lodCount; d++) {
      const a = lod + d, b = lod - d;
      if (a < lodCount) { const f = store.peek(keyOf(def, a)); if (f) { store.touch(f); counters.lodFallbacks++; return f; } }
      if (b >= 0) { const f = store.peek(keyOf(def, b)); if (f) { store.touch(f); counters.lodFallbacks++; return f; } }
    }
    return null;
  }

  /**
   * Assemble the frame. Returns true if assembly ran, false if it was skipped
   * because nothing relevant changed (identical observation, no new geometry).
   */
  assemble(obs: Observation, vis: VisibilitySystem, shadow: ShadowSystem, geometryChanged: boolean, collectDebug: boolean): boolean {
    this.frame = obs.frame;
    profiler.begin(Scope.Assembly);
    const signature = obs.hash ^ (this.db.mutationStamp * 2654435761);
    if (this.skipUnchanged && vis.fromCache && shadow.fromCache && !geometryChanged && signature === this.lastSignature) {
      counters.assemblySkipped = 1;
      // keep requests alive so the cache sees these representations as used
      this.touchUsed();
      profiler.end(Scope.Assembly);
      return false;
    }
    this.lastSignature = signature;
    const db = this.db;
    const defs = db.defs;
    for (let i = 0; i < this.bucketList.length; i++) { this.bucketList[i].count = 0; this.bucketList[i].shadowCount = 0; }
    this.drawnUnique.length = 0;
    if (collectDebug) this.unresolvedEntities.length = 0;
    let written = 0;
    let unresolved = 0;
    const tmpGrassPatches = this.grassPatches;
    tmpGrassPatches.length = 0;

    // ---- camera-visible representations
    for (let i = 0; i < vis.visible.length; i++) {
      const e = vis.visible.data[i];
      const def = defs[db.def[e]];
      const lod = vis.lod[i];
      const d2 = vis.dist2[i];
      const entry = this.acquire(def.id, lod, def.lodCount, d2);
      if (!entry) { unresolved++; if (collectDebug) this.unresolvedEntities.push(e); continue; }
      if (SHARED_FAMILIES.has(def.family)) {
        const b = this.bucketFor(entry, def.family);
        this.ensureCapacity(b.mesh, b.count + 1);
        this.writeMatrix(e, b.mesh.instanceMatrix.array as Float32Array, b.count * 16);
        b.count++;
        written++;
      } else {
        this.placeUnique(e, entry, def.family);
        if (def.family === Family.TerrainPatch && d2 < (this.grassDistance + 46) * (this.grassDistance + 46)) tmpGrassPatches.push(e);
      }
    }
    // ---- shadow-only contributors (off-screen casters)
    for (let i = 0; i < shadow.shadowOnly.length; i++) {
      const e = shadow.shadowOnly.data[i];
      const def = defs[db.def[e]];
      const lod = shadow.lod[i];
      const entry = this.acquire(def.id, lod, def.lodCount, 1e6);
      if (!entry) { unresolved++; continue; }
      if (SHARED_FAMILIES.has(def.family)) {
        const b = this.bucketFor(entry, def.family);
        this.ensureCapacity(b.shadowMesh, b.shadowCount + 1);
        this.writeMatrix(e, b.shadowMesh.instanceMatrix.array as Float32Array, b.shadowCount * 16);
        b.shadowCount++;
        written++;
      } else {
        const slot = this.placeUnique(e, entry, def.family);
        if (slot) { slot.mesh.layers.set(LAYER_SHADOW_ONLY); }
      }
    }
    // ---- grass for nearby terrain patches
    this.assembleGrass(obs);
    // ---- finalize buckets
    let upload = 0;
    for (let i = 0; i < this.bucketList.length; i++) {
      const b = this.bucketList[i];
      upload += this.finalize(b.mesh, b.count);
      upload += this.finalize(b.shadowMesh, b.shadowCount);
    }
    upload += this.finalize(this.grass, this.grassCount);
    // hide unique meshes not used this frame
    for (const slot of this.unique.values()) slot.mesh.visible = slot.usedFrame === this.frame;
    counters.instancesWritten = written + this.grassCount;
    counters.unresolved = unresolved;
    counters.uploadBytes += upload;
    profiler.end(Scope.Assembly);
    return true;
  }
  private grassPatches: number[] = [];

  private touchUsed(): void {
    for (const b of this.bucketList) {
      if (b.count > 0 || b.shadowCount > 0) { const e = this.store.peek(b.key); if (e) this.store.touch(e); }
    }
    for (const slot of this.unique.values()) {
      if (slot.usedFrame === this.frame - 1 || slot.mesh.visible) {
        slot.usedFrame = this.frame;
        const e = this.store.peek(slot.key); if (e) this.store.touch(e);
      }
    }
    for (const k of this.grassKeysUsed) { const e = this.store.peek(k); if (e) this.store.touch(e); }
  }

  private finalize(mesh: THREE.InstancedMesh, count: number): number {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) {
      const im = mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, count * 16);
      im.needsUpdate = true;
      return count * 64;
    }
    return 0;
  }

  private placeUnique(e: number, entry: GeomEntry, family: Family): UniqueSlot | null {
    let slot = this.unique.get(e);
    const geo = this.gpuGeometry(entry);
    if (!slot) {
      const mesh = new THREE.Mesh(geo, this.materialFor(family));
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = family === Family.Bridge;
      this.root.add(mesh);
      slot = { mesh, key: entry.key, usedFrame: this.frame };
      this.unique.set(e, slot);
    }
    if (slot.key !== entry.key || slot.mesh.geometry !== geo) {
      slot.mesh.geometry = geo;
      slot.key = entry.key;
    }
    slot.mesh.layers.set(LAYER_MAIN);
    slot.usedFrame = this.frame;
    const fs = this.frames;
    const wo = fs.resolve(e);
    const W = fs.world;
    const m = slot.mesh.matrix;
    composeMatrix(this.tmpMat, 0, W[wo], W[wo + 1], W[wo + 2], W[wo + 3], W[wo + 4], W[wo + 5], W[wo + 6], W[wo + 7], W[wo + 7], W[wo + 7]);
    m.fromArray(this.tmpMat);
    slot.mesh.matrixWorld.copy(m);
    this.drawnUnique.push(e);
    return slot;
  }

  private grassKeysUsed: number[] = [];

  private assembleGrass(obs: Observation): void {
    this.grassCount = 0;
    this.grassKeysUsed.length = 0;
    const db = this.db, fs = this.frames, W = fs.world;
    const gd = this.grassDistance;
    const vol = obs.volume;
    for (const e of this.grassPatches) {
      const di = db.def[e];
      const key = di * 4 + 3;
      const entry = this.store.request(key, 0);
      if (!entry || !entry.grass) continue;
      this.grassKeysUsed.push(key);
      const g: GrassPayload = entry.grass;
      const wo = fs.resolve(e);
      const ox = W[wo], oy = W[wo + 1], oz = W[wo + 2];
      const nCells = g.cellsPerSide * g.cellsPerSide;
      for (let c = 0; c < nCells; c++) {
        const cnt = g.cellCount[c];
        if (cnt === 0) continue;
        const cx = ox + g.cellCenter[c * 3], cy = oy + g.cellCenter[c * 3 + 1], cz = oz + g.cellCenter[c * 3 + 2];
        const dx = cx - obs.px, dz = cz - obs.pz;
        const lim = gd + GRASS_CELL * 0.75;
        if (dx * dx + dz * dz > lim * lim) continue;
        if (vol.sphere(cx, cy, cz, GRASS_CELL * 0.8) === 0) continue;
        this.ensureCapacity(this.grass, this.grassCount + cnt);
        const dst = this.grass.instanceMatrix.array as Float32Array;
        const src = g.matrices;
        let so = g.cellStart[c] * 16, dO = this.grassCount * 16;
        for (let k = 0; k < cnt; k++) {
          for (let q = 0; q < 12; q++) dst[dO + q] = src[so + q];
          dst[dO + 12] = src[so + 12] + ox;
          dst[dO + 13] = src[so + 13] + oy;
          dst[dO + 14] = src[so + 14] + oz;
          dst[dO + 15] = 1;
          so += 16; dO += 16;
        }
        this.grassCount += cnt;
      }
    }
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /** Release all GPU-side objects (geometry store entries are released by the store). */
  clear(): void {
    for (const b of this.bucketList) { this.root.remove(b.mesh, b.shadowMesh); b.mesh.dispose(); b.shadowMesh.dispose(); }
    this.buckets.clear();
    this.bucketList.length = 0;
    for (const slot of this.unique.values()) this.root.remove(slot.mesh);
    this.unique.clear();
    this.lastSignature = -1;
    this.instVer.fill(0);
  }

  invalidate(): void {
    this.lastSignature = -1;
  }

  stats(): { buckets: number; activeBuckets: number; uniqueMeshes: number; instanceCacheBytes: number } {
    let active = 0;
    for (const b of this.bucketList) if (b.count > 0 || b.shadowCount > 0) active++;
    return { buckets: this.bucketList.length, activeBuckets: active, uniqueMeshes: this.unique.size, instanceCacheBytes: this.instMats.byteLength + this.instVer.byteLength };
  }

  /** Bytes of instance buffers currently allocated for presentation (exact CPU-side sizes). */
  instanceBufferBytes(): number {
    let b = this.grass.instanceMatrix.array.byteLength;
    for (const k of this.bucketList) b += k.mesh.instanceMatrix.array.byteLength + k.shadowMesh.instanceMatrix.array.byteLength;
    return b;
  }

  get grassGeometry(): THREE.BufferGeometry { return this.grassGeo; }
}

