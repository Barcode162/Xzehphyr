/**
 * ENGINE — orchestrates the frame:
 *
 *   input → physics (own representation) → reference write-back (relational frames)
 *   → camera → Observation
 *   → [relational]   discovery sync → visibility → lighting → shadow contributors
 *                     → demand-driven assembly → budgeted geometry generation
 *     [conventional] Three.js scene graph update (matrices + LOD)
 *   → audio relevance (10 Hz) → debug overlays → render submit → diagnostics
 */
import * as THREE from 'three';
import { Stage } from '../render/Stage';
import { RelationalPresenter } from '../render/RelationalPresenter';
import { ConventionalPresenter } from '../render/ConventionalPresenter';
import { Character } from '../render/Character';
import { toBufferGeometry } from '../render/Materials';
import { buildWorld, BuiltWorld, WorldConfig, DEFAULT_WORLD } from '../world/WorldGenerator';
import { Family, Flag, FrameMode, Kind } from '../world/types';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { Discovery } from '../spatial/Discovery';
import { QueryCache } from '../spatial/QueryCache';
import { ConvexVolume } from '../spatial/Frustum';
import { GeometryStore, keyOf } from '../geometry/GeometryStore';
import { generateArchetype, terrainPatch, waterPatch, grassPatch, grassClump } from '../geometry/Generators';
import { VisibilitySystem } from '../systems/VisibilitySystem';
import { ShadowSystem } from '../systems/ShadowSystem';
import { LightingSystem } from '../systems/LightingSystem';
import { PhysicsSystem, CharacterBody, MoveIntent } from '../systems/PhysicsSystem';
import { AudioSystem } from '../systems/AudioSystem';
import { Observation } from '../systems/Observation';
import { Input } from '../game/Input';
import { CameraController } from '../game/CameraController';
import { profiler, counters, Scope } from '../diagnostics/Profiler';
import { FrameStats, F, SCOPE_OFFSET } from '../diagnostics/FrameStats';
import { GpuTimer } from '../diagnostics/GpuTimer';
import { GLInstrument } from '../diagnostics/GLInstrument';
import { PerfObservers } from '../diagnostics/PerfObservers';
import { clamp, IntList } from '../util/math';
import { CurveProjection } from '../world/Curve';

export type ArchId = 'A' | 'A2' | 'B' | 'C' | 'custom';

export interface ArchFlags {
  presenter: 'scenegraph' | 'batched' | 'relational';
  transformCache: boolean;
  spatialIndex: boolean;
  queryCache: boolean;
  geometryCache: boolean;
  instanceCache: boolean;
  /** Anticipatory requests for unique representations around the camera (terrain, water, grass) when the generation queue is idle. */
  prefetch: boolean;
}

export const PRESETS: Record<Exclude<ArchId, 'custom'>, ArchFlags & { label: string; description: string }> = {
  A: {
    label: 'A · Conventional scene graph', description: 'All geometry prebuilt. One THREE.LOD + meshes per entity. Three.js traversal, per-object culling, LOD and shadow pass.',
    presenter: 'scenegraph', transformCache: true, spatialIndex: true, queryCache: true, geometryCache: true, instanceCache: false, prefetch: false,
  },
  A2: {
    label: 'A2 · Conventional static batching', description: 'All geometry prebuilt into static InstancedMesh batches per region/archetype/LOD with region-level LOD.',
    presenter: 'batched', transformCache: true, spatialIndex: true, queryCache: true, geometryCache: true, instanceCache: false, prefetch: false,
  },
  B: {
    label: 'B · Relational, uncached', description: 'Relational storage + independent system queries + demand-driven geometry. No transform cache, no spatial index (full scans), no query cache, geometry kept only while observed.',
    presenter: 'relational', transformCache: false, spatialIndex: false, queryCache: false, geometryCache: false, instanceCache: false, prefetch: false,
  },
  C: {
    label: 'C · Relational, cached + indexed', description: 'B plus cached reference resolution, spatial index, cached query results, LRU geometry cache, cached instance transforms and anticipatory (idle-time) generation of nearby terrain.',
    presenter: 'relational', transformCache: true, spatialIndex: true, queryCache: true, geometryCache: true, instanceCache: true, prefetch: true,
  },
};

export interface Quality {
  shadowMapSize: number;
  maxDpr: number;
  renderScale: number;
  grassDensity: number;
  grassDistance: number;
  lodScale: number;
  geomBudgetMs: number;
  far: number;
}

