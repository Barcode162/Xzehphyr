/**
 * CONVENTIONAL BASELINE (Test A / A2).
 *
 * Builds a classic, permanently constructed Three.js scene from the same world
 * content, then lets Three.js do what it normally does (scene graph traversal,
 * per-object frustum culling, THREE.LOD switching, shadow pass over all casters).
 *
 *   A  ("scenegraph"): one THREE.LOD (+ one Mesh per LOD level) per entity, grouped
 *       under region groups — the textbook scene-graph organization.
 *   A2 ("batched"): prebuilt static InstancedMesh batches per (region, archetype, LOD)
 *       with region-level THREE.LOD switching — a strong, commonly used optimization.
 *
 * All geometry (every archetype LOD, every terrain patch LOD, all grass) is
 * generated up front, exactly like a preconstructed scene.
 */
import * as THREE from 'three';
import { Stage } from './Stage';
import { toBufferGeometry } from './Materials';
import { BuiltWorld } from '../world/WorldGenerator';
import { Family, Flag } from '../world/types';
import { GeometryData } from '../geometry/MeshBuilder';
import { GrassPayload } from '../geometry/Generators';
import { composeMatrix } from '../util/math';
import { profiler, Scope } from '../diagnostics/Profiler';

export interface ConventionalBuildStats {
  buildMs: number;
  geometryMs: number;
  objects: number;
  meshes: number;
  lodObjects: number;
  geometries: number;
  geometryBytes: number;
  grassInstances: number;
  instanceBytes: number;
}

export type Generate = (def: number, lod: number) => { geometry?: GeometryData; grass?: GrassPayload };

const TERRAIN_LOD_OFFSET = 32;

export class ConventionalPresenter {
  readonly root = new THREE.Group();
  mode: 'scenegraph' | 'batched';
  private lods: THREE.LOD[] = [];
  private geoms = new Map<number, THREE.BufferGeometry>();
  stats: ConventionalBuildStats = { buildMs: 0, geometryMs: 0, objects: 0, meshes: 0, lodObjects: 0, geometries: 0, geometryBytes: 0, grassInstances: 0, instanceBytes: 0 };

  constructor(private stage: Stage, mode: 'scenegraph' | 'batched') {
    this.mode = mode;
    this.root.name = `conventional-${mode}`;
  }

  private material(family: Family): THREE.Material | THREE.Material[] {
    const M = this.stage.materials;
    switch (family) {
      case Family.Pine: case Family.Oak: case Family.Birch: case Family.Bush: case Family.Fern: return M.get('vegetation');
      case Family.Lantern: return M.lanternMaterials();
      case Family.TerrainPatch: return M.get('terrain');
      case Family.WaterPatch: return M.get('water');
      default: return M.get('rigid');
    }
  }

