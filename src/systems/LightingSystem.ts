/**
 * LIGHTING — independent evaluation system.
 *
 * Derives global illumination parameters (sun/moon direction and color, sky,
 * ambient, fog) from world state (time of day), and selects which local light
 * emitters actually matter for the current observation:
 *   candidate lights = emitters whose influence sphere could reach the observer's
 *   surroundings (sphere query, cached per camera cell), refined by testing the
 *   influence sphere against the view frustum, ranked by estimated contribution.
 * A fixed pool of K lights is used so shader programs never recompile.
 */
import { Observation } from './Observation';
import { Discovery } from '../spatial/Discovery';
import { QueryCache, cacheKey } from '../spatial/QueryCache';
import { WorldDatabase } from '../world/WorldDatabase';
import { FrameSystem } from '../world/FrameSystem';
import { Flag } from '../world/types';
import { IntList, smoothstep, lerp, quatRotate } from '../util/math';
import { profiler, Scope, counters } from '../diagnostics/Profiler';

export interface ActiveLight {
  entity: number;
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  intensity: number;
  range: number;
  score: number;
}

type C3 = [number, number, number];
const mixc = (a: C3, b: C3, t: number, out: C3) => {
  out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t);
};

export class LightingSystem {
  timeOfDay = 16.2;
  readonly K = 4;
  lightQueryRadius = 75;
  // outputs
  sunDir = new Float64Array([0.4, 0.7, 0.3]);
  sunColor: C3 = [1, 1, 1];
  sunIntensity = 3;
  skyZenith: C3 = [0.3, 0.5, 0.9];
  skyHorizon: C3 = [0.8, 0.85, 0.9];
  hemiSky: C3 = [0.6, 0.7, 0.9];
  hemiGround: C3 = [0.3, 0.25, 0.15];
  hemiIntensity = 1;
  fogColor: C3 = [0.8, 0.85, 0.9];
  fogDensity = 0.004;
  night = 0;
  isMoon = false;
  sunVersion = 1;
  private lastQuantSun = -1;
  readonly active: ActiveLight[] = [];
  readonly candidates = new IntList(128);
  considered = 0;
  private scratch: ActiveLight[] = [];
  private tmp = new Float64Array(4);
  fromCache = false;

  constructor() {
    for (let i = 0; i < 256; i++) this.scratch.push({ entity: -1, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, intensity: 0, range: 0, score: 0 });
  }