export const QUALITY_MOBILE: Quality = { shadowMapSize: 1024, maxDpr: 2, renderScale: 1, grassDensity: 0.85, grassDistance: 28, lodScale: 0.85, geomBudgetMs: 3, far: 300 };
export const QUALITY_DESKTOP: Quality = { shadowMapSize: 2048, maxDpr: 2, renderScale: 1, grassDensity: 1.3, grassDistance: 36, lodScale: 1, geomBudgetMs: 4, far: 340 };

export interface ScriptPose {
  /** Player arc length on the trail (player is positioned trail-relative). */
  s: number;
  lateral: number;
  camYaw: number; // orbit yaw relative to trail heading
  camPitch: number;
  camDist: number;
  camHeight?: number;
}

export class Engine {
  stage: Stage;
  input: Input;
  cam = new CameraController();
  character = new Character();
  world!: BuiltWorld;
  index!: SpatialIndex;
  discovery!: Discovery;
  qcache = new QueryCache(96);
  store!: GeometryStore;
  vis = new VisibilitySystem();
  shadow = new ShadowSystem();
  lighting = new LightingSystem();
  physics!: PhysicsSystem;
  audio = new AudioSystem();
  relational!: RelationalPresenter;
  conventional: ConventionalPresenter | null = null;
  arch: ArchId = 'C';
  flags: ArchFlags = { ...PRESETS.C };
  quality: Quality;
  obs = new Observation();
  body = new CharacterBody();
  stats = new FrameStats(1800);
  gpu: GpuTimer;
  glInstr: GLInstrument;
  perf = new PerfObservers();
  frame = 0;
  time = 0;
  private lastNow = -1;
  fixedDt: number | null = null;
  script: ((frame: number, t: number) => ScriptPose) | null = null;
  paused = false;
  private geomChanged = true;
  private grassGeo: THREE.BufferGeometry;
  private receiverTmp = new ConvexVolume();
  private moveTmp = { x: 0, y: 0, mag: 0 };
  private lookTmp = { dx: 0, dy: 0, zoom: 0 };
  private fwdTmp = { x: 0, z: 0 };
  private proj: CurveProjection = { s: 0, lateral: 0, dist: 0, seg: 0 };
  /** Debug overlay hook (set by main). */
  debugUpdate: (() => void) | null = null;
  debugCollect = false;
  /** Observer (god-view) camera orbit. */
  observerYaw = 0.6;
  observerHeight = 120;
  observerDist = 110;
  conventionalStats: ReturnType<ConventionalPresenter['build']> | null = null;
  onStatus: ((s: string) => void) | null = null;
  lastIntervalMs = 0;
  /** Render submit stats from the renderer (exact counts reported by Three.js). */
  renderInfo = { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0, programs: 0 };
  readonly webgl: WebGL2RenderingContext | WebGLRenderingContext | null;
  benchmarkActive = false;
  private worldConfig: WorldConfig = { ...DEFAULT_WORLD, stress: { ...DEFAULT_WORLD.stress } };

  constructor(stage: Stage, input: Input, quality: Quality) {
    this.stage = stage;
    this.input = input;
    this.quality = quality;
    this.webgl = stage.backend === 'webgl' ? (stage.renderer.getContext() as WebGL2RenderingContext) : null;
    this.gpu = new GpuTimer(this.webgl);
    this.glInstr = new GLInstrument(this.webgl);
    this.gpu.onResult = (frame, ms) => this.attachGpu(frame, ms);
    this.grassGeo = toBufferGeometry(grassClump());
    stage.scene.add(this.character.root);
    this.character.onFootstep = (i) => this.audio.footstep(this.body.surface, i);
  }

  get worldCfg(): WorldConfig { return this.worldConfig; }

