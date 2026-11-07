import { describe, it, expect } from 'vitest';
import { buildWorld, DEFAULT_WORLD } from '../src/world/WorldGenerator';
import { Kind } from '../src/world/types';

describe('world generation', () => {
  it('builds a deterministic forest world as data', () => {
    const a = buildWorld(DEFAULT_WORLD);
    const b = buildWorld(DEFAULT_WORLD);
    expect(a.db.count).toBe(b.db.count);
    expect(a.db.count).toBeGreaterThan(5000);
    expect(a.bridges.length).toBeGreaterThanOrEqual(1);
    const counts = a.counts;
    console.log('entities', a.db.count, counts, 'bridges', a.bridges.length, 'lanterns', a.lanterns.length, 'buildMs', a.buildMs.toFixed(1), 'trail length', a.trailCurve.length.toFixed(0), 'relationships', a.db.relationshipCount());
    expect(counts[Kind[Kind.Tree]]).toBeGreaterThan(1000);
  });
});