  updateGlobal(): void {
    const t = this.timeOfDay;
    const phase = ((t - 6) / 12) * Math.PI; // 0 at sunrise, PI at sunset
    const sinEl = Math.sin(phase) * 0.92;
    const az = phase + 0.35;
    let x = Math.cos(az), z = -Math.sin(az) * 0.55 - 0.35;
    let y = sinEl;
    this.isMoon = y < -0.04;
    if (this.isMoon) { x = -x; z = -z * 0.8; y = Math.max(0.35, -y); }
    const l = Math.hypot(x, y, z);
    this.sunDir[0] = x / l; this.sunDir[1] = Math.max(0.1, y / l); this.sunDir[2] = z / l;
    const n = Math.hypot(this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    this.sunDir[0] /= n; this.sunDir[1] /= n; this.sunDir[2] /= n;

    const day = smoothstep(-0.08, 0.35, sinEl);
    const golden = smoothstep(0.42, 0.04, sinEl) * smoothstep(-0.12, 0.04, sinEl);
    this.night = 1 - smoothstep(-0.1, 0.12, sinEl);
    const zDay: C3 = [0.22, 0.45, 0.82], hDay: C3 = [0.7, 0.82, 0.92];
    const zSet: C3 = [0.2, 0.25, 0.5], hSet: C3 = [0.98, 0.58, 0.32];
    const zNight: C3 = [0.012, 0.02, 0.055], hNight: C3 = [0.045, 0.06, 0.11];
    const z1: C3 = [0, 0, 0], h1: C3 = [0, 0, 0];
    mixc(zNight, zDay, day, z1); mixc(hNight, hDay, day, h1);
    mixc(z1, zSet, golden * 0.85, this.skyZenith);
    mixc(h1, hSet, golden, this.skyHorizon);
    if (this.isMoon) {
      this.sunColor = [0.5, 0.6, 0.9];
      this.sunIntensity = 0.45;
    } else {
      mixc([1.0, 0.95, 0.86], [1.0, 0.55, 0.28], golden, this.sunColor);
      this.sunIntensity = 0.4 + 2.6 * day;
    }
    mixc(this.skyHorizon, this.skyZenith, 0.5, this.hemiSky);
    this.hemiGround = [0.22 * (0.2 + day), 0.2 * (0.2 + day), 0.13 * (0.2 + day)];
    this.hemiIntensity = 0.25 + 0.95 * day;
    this.fogColor = [this.skyHorizon[0], this.skyHorizon[1], this.skyHorizon[2]];
    this.fogDensity = 0.0042 + 0.004 * golden + 0.003 * this.night;
    const q = Math.round(this.sunDir[0] * 500) * 1000003 + Math.round(this.sunDir[1] * 500) * 1009 + Math.round(this.sunDir[2] * 500);
    if (q !== this.lastQuantSun) { this.lastQuantSun = q; this.sunVersion++; }
  }

  /** Select local lights relevant to the observation. */
  evaluate(obs: Observation, discovery: Discovery, qcache: QueryCache, db: WorldDatabase, frames: FrameSystem): void {
    profiler.begin(Scope.Lighting);
    this.updateGlobal();
    this.active.length = 0;
    this.considered = 0;
    if (this.night <= 0.01) {
      counters.lightsActive = 0;
      profiler.end(Scope.Lighting);
      return;
    }
    const cell = 8;
    const qx = Math.floor(obs.px / cell), qz = Math.floor(obs.pz / cell);
    const key = cacheKey(qx, qz, 0x4c495448, Math.round(this.lightQueryRadius));
    profiler.begin(Scope.CacheLookup);
    let list = qcache.lookup(key, discovery.index, db.structureVersion);
    profiler.end(Scope.CacheLookup);
    this.fromCache = list !== null;
    if (!list) {
      this.candidates.clear();
      // cover any camera position inside the cell
      discovery.sphere((qx + 0.5) * cell, obs.py, (qz + 0.5) * cell, this.lightQueryRadius + cell, Flag.EmitsLight, this.candidates);
      list = this.candidates;
      qcache.store(key, list, discovery.lastMask, discovery.index, db.structureVersion);
    }
    if (this.fromCache) counters.qcacheHits++; else counters.qcacheMisses++;
    let n = 0;
    const W = frames.world;
    for (let i = 0; i < list.length && n < this.scratch.length; i++) {
      const e = list.data[i];
      const li = db.light[e];
      if (li < 0) continue;
      const desc = db.lights[li];
      const strength = desc.nightOnly ? this.night : 1;
      if (strength <= 0.01) continue;
      this.considered++;
      const o = frames.resolve(e);
      // lamp offset in the entity frame (lantern housing)
      quatRotate(W, o + 3, 0, 1.76, desc.range > 12 ? 0.44 : 0, this.tmp, 0);
      const x = W[o] + this.tmp[0], y = W[o + 1] + this.tmp[1], z = W[o + 2] + this.tmp[2];
      if (obs.volume.sphere(x, y, z, desc.range) === 0) continue;
      const dx = x - obs.px, dy = y - obs.py, dz = z - obs.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const score = (desc.intensity * strength) / (1 + d2 / (desc.range * desc.range));
      const s = this.scratch[n++];
      s.entity = e; s.x = x; s.y = y; s.z = z;
      s.r = desc.color[0]; s.g = desc.color[1]; s.b = desc.color[2];
      s.intensity = desc.intensity * strength; s.range = desc.range; s.score = score;
    }
    // partial selection of top-K by score (K is tiny)
    for (let k = 0; k < this.K && k < n; k++) {
      let best = k;
      for (let j = k + 1; j < n; j++) if (this.scratch[j].score > this.scratch[best].score) best = j;
      const t = this.scratch[k]; this.scratch[k] = this.scratch[best]; this.scratch[best] = t;
      this.active.push(this.scratch[k]);
    }
    counters.lightsConsidered = this.considered;
    counters.lightsActive = this.active.length;
    profiler.end(Scope.Lighting);
  }
}