  // ------------------------------------------------------------------ world lifecycle
  loadWorld(config: WorldConfig): void {
    this.worldConfig = { ...config, stress: { ...config.stress } };
    if (this.relational) {
      this.store.clear();
      this.relational.clear();
      this.stage.scene.remove(this.relational.root);
    }
    if (this.conventional) {
      this.stage.scene.remove(this.conventional.root);
      this.conventional.dispose();
      this.conventional = null;
    }
    this.qcache.clear();
    const w = buildWorld(config);
    this.world = w;
    const half = config.size / 2;
    this.index = new SpatialIndex(-half - 32, -half - 32, config.size + 64, 6);
    this.discovery = new Discovery(w.db, w.frames, this.index);
    this.discovery.rebuild();
    this.store = new GeometryStore((def, lod) => this.generate(def, lod));
    this.sharedComplete = false;
    this.prefetchCell = -1;
    this.store.labelOf = (def, lod) => (lod === 3 && w.db.defs[def].family === Family.TerrainPatch ? 'Grass' : FAMILY_LABEL[w.db.defs[def].family] ?? 'geometry');
    this.store.budgetBytes = this.isMobileQuality ? 64 * 1048576 : 160 * 1048576;
    const regionAt = (x: number, z: number) => {
      const dim = w.regionDim, rs = config.regionSize;
      const ix = clamp(Math.floor((x + half) / rs), 0, dim - 1), iz = clamp(Math.floor((z + half) / rs), 0, dim - 1);
      return w.regions[iz * dim + ix];
    };
    this.physics = new PhysicsSystem(w.db, w.frames, w.terrain, this.discovery, this.qcache, w.trail, regionAt, half);
    this.relational = new RelationalPresenter(this.stage, w.db, w.frames, this.store, this.grassGeo);
    this.relational.grassDistance = this.quality.grassDistance;
    this.stage.scene.add(this.relational.root);
    this.vis = new VisibilitySystem();
    this.shadow = new ShadowSystem();
    // player starts trail-relative
    this.physics.readBody(w.player, this.body);
    this.body.yaw = w.frames.worldYaw(w.player);
    this.cam.reset(this.body.yaw + Math.PI);
    this.applyFlags();
  }

  get isMobileQuality(): boolean { return this.quality.shadowMapSize <= 1024; }

  private generate(def: number, lod: number): { geometry?: import('../geometry/MeshBuilder').GeometryData; grass?: import('../geometry/Generators').GrassPayload } {
    const w = this.world;
    const d = w.db.defs[def];
    const t0 = w.terrain.evalCount;
    let res: ReturnType<Engine['generate']>;
    if (d.family === Family.TerrainPatch) {
      res = lod === 3 ? { grass: grassPatch(w.terrain, d, this.quality.grassDensity) } : { geometry: terrainPatch(w.terrain, d, lod) };
    } else if (d.family === Family.WaterPatch) {
      res = { geometry: waterPatch(w.streamCurve, w.terrain, d) };
    } else {
      res = { geometry: generateArchetype(d, lod) };
    }
    counters.terrainEvals += w.terrain.evalCount - t0;
    return res;
  }

  // ------------------------------------------------------------------ architecture switching
  async setArchitecture(id: ArchId, custom?: Partial<ArchFlags>): Promise<void> {
    const prevPresenter = this.flags.presenter;
    const next: ArchFlags = id === 'custom' ? { ...this.flags, ...custom } : { ...PRESETS[id] };
    if (next.presenter !== 'relational') {
      if (!this.conventional || this.conventional.mode !== next.presenter) {
        // keep rendering the previous architecture until the new scene exists
        const old = this.conventional;
        this.onStatus?.(`Building conventional scene (${next.presenter}) — all geometry up front…`);
        await new Promise((r) => setTimeout(r, 30));
        const cp = new ConventionalPresenter(this.stage, next.presenter as 'scenegraph' | 'batched');
        cp.grassGeometry = this.grassGeo;
        this.conventionalStats = cp.build(this.world, (d, l) => this.generate(d, l), this.quality.grassDistance);
        if (old) { this.stage.scene.remove(old.root); old.dispose(); }
        this.conventional = cp;
        this.stage.scene.add(cp.root);
        this.onStatus?.('');
      }
      // release relational representations so memory reflects the active architecture
      if (prevPresenter === 'relational') { this.store.clear(); this.relational.clear(); }
    } else if (this.conventional) {
      this.stage.scene.remove(this.conventional.root);
      this.conventional.dispose();
      this.conventional = null;
      this.conventionalStats = null;
    }
    this.arch = id;
    this.flags = next;
    this.applyFlags();
  }

  applyFlags(): void {
    const f = this.flags;
    const w = this.world;
    if (w.frames.caching !== f.transformCache) { w.frames.caching = f.transformCache; w.frames.invalidateAll(); }
    this.discovery.useIndex = f.spatialIndex;
    if (this.qcache.enabled !== f.queryCache) { this.qcache.enabled = f.queryCache; this.qcache.clear(); }
    if (this.store.retain !== f.geometryCache) { this.store.retain = f.geometryCache; }
    this.relational.instanceCache = f.instanceCache;
    this.relational.skipUnchanged = f.instanceCache;
    this.relational.invalidate();
    const rel = f.presenter === 'relational';
    this.relational.setVisible(rel);
    this.conventional?.setVisible(!rel);
    this.geomChanged = true;
  }