  build(world: BuiltWorld, generate: Generate, grassDistance: number): ConventionalBuildStats {
    const t0 = performance.now();
    const { db, frames } = world;
    let geomMs = 0;
    const getGeo = (def: number, lod: number): THREE.BufferGeometry => {
      const key = def * 4 + lod;
      let g = this.geoms.get(key);
      if (!g) {
        const g0 = performance.now();
        const res = generate(def, lod);
        geomMs += performance.now() - g0;
        g = toBufferGeometry(res.geometry!);
        this.stats.geometryBytes += res.geometry!.bytes;
        this.geoms.set(key, g);
      }
      return g;
    };
    // region groups (conventional hierarchy)
    const regionGroups = new Map<number, THREE.Group>();
    const groupForParent = (p: number): THREE.Group => {
      let g = regionGroups.get(p);
      if (!g) {
        g = new THREE.Group();
        g.name = db.names.get(p) ?? `frame ${p}`;
        g.matrixAutoUpdate = false;
        this.root.add(g);
        regionGroups.set(p, g);
        this.stats.objects++;
      }
      return g;
    };
    const groupFor = (e: number): THREE.Group => groupForParent(db.parent[e]);
    const mat = new Float32Array(16);
    const setMatrix = (obj: THREE.Object3D, e: number, uniformOnly: boolean) => {
      const o = frames.resolve(e);
      const W = frames.world;
      const s = W[o + 7];
      const so = e * 3, S = db.shape;
      const sx = uniformOnly ? s : s * S[so], sy = uniformOnly ? s : s * S[so + 1], sz = uniformOnly ? s : s * S[so + 2];
      composeMatrix(mat, 0, W[o], W[o + 1], W[o + 2], W[o + 3], W[o + 4], W[o + 5], W[o + 6], sx, sy, sz);
      obj.matrix.fromArray(mat);
      obj.matrixAutoUpdate = false;
      obj.matrixWorldNeedsUpdate = true;
    };

    // batched mode accumulators: (regionParent, def, lod) -> matrices
    const batches = new Map<string, { parent: number; def: number; lod: number; mats: number[] }>();

    for (let e = 0; e < db.count; e++) {
      const f = db.flags[e];
      if ((f & Flag.Visual) === 0 || (f & Flag.Dynamic) !== 0) continue;
      const di = db.def[e];
      if (di < 0) continue;
      const def = db.defs[di];
      const shared = def.shared;
      if (this.mode === 'batched' && shared) {
        const o = frames.resolve(e);
        const W = frames.world;
        const s = W[o + 7];
        const so = e * 3, S = db.shape;
        composeMatrix(mat, 0, W[o], W[o + 1], W[o + 2], W[o + 3], W[o + 4], W[o + 5], W[o + 6], s * S[so], s * S[so + 1], s * S[so + 2]);
        for (let lod = 0; lod < def.lodCount; lod++) {
          const k = `${db.parent[e]}:${di}:${lod}`;
          let b = batches.get(k);
          if (!b) { b = { parent: db.parent[e], def: di, lod, mats: [] }; batches.set(k, b); }
          for (let q = 0; q < 16; q++) b.mats.push(mat[q]);
        }
        continue;
      }
      // per-object THREE.LOD (scene graph), also used for unique entities in batched mode
      const lodObj = new THREE.LOD();
      lodObj.autoUpdate = false;
      const terrainOffset = def.family === Family.TerrainPatch ? TERRAIN_LOD_OFFSET : 0;
      for (let lod = 0; lod < def.lodCount; lod++) {
        const mesh = new THREE.Mesh(getGeo(di, lod), this.material(def.family));
        mesh.matrixAutoUpdate = false;
        mesh.castShadow = def.family !== Family.Fern && def.family !== Family.TerrainPatch && def.family !== Family.WaterPatch && lod < 2;
        mesh.receiveShadow = true;
        const dist = lod === 0 ? 0 : Math.sqrt(def.lodDist2[lod - 1]) + terrainOffset;
        lodObj.addLevel(mesh, dist);
        this.stats.meshes++;
        this.stats.objects++;
      }
      if (def.maxDrawDist < 1500) {
        const empty = new THREE.Object3D();
        lodObj.addLevel(empty, def.maxDrawDist + terrainOffset);
        this.stats.objects++;
      }
      const uniform = !shared;
      setMatrix(lodObj, e, uniform);
      groupFor(e).add(lodObj);
      this.lods.push(lodObj);
      this.stats.lodObjects++;
      this.stats.objects++;
      // grass for terrain patches: prebuilt instanced batch with distance switch
      if (def.family === Family.TerrainPatch) {
        const res = generate(di, 3);
        const g = res.grass!;
        if (g.count > 0) {
          const im = new THREE.InstancedMesh(this.grassGeometry!, this.stage.materials.get('grass'), g.count);
          im.instanceMatrix.array.set(g.matrices);
          im.instanceMatrix.needsUpdate = true;
          im.receiveShadow = true;
          im.matrixAutoUpdate = false;
          im.computeBoundingSphere();
          const gl = new THREE.LOD();
          gl.autoUpdate = false;
          gl.addLevel(im, 0);
          gl.addLevel(new THREE.Object3D(), grassDistance + 46);
          setMatrix(gl, e, true);
          groupFor(e).add(gl);
          this.lods.push(gl);
          this.stats.grassInstances += g.count;
          this.stats.instanceBytes += g.matrices.byteLength;
          this.stats.objects += 3;
          this.stats.meshes++;
        }
      }
    }
    if (this.mode === 'batched') {
      // group batches per (parent, def) into a region-level LOD
      const byGroup = new Map<string, Array<{ lod: number; mats: number[]; def: number; parent: number }>>();
      for (const b of batches.values()) {
        const k = `${b.parent}:${b.def}`;
        let arr = byGroup.get(k);
        if (!arr) { arr = []; byGroup.set(k, arr); }
        arr.push(b);
      }
      for (const arr of byGroup.values()) {
        arr.sort((a, b) => a.lod - b.lod);
        const def = db.defs[arr[0].def];
        const lodObj = new THREE.LOD();
        lodObj.autoUpdate = false;
        // region-level LOD: distance from camera to region center
        const parent = arr[0].parent;
        const po = frames.resolve(parent);
        lodObj.position.set(frames.world[po], frames.world[po + 1] + 2, frames.world[po + 2]);
        lodObj.updateMatrix();
        lodObj.matrixAutoUpdate = false;
        const half = 32;
        for (const b of arr) {
          const n = b.mats.length / 16;
          const im = new THREE.InstancedMesh(getGeo(b.def, b.lod), this.material(def.family), n);
          // matrices are world-space; compensate for the LOD object's own translation
          const m = new Float32Array(b.mats);
          for (let i = 0; i < n; i++) {
            m[i * 16 + 12] -= lodObj.position.x;
            m[i * 16 + 13] -= lodObj.position.y;
            m[i * 16 + 14] -= lodObj.position.z;
          }
          im.instanceMatrix.array.set(m);
          im.instanceMatrix.needsUpdate = true;
          im.castShadow = def.family !== Family.Fern && b.lod < 2;
          im.receiveShadow = true;
          im.matrixAutoUpdate = false;
          im.computeBoundingSphere();
          const dist = b.lod === 0 ? 0 : Math.sqrt(def.lodDist2[b.lod - 1]) + half;
          lodObj.addLevel(im, dist);
          this.stats.meshes++;
          this.stats.objects++;
          this.stats.instanceBytes += m.byteLength;
        }
        const empty = new THREE.Object3D();
        lodObj.addLevel(empty, def.maxDrawDist + half);
        groupForParent(parent).add(lodObj);
        this.lods.push(lodObj);
        this.stats.lodObjects++;
        this.stats.objects += 2;
      }
    }
    this.root.updateMatrixWorld(true);
    this.stats.geometries = this.geoms.size;
    this.stats.geometryMs = geomMs;
    this.stats.buildMs = performance.now() - t0;
    return this.stats;
  }

  grassGeometry: THREE.BufferGeometry | null = null;

  /** Conventional per-frame scene update: matrices + LOD selection (timed). */
  update(camera: THREE.Camera): void {
    profiler.begin(Scope.Conventional);
    this.root.updateMatrixWorld();
    const lods = this.lods;
    for (let i = 0; i < lods.length; i++) lods[i].update(camera);
    profiler.end(Scope.Conventional);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    for (const g of this.geoms.values()) g.dispose();
    this.geoms.clear();
    this.root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    this.root.clear();
    this.lods.length = 0;
  }
}

