import { describe, it, expect } from 'vitest';
import { buildWorld, DEFAULT_WORLD } from '../src/world/WorldGenerator';
import { SpatialIndex } from '../src/spatial/SpatialIndex';
import { Discovery } from '../src/spatial/Discovery';
import { QueryCache } from '../src/spatial/QueryCache';
import { PhysicsSystem, CharacterBody } from '../src/systems/PhysicsSystem';
import { FrameMode } from '../src/world/types';

describe('runner crossing bridges (integration: world + frames + physics)', () => {
  it('runs along the trail over every bridge without NaN, staying at deck height', () => {
    const w = buildWorld(DEFAULT_WORLD);
    const half = w.config.size / 2;
    const index = new SpatialIndex(-half - 32, -half - 32, w.config.size + 64, 6);
    const disc = new Discovery(w.db, w.frames, index);
    disc.rebuild();
    const rs = w.config.regionSize;
    const regionAt = (x: number, z: number) => {
      const ix = Math.max(0, Math.min(w.regionDim - 1, Math.floor((x + half) / rs)));
      const iz = Math.max(0, Math.min(w.regionDim - 1, Math.floor((z + half) / rs)));
      return w.regions[iz * w.regionDim + ix];
    };
    const physics = new PhysicsSystem(w.db, w.frames, w.terrain, disc, new QueryCache(), w.trail, regionAt, half);
    expect(w.bridges.length).toBeGreaterThan(0);
    for (const b of w.bridges) {
      const sB = w.db.local[b * 8];
      const halfLen = w.db.defs[w.db.def[b]].params[0];
      const deckY = w.frames.world[w.frames.resolve(b) + 1];
      // start 15 m before the bridge on the trail
      w.db.reparent(w.player, w.trail, FrameMode.Curve);
      w.db.setLocal(w.player, w.trailCurve.wrapS(sB - halfLen - 15), 0, 0);
      w.db.setLocalYaw(w.player, 0);
      const body = new CharacterBody();
      physics.readBody(w.player, body);
      let onDeck = 0;
      let minY = Infinity;
      for (let i = 0; i < 60 * 12; i++) {
        // steer along the trail tangent at the runner's current station
        const p = w.trailCurve.nearest(body.x, body.z, { s: 0, lateral: 0, dist: 0, seg: 0 });
        const h = w.trailCurve.smoothHeading(p.s === undefined ? 0 : p.s + 2);
        physics.step(body, { dirX: Math.sin(h), dirZ: Math.cos(h), magnitude: 1, sprint: false, jump: false }, 1 / 60);
        body.yaw = h;
        physics.writeBack(w.player, body);
        physics.readBody(w.player, body);
        expect(Number.isFinite(body.x) && Number.isFinite(body.y) && Number.isFinite(body.z)).toBe(true);
        const local = w.db.local[w.player * 8];
        expect(Number.isFinite(local)).toBe(true);
        if (body.onBridge === b) { onDeck++; minY = Math.min(minY, body.y); }
        const s = w.trailCurve.nearest(body.x, body.z, { s: 0, lateral: 0, dist: 0, seg: 0 }).s;
        if (Math.abs(w.trailCurve.wrapS(s - (sB + halfLen + 6))) < 2) break;
      }
      expect(onDeck).toBeGreaterThan(10);
      expect(minY).toBeGreaterThan(deckY - 0.05);
    }
  });
});