  /** Reset caches to a cold state (benchmarks). */
  coldReset(): void {
    this.qcache.clear();
    this.world.frames.invalidateAll();
    if (this.flags.presenter === 'relational') {
      this.store.clear();
      this.relational.clear();
    }
    this.store.resetStats();
    this.sharedComplete = false;
    this.prefetchCell = -1;
    this.qcache.total = { hits: 0, misses: 0, invalidations: 0, evictions: 0 };
    this.geomChanged = true;
  }

  /** Synchronously generate what the current view needs (initial fill). */
  prewarm(maxMs: number): void {
    if (this.flags.presenter !== 'relational') return;
    const t0 = performance.now();
    this.lookTmp.dx = this.lookTmp.dy = this.lookTmp.zoom = 0;
    for (let i = 0; i < 40 && performance.now() - t0 < maxMs; i++) {
      this.store.beginFrame(++this.frame);
      this.updateCamera(1 / 60);
      this.evaluateRelational();
      if (this.store.pendingCount === 0 && counters.unresolved === 0) break;
      this.store.process(maxMs);
    }
  }

  // ------------------------------------------------------------------ frame
  tick(now: number): void {
    if (this.lastNow < 0) this.lastNow = now;
    const interval = now - this.lastNow;
    this.lastNow = now;
    this.lastIntervalMs = interval;
    if (this.paused) return;
    profiler.beginFrame();
    counters.reset();
    const w = this.world;
    const dt = this.fixedDt ?? clamp(interval / 1000, 0, 0.1);
    this.time += dt;
    this.frame++;
    this.store.beginFrame(this.frame);
    w.frames.resetStats();
    this.index.resetStats();
    this.qcache.resetStats();
    const evalBefore = w.terrain.evalCount;

    // ---------------- input
    profiler.begin(Scope.Input);
    this.input.readMove(this.moveTmp);
    this.input.consumeLook(this.lookTmp);
    const jump = this.input.consumeJump();
    profiler.end(Scope.Input);

    if (this.script) this.applyScript(dt);
    else this.simulatePlayer(dt, jump);

    // ---------------- animation
    profiler.begin(Scope.Animation);
    this.character.update(this.body, dt, this.time);
    profiler.end(Scope.Animation);

    // ---------------- camera → observation
    profiler.begin(Scope.Camera);
    this.updateCamera(dt);
    profiler.end(Scope.Camera);

    // ---------------- evaluation
    if (this.flags.presenter === 'relational' || !this.conventional) this.evaluateRelational();
    else this.evaluateConventional();

    profiler.begin(Scope.Audio);
    this.audio.update(this.time, this.cam.x, this.cam.y, this.cam.z, -Math.sin(this.cam.yaw), -Math.cos(this.cam.yaw), this.discovery, this.qcache, w.db, w.frames);
    profiler.end(Scope.Audio);

    // ---------------- lighting → stage
    this.stage.applyLighting(this.lighting, this.time);
    this.stage.applyLocalLights(this.lighting.active);
    this.obs.truncated(this.receiverTmp, Math.min(this.shadow.shadowDistance, this.obs.far));
    const sd = this.lighting.sunDir;
    const reach = Math.min(this.shadow.maxReach, (this.shadow.maxCasterHeight * Math.sqrt(Math.max(0, 1 - sd[1] * sd[1]))) / Math.max(0.12, sd[1]));
    this.stage.fitShadow(this.receiverTmp.corners, sd, reach);
    this.stage.setSunForSky(sd);
    this.stage.updateAtmosphere(dt, this.cam.x, this.cam.y, this.cam.z);

    // ---------------- debug overlays
    if (this.debugUpdate) {
      profiler.begin(Scope.DebugViz);
      this.debugUpdate();
      profiler.end(Scope.DebugViz);
    }

    // ---------------- render submit (CPU) + GPU timer
    profiler.begin(Scope.RenderSubmit);
    this.gpu.begin(this.frame);
    this.stage.scene.matrixWorldAutoUpdate = true;
    this.stage.render();
    this.gpu.end();
    profiler.end(Scope.RenderSubmit);
    this.gpu.poll();
    this.glInstr.endFrame();
    const info = this.stage.renderer.info;
    const ri = this.renderInfo;
    const rr = info.render as unknown as { calls?: number; drawCalls?: number; triangles: number; points: number; lines: number };
    ri.calls = rr.calls ?? rr.drawCalls ?? NaN; ri.triangles = rr.triangles; ri.points = rr.points; ri.lines = rr.lines;
    if (this.stage.webgpuRenderer) this.pollWebGPUTimestamp();
    ri.geometries = info.memory.geometries; ri.textures = info.memory.textures;
    ri.programs = (info as unknown as { programs?: unknown[] }).programs?.length ?? 0;
    counters.terrainEvals += w.terrain.evalCount - evalBefore;
    profiler.endFrame();
    this.record(interval);
  }

  /** Third-person camera → Three camera → renderer-agnostic Observation. */
  private updateCamera(dt: number): void {
    const w = this.world;
    if (!this.script) {
      if (this.stage.useObserver) {
        this.observerYaw -= this.lookTmp.dx * 0.005;
        this.observerHeight = clamp(this.observerHeight + this.lookTmp.dy * 0.4 + this.lookTmp.zoom * 0.1, 30, 400);
      } else {
        this.cam.look(this.lookTmp.dx, this.lookTmp.dy, this.lookTmp.zoom, this.time);
      }
      const moving = this.body.speed > 0.8;
      this.cam.update(this.body.x, this.body.y, this.body.z, this.body.yaw, moving, dt, this.time, w.terrain,
        (ax, ay, az, bx, by, bz) => this.physics.raycastTrunks(ax, ay, az, bx, by, bz, 0.25));
    }
    const c = this.stage.camera;
    c.position.set(this.cam.x, this.cam.y, this.cam.z);
    c.lookAt(this.cam.tx, this.cam.ty, this.cam.tz);
    c.updateMatrixWorld();
    this.obs.frame = this.frame;
    this.obs.lodScale = this.quality.lodScale;
    this.obs.setFromLook(this.cam.x, this.cam.y, this.cam.z, this.cam.tx, this.cam.ty, this.cam.tz,
      THREE.MathUtils.degToRad(c.fov), c.aspect, 0.25, this.quality.far);
    if (this.stage.useObserver) this.updateObserverCamera();
  }

  private simulatePlayer(dt: number, jump: boolean): void {
    const w = this.world;
    const m = this.moveTmp;
    this.cam.groundForward(this.fwdTmp);
    const fx = this.fwdTmp.x, fz = this.fwdTmp.z;
    // camera-relative intent: forward = away from camera, right = (−fz, fx)… on the ground plane
    let dx = fx * m.y - fz * m.x;
    let dz = fz * m.y + fx * m.x;
    const l = Math.hypot(dx, dz);
    if (l > 1e-4) { dx /= l; dz /= l; }
    const intent: MoveIntent = { dirX: dx, dirZ: dz, magnitude: m.mag, sprint: this.input.sprintHeld, jump };
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const h = dt / steps;
    const b = this.body;
    const px = b.x, py = b.y, pz = b.z, pyaw = b.yaw;
    for (let i = 0; i < steps; i++) {
      this.physics.step(b, intent, h);
      intent.jump = false;
    }
    if (m.mag > 0.05) {
      const target = Math.atan2(b.vx, b.vz);
      if (Math.hypot(b.vx, b.vz) > 0.3) b.yaw = dampAngleSafe(b.yaw, target, 12, dt);
    }
    // write the result back into the relational world (only if it actually changed)
    if (Math.abs(b.x - px) + Math.abs(b.y - py) + Math.abs(b.z - pz) > 1e-6 || Math.abs(b.yaw - pyaw) > 1e-6) {
      this.physics.writeBack(w.player, b);
    }
  }

  private applyScript(dt: number): void {
    const w = this.world;
    const pose = this.script!(this.frame, this.time);
    const curve = w.trailCurve;
    // the scripted runner is positioned *relative to the trail* (no absolute coordinate)
    const db = w.db;
    if (db.parent[w.player] !== w.trail) db.reparent(w.player, w.trail, FrameMode.Curve);
    const heading = curve.smoothHeading(pose.s);
    const s = curve.wrapS(pose.s);
    const lo = w.player * 8;
    const L = db.local;
    // only a real change of the local reference counts as a mutation (keeps caches valid when still)
    if (L[lo] !== s || L[lo + 1] !== 0 || L[lo + 2] !== pose.lateral || L[lo + 4] !== 0 || L[lo + 6] !== 1) {
      L[lo] = s; L[lo + 1] = 0; L[lo + 2] = pose.lateral;
      L[lo + 3] = 0; L[lo + 4] = 0; L[lo + 5] = 0; L[lo + 6] = 1;
      db.touch(w.player);
    }
    const prevX = this.body.x, prevZ = this.body.z;
    this.physics.readBody(w.player, this.body);
    const ground = w.terrain.height(this.body.x, this.body.z);
    this.body.y = Math.max(this.body.y, ground);
    const moved = Math.hypot(this.body.x - prevX, this.body.z - prevZ);
    this.body.speed = dt > 0 ? moved / dt : 0;
    this.body.stride += moved;
    this.body.grounded = true;
    this.body.yaw = heading;
    // physics workload is still evaluated (broadphase + narrowphase), result discarded
    const probe = this.probeBody;
    probe.x = this.body.x; probe.y = this.body.y; probe.z = this.body.z; probe.vx = 0; probe.vy = 0; probe.vz = 0; probe.grounded = true;
    this.physics.step(probe, { dirX: 0, dirZ: 0, magnitude: 0, sprint: false, jump: false }, 1 / 60);
    const yaw = heading + Math.PI + pose.camYaw;
    const cp = Math.cos(pose.camPitch), sp = Math.sin(pose.camPitch);
    const tx = this.body.x, ty = this.body.y + 1.55, tz = this.body.z;
    const cx = tx + Math.sin(yaw) * cp * pose.camDist, cz = tz + Math.cos(yaw) * cp * pose.camDist;
    let cy = ty + sp * pose.camDist + (pose.camHeight ?? 0);
    cy = Math.max(cy, w.terrain.height(cx, cz) + 0.7);
    this.cam.setPose(cx, cy, cz, tx, ty, tz);
    this.cam.yaw = yaw;
  }
  private probeBody = new CharacterBody();

  private updateObserverCamera(): void {
    const oc = this.stage.observerCamera;
    const px = this.body.x, py = this.body.y, pz = this.body.z;
    oc.position.set(px + Math.sin(this.observerYaw) * this.observerDist, py + this.observerHeight, pz + Math.cos(this.observerYaw) * this.observerDist);
    oc.lookAt(px, py, pz);
    oc.far = 3000;
    oc.updateMatrixWorld();
  }

  private evaluateRelational(): void {
    const w = this.world;
    this.discovery.sync();
    this.vis.evaluate(this.obs, this.discovery, this.qcache, w.db);
    this.lighting.evaluate(this.obs, this.discovery, this.qcache, w.db, w.frames);
    const sd = this.lighting.sunDir;
    this.shadow.evaluate(this.obs, sd[0], sd[1], sd[2], this.lighting.sunVersion, this.discovery, this.qcache, w.db, this.vis, this.debugCollect);
    this.relational.assemble(this.obs, this.vis, this.shadow, this.geomChanged, this.debugCollect);
    // prefetching is only meaningful when generated representations are retained (else: generate → dispose churn, measured)
    if (this.flags.prefetch && this.store.retain) this.prefetchNearby();
    profiler.begin(Scope.GeomGen);
    const made = this.store.process(this.quality.geomBudgetMs);
    profiler.end(Scope.GeomGen);
    this.store.endFrame();
    this.geomChanged = made > 0 || counters.geomDisposed > 0 || counters.geomEvicted > 0;
    this.collectCounters();
  }

  /**
   * Anticipatory demand: queue, at a priority below anything a consumer requested,
   * (1) every LOD of every shared archetype and (2) unique representations (terrain/water
   * patches and grass) in a ring around the camera — so turning the camera does not expose
   * ungenerated representations. Generation still respects the per-frame time budget.
   */
  prefetchRadius = 190;
  private prefetchList = new IntList(256);
  private prefetchCell = -1;
  private sharedComplete = false;
  private sharedCheckedAt = -1;
  private prefetchNearby(): void {
    const w = this.world;
    // shared archetypes: every LOD of every archetype (a few MB, serves thousands of instances)
    if (!this.sharedComplete || this.sharedCheckedAt !== this.store.disposedTotal) {
      this.sharedCheckedAt = this.store.disposedTotal;
      let missing = 0;
      for (const d of w.db.defs) {
        if (!d.shared) continue;
        for (let lod = 0; lod < d.lodCount; lod++) {
          const k = keyOf(d.id, lod);
          if (!this.store.peek(k)) { missing++; this.store.prefetch(k, 1e7 + lod); }
        }
      }
      this.sharedComplete = missing === 0;
    }
    const cell = 24;
    const qx = Math.floor(this.obs.px / cell), qz = Math.floor(this.obs.pz / cell);
    const key = qx * 73856093 ^ qz * 19349663;
    if (key !== this.prefetchCell) {
      this.prefetchCell = key;
      this.prefetchList.clear();
      this.discovery.sphere(this.obs.px, this.obs.py, this.obs.pz, Math.max(this.prefetchRadius, this.obs.far), Flag.Terrain | Flag.Water, this.prefetchList);
      for (const b of w.bridges) this.prefetchList.push(b);
    }
    const db = w.db, B = this.discovery.boundsOf(0);
    const ls2 = this.obs.lodScale * this.obs.lodScale;
    for (let i = 0; i < this.prefetchList.length; i++) {
      const e = this.prefetchList.data[i];
      const di = db.def[e];
      if (di < 0) continue;
      const def = db.defs[di];
      if (def.shared) continue; // archetypes are handled above
      const o = e * 4;
      const h = def.params[2] * 0.5 || 0;
      const dx = Math.max(Math.abs(B[o] - this.obs.px) - h, 0), dz = Math.max(Math.abs(B[o + 2] - this.obs.pz) - h, 0);
      const d2 = dx * dx + dz * dz;
      let lod = 0;
      while (lod < def.lodCount - 1 && d2 > def.lodDist2[lod] * ls2) lod++;
      this.store.prefetch(keyOf(def.id, lod), 1e7 + d2);
      if (def.family === Family.TerrainPatch && d2 < (this.quality.grassDistance + 46) ** 2 ) this.store.prefetch(def.id * 4 + 3, 1e7 + d2);
    }
  }

  private evaluateConventional(): void {
    const w = this.world;
    this.discovery.sync();
    this.lighting.evaluate(this.obs, this.discovery, this.qcache, w.db, w.frames);
    this.conventional!.update(this.stage.useObserver ? this.stage.observerCamera : this.stage.camera);
    this.collectCounters();
  }

  private collectCounters(): void {
    const w = this.world;
    const fs = w.frames.stats;
    counters.resolveCalls = fs.calls;
    counters.resolveRecomputes = fs.recomputes;
    counters.resolveHits = fs.hits;
    const st = this.index.stats;
    counters.queryNodes = st.nodesVisited;
    counters.queryTests += st.objectsTested;
    counters.queryResults = st.results;
  }

  private record(interval: number): void {
    const s = this.stats;
    const o = s.begin();
    const d = s.data;
    d[o + F.t] = this.lastNow;
    d[o + F.interval] = interval;
    d[o + F.cpu] = profiler.acc[Scope.Frame];
    d[o + F.gpu] = NaN;
    d[o + F.draws] = this.renderInfo.calls;
    d[o + F.tris] = this.renderInfo.triangles;
    d[o + F.heapMB] = this.perf.heapUsedMB;
    d[o + F.visible] = this.flags.presenter === 'relational' ? counters.visible : NaN;
    d[o + F.shadowOnly] = this.flags.presenter === 'relational' ? counters.shadowOnly : NaN;
    d[o + F.unresolved] = counters.unresolved;
    d[o + F.queries] = counters.queries;
    d[o + F.qHits] = counters.qcacheHits;
    d[o + F.qMiss] = counters.qcacheMisses;
    d[o + F.geomGen] = counters.geomGenerated;
    d[o + F.geomHit] = counters.geomCacheHits;
    d[o + F.geomMiss] = counters.geomCacheMisses;
    d[o + F.resolveCalls] = counters.resolveCalls;
    d[o + F.resolveRecomputes] = counters.resolveRecomputes;
    d[o + F.instances] = counters.instancesWritten;
    d[o + F.uploadKB] = counters.uploadBytes / 1024;
    if (profiler.enabled) for (let i = 0; i < Scope.COUNT; i++) d[o + SCOPE_OFFSET + i] = profiler.acc[i];
    else d[o + SCOPE_OFFSET] = profiler.acc[Scope.Frame];
    s.commit();
  }

  /** Experimental: WebGPU timestamp queries via Three.js (only when the adapter exposes 'timestamp-query'). */
  webgpuTimestampMs = NaN;
  private webgpuPending = false;
  private pollWebGPUTimestamp(): void {
    const r = this.stage.webgpuRenderer as unknown as { resolveTimestampsAsync?: (t?: string) => Promise<number | undefined>; info: { render: { timestamp?: number } } };
    if (!r.resolveTimestampsAsync || this.webgpuPending) return;
    const frame = this.frame;
    this.webgpuPending = true;
    r.resolveTimestampsAsync('render').then((v) => {
      const ms = typeof v === 'number' ? v : r.info.render.timestamp;
      if (typeof ms === 'number' && ms > 0 && ms < 10000) { this.webgpuTimestampMs = ms; this.attachGpu(frame, ms); }
    }).catch(() => { /* timestamp-query unsupported */ }).finally(() => { this.webgpuPending = false; });
  }

  /** Attach an asynchronously resolved GPU time to the frame that issued it. */
  private attachGpu(frame: number, ms: number): void {
    const age = this.frame - frame;
    if (age < 0 || age >= this.stats.size) return;
    const idx = (this.stats.head - 1 - age + this.stats.capacity * 2) % this.stats.capacity;
    this.stats.data[idx * (this.stats.data.length / this.stats.capacity) + F.gpu] = ms;
  }

  // ------------------------------------------------------------------ dev actions
  /** Dependency-invalidation demo: move one region frame; every descendant re-resolves. */
  nudgeRegion(dx: number): number {
    const w = this.world;
    const r = this.physics ? this.regionUnder(this.body.x + 70 * Math.sin(this.body.yaw), this.body.z + 70 * Math.cos(this.body.yaw)) : -1;
    if (r < 0) return -1;
    const o = r * 8;
    w.db.setLocal(r, w.db.local[o] + dx, w.db.local[o + 1], w.db.local[o + 2]);
    return r;
  }

  regionUnder(x: number, z: number): number {
    const w = this.world, cfg = w.config, half = cfg.size / 2;
    const ix = Math.floor((x + half) / cfg.regionSize), iz = Math.floor((z + half) / cfg.regionSize);
    if (ix < 0 || iz < 0 || ix >= w.regionDim || iz >= w.regionDim) return -1;
    return w.regions[iz * w.regionDim + ix];
  }

  /** Teleport the runner to an arc length on the trail (trail-relative positioning). */
  placeOnTrail(s: number): void {
    const w = this.world;
    w.db.reparent(w.player, w.trail, FrameMode.Curve);
    w.db.setLocal(w.player, w.trailCurve.wrapS(s), 0, 0);
    w.db.setLocalYaw(w.player, 0);
    this.physics.readBody(w.player, this.body);
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.cam.reset(this.body.yaw + Math.PI);
  }

  playerFrameDescription(): string {
    const w = this.world, db = w.db, e = w.player, p = db.parent[e];
    const o = e * 8;
    const L = db.local;
    const pname = db.names.get(p) ?? `${Kind[db.kind[p]]} #${p}`;
    switch (db.mode[e]) {
      case FrameMode.Curve: return `${pname} · s=${L[o].toFixed(1)} m, lateral=${L[o + 2].toFixed(2)} m, h=${L[o + 1].toFixed(2)} m`;
      case FrameMode.Grounded: return `${pname} · local (${L[o].toFixed(1)}, ${L[o + 2].toFixed(1)}) m, +${L[o + 1].toFixed(2)} m above ground`;
      default: return `${pname} · local (${L[o].toFixed(2)}, ${L[o + 1].toFixed(2)}, ${L[o + 2].toFixed(2)}) m`;
    }
  }

  nearestTrailS(): number {
    const p = this.world.trailCurve.nearest(this.body.x, this.body.z, this.proj);
    return p.dist === Infinity ? 0 : p.s;
  }
}

const FAMILY_LABEL: Record<number, string> = {
  [Family.Pine]: 'Pine', [Family.Oak]: 'Oak', [Family.Birch]: 'Birch', [Family.Rock]: 'Rock', [Family.Bush]: 'Bush', [Family.Fern]: 'Fern',
  [Family.Lantern]: 'Lantern', [Family.Bridge]: 'Bridge', [Family.TerrainPatch]: 'Terrain', [Family.WaterPatch]: 'Water', [Family.StressPillar]: 'Pillar',
};

function dampAngleSafe(a: number, b: number, l: number, dt: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-l * dt));
}

