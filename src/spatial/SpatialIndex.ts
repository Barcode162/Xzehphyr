/**
 * SPATIAL DISCOVERY — hierarchical loose quadtree over the XZ plane.
 *
 * Entities are inserted by their resolved world bounding sphere into the deepest
 * node whose *loose* bounds (2x cell size) contain them. Each node aggregates:
 *   - subtree object count (skip empty branches)
 *   - OR of subtree entity flags (a lighting query never descends into a branch
 *     that contains no light emitters; physics skips branches without colliders)
 *   - subtree vertical range (tight Y bounds for frustum / shadow tests)
 *
 * Dependency tracking for cached queries: modifications bump a version on the
 * affected depth-2 quadrant(s). A cached query records which quadrants it touched
 * and is invalidated only when one of those changes.
 */
import { ConvexVolume } from './Frustum';
import { IntList } from '../util/math';

export interface QueryStats {
  queries: number;
  nodesVisited: number;
  objectsTested: number;
  results: number;
}

const QUAD_LEVEL = 2;
const QUADS = 16;

export class SpatialIndex {
  readonly minX: number;
  readonly minZ: number;
  readonly size: number;
  readonly maxDepth: number;
  readonly nodeCount: number;
  private levelOffset: number[] = [];
  // node data
  nodeHead: Int32Array;
  nodeObjects: Int32Array;
  subtreeCount: Int32Array;
  nodeFlags: Uint32Array;
  nodeMinY: Float32Array;
  nodeMaxY: Float32Array;
  // per entity
  private entCap = 0;
  entNode: Int32Array = new Int32Array(0);
  entNext: Int32Array = new Int32Array(0);
  entPrev: Int32Array = new Int32Array(0);
  entBounds: Float32Array = new Float32Array(0);
  entFlags: Uint32Array = new Uint32Array(0);
  entLevel: Uint8Array = new Uint8Array(0);
  // versions
  version = 1;
  quadVersion = new Uint32Array(QUADS);
  /** Quadrants touched by the most recent query (bitmask). */
  lastQuadMask = 0;
  /** Debug: when set, node ids visited by queries are appended here (with the query tag). */
  recordVisited: IntList | null = null;
  recordTag = 0;
  size2: number;
  objectCount = 0;
  stats: QueryStats = { queries: 0, nodesVisited: 0, objectsTested: 0, results: 0 };
  private stack: Int32Array;
  private stackInside: Uint8Array;

  constructor(minX: number, minZ: number, size: number, maxDepth = 6) {
    this.minX = minX;
    this.minZ = minZ;
    this.size = size;
    this.size2 = size;
    this.maxDepth = maxDepth;
    let off = 0;
    for (let l = 0; l <= maxDepth; l++) {
      this.levelOffset.push(off);
      off += 1 << (2 * l);
    }
    this.nodeCount = off;
    this.nodeHead = new Int32Array(off).fill(-1);
    this.nodeObjects = new Int32Array(off);
    this.subtreeCount = new Int32Array(off);
    this.nodeFlags = new Uint32Array(off);
    this.nodeMinY = new Float32Array(off).fill(Infinity);
    this.nodeMaxY = new Float32Array(off).fill(-Infinity);
    this.stack = new Int32Array(maxDepth * 4 + 16);
    this.stackInside = new Uint8Array(maxDepth * 4 + 16);
    if (maxDepth > 12) throw new Error('maxDepth too large for packed traversal');
  }

  private ensureEntities(n: number): void {
    if (n <= this.entCap) return;
    let cap = Math.max(1024, this.entCap);
    while (cap < n) cap *= 2;
    const gi = (a: Int32Array, fill: number) => { const b = new Int32Array(cap).fill(fill); b.set(a); return b; };
    this.entNode = gi(this.entNode, -1);
    this.entNext = gi(this.entNext, -1);
    this.entPrev = gi(this.entPrev, -1);
    const b = new Float32Array(cap * 4); b.set(this.entBounds); this.entBounds = b;
    const f = new Uint32Array(cap); f.set(this.entFlags); this.entFlags = f;
    const lv = new Uint8Array(cap); lv.set(this.entLevel); this.entLevel = lv;
    this.entCap = cap;
  }

  // ------------------------------------------------------------------ node helpers
  nodeIndex(level: number, ix: number, iz: number): number {
    return this.levelOffset[level] + iz * (1 << level) + ix;
  }
  /** Decode node -> level, ix, iz (writes into out). */
  decode(node: number, out: Int32Array | number[]): void {
    let l = 0;
    while (l < this.maxDepth && node >= this.levelOffset[l + 1]) l++;
    const local = node - this.levelOffset[l];
    const dim = 1 << l;
    out[0] = l;
    out[1] = local % dim;
    out[2] = Math.floor(local / dim);
  }
  cellSize(level: number): number {
    return this.size / (1 << level);
  }

  private quadOf(level: number, ix: number, iz: number): number {
    if (level < QUAD_LEVEL) return -1;
    const sh = level - QUAD_LEVEL;
    return (iz >> sh) * 4 + (ix >> sh);
  }

  private bumpQuads(cx: number, cz: number, r: number, level: number, ix: number, iz: number): void {
    const q = this.quadOf(level, ix, iz);
    if (q >= 0) {
      this.quadVersion[q]++;
      return;
    }
    // large object near the root: bump every quadrant its bounds overlap
    const qs = this.size / 4;
    const x0 = Math.max(0, Math.floor((cx - r - this.minX) / qs)), x1 = Math.min(3, Math.floor((cx + r - this.minX) / qs));
    const z0 = Math.max(0, Math.floor((cz - r - this.minZ) / qs)), z1 = Math.min(3, Math.floor((cz + r - this.minZ) / qs));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.quadVersion[z * 4 + x]++;
  }

  // ------------------------------------------------------------------ mutation
  insert(e: number, cx: number, cy: number, cz: number, r: number, flags: number): void {
    this.ensureEntities(e + 1);
    if (this.entNode[e] >= 0) this.remove(e);
    // choose level: deepest with cellSize >= 2r
    let level = this.maxDepth;
    while (level > 0 && this.cellSize(level) < 2 * r) level--;
    const cs = this.cellSize(level);
    const dim = 1 << level;
    let ix = Math.floor((cx - this.minX) / cs);
    let iz = Math.floor((cz - this.minZ) / cs);
    if (ix < 0) ix = 0; else if (ix >= dim) ix = dim - 1;
    if (iz < 0) iz = 0; else if (iz >= dim) iz = dim - 1;
    const node = this.nodeIndex(level, ix, iz);
    const b = e * 4;
    this.entBounds[b] = cx; this.entBounds[b + 1] = cy; this.entBounds[b + 2] = cz; this.entBounds[b + 3] = r;
    this.entFlags[e] = flags;
    this.entLevel[e] = level;
    this.entNode[e] = node;
    this.entPrev[e] = -1;
    this.entNext[e] = this.nodeHead[node];
    if (this.nodeHead[node] >= 0) this.entPrev[this.nodeHead[node]] = e;
    this.nodeHead[node] = e;
    this.nodeObjects[node]++;
    // propagate up
    let l = level, x = ix, z = iz;
    const y0 = cy - r, y1 = cy + r;
    while (l >= 0) {
      const n = this.nodeIndex(l, x, z);
      this.subtreeCount[n]++;
      this.nodeFlags[n] |= flags;
      if (y0 < this.nodeMinY[n]) this.nodeMinY[n] = y0;
      if (y1 > this.nodeMaxY[n]) this.nodeMaxY[n] = y1;
      l--; x >>= 1; z >>= 1;
    }
    this.objectCount++;
    this.version++;
    this.bumpQuads(cx, cz, r, level, ix, iz);
  }

  remove(e: number): void {
    if (e >= this.entCap) return;
    const node = this.entNode[e];
    if (node < 0) return;
    const prev = this.entPrev[e], next = this.entNext[e];
    if (prev >= 0) this.entNext[prev] = next; else this.nodeHead[node] = next;
    if (next >= 0) this.entPrev[next] = prev;
    this.nodeObjects[node]--;
    const tmp = this.decTmp;
    this.decode(node, tmp);
    let l = tmp[0], x = tmp[1], z = tmp[2];
    while (l >= 0) {
      this.subtreeCount[this.nodeIndex(l, x, z)]--;
      l--; x >>= 1; z >>= 1;
    }
    const b = e * 4;
    this.bumpQuads(this.entBounds[b], this.entBounds[b + 2], this.entBounds[b + 3], tmp[0], tmp[1], tmp[2]);
    this.entNode[e] = -1;
    this.objectCount--;
    this.version++;
  }

  clear(): void {
    this.nodeHead.fill(-1);
    this.nodeObjects.fill(0);
    this.subtreeCount.fill(0);
    this.nodeFlags.fill(0);
    this.nodeMinY.fill(Infinity);
    this.nodeMaxY.fill(-Infinity);
    this.entNode.fill(-1);
    this.objectCount = 0;
    this.version++;
    for (let i = 0; i < QUADS; i++) this.quadVersion[i]++;
  }

  contains(e: number): boolean {
    return e < this.entCap && this.entNode[e] >= 0;
  }

  // ------------------------------------------------------------------ queries
  private nodeBox(node: number, l: number, ix: number, iz: number, out: Float64Array): void {
    const cs = this.cellSize(l);
    const cx = this.minX + (ix + 0.5) * cs;
    const cz = this.minZ + (iz + 0.5) * cs;
    out[0] = cx - cs; out[1] = this.nodeMinY[node]; out[2] = cz - cs;
    out[3] = cx + cs; out[4] = this.nodeMaxY[node]; out[5] = cz + cs;
  }
  private box = new Float64Array(6);
  private decTmp = new Int32Array(3);

  // Query parameters are stored on the instance so traversal is allocation-free.
  private qMode = 0; // 1 frustum, 2 sphere, 3 aabb
  private qVol: ConvexVolume | null = null;
  private qa = new Float64Array(6);

  private nodeTest(b: Float64Array): number {
    const q = this.qa;
    switch (this.qMode) {
      case 1: return this.qVol!.aabb(b[0], b[1], b[2], b[3], b[4], b[5]);
      case 2: {
        const cx = q[0], cy = q[1], cz = q[2], radius = q[3];
        const dx = Math.max(b[0] - cx, 0, cx - b[3]);
        const dy = Math.max(b[1] - cy, 0, cy - b[4]);
        const dz = Math.max(b[2] - cz, 0, cz - b[5]);
        return dx * dx + dy * dy + dz * dz <= radius * radius ? 1 : 0;
      }
      default: {
        if (b[3] < q[0] || b[0] > q[3] || b[4] < q[1] || b[1] > q[4] || b[5] < q[2] || b[2] > q[5]) return 0;
        if (b[0] >= q[0] && b[3] <= q[3] && b[1] >= q[1] && b[4] <= q[4] && b[2] >= q[2] && b[5] <= q[5]) return 2;
        return 1;
      }
    }
  }

  private objTest(x: number, y: number, z: number, r: number): boolean {
    const q = this.qa;
    switch (this.qMode) {
      case 1: return this.qVol!.sphere(x, y, z, r) !== 0;
      case 2: {
        const dx = x - q[0], dy = y - q[1], dz = z - q[2], rr = r + q[3];
        return dx * dx + dy * dy + dz * dz <= rr * rr;
      }
      default:
        return x + r >= q[0] && x - r <= q[3] && y + r >= q[1] && y - r <= q[4] && z + r >= q[2] && z - r <= q[5];
    }
  }

  /** Hierarchical traversal with a preallocated stack (level, ix, iz, inside packed). */
  private traverse(filter: number, out: IntList): void {
    const st = this.stats;
    st.queries++;
    let mask = 0;
    const stack = this.stack;
    const stackIn = this.stackInside;
    let sp = 0;
    stack[0] = 0; stackIn[0] = 0; sp = 1; // root: level 0, ix 0, iz 0 packed as (l<<24)|(iz<<12)|ix
    const box = this.box;
    const B = this.entBounds;
    let produced = 0;
    while (sp > 0) {
      sp--;
      const packed = stack[sp];
      let inside = stackIn[sp];
      const l = packed >>> 24, iz = (packed >>> 12) & 0xfff, ix = packed & 0xfff;
      const node = this.nodeIndex(l, ix, iz);
      if (this.subtreeCount[node] === 0 || (this.nodeFlags[node] & filter) === 0) continue;
      st.nodesVisited++;
      if (!inside) {
        this.nodeBox(node, l, ix, iz, box);
        const r = this.nodeTest(box);
        if (r === 0) continue;
        if (r === 2) inside = 1;
      }
      if (this.recordVisited) { this.recordVisited.push(node); this.recordVisited.push(this.recordTag); }
      if (l === QUAD_LEVEL) mask |= 1 << (iz * 4 + ix);
      else if (l < QUAD_LEVEL && this.nodeObjects[node] > 0) mask |= l === 0 ? 0xffff : this.quadMaskForLevel1(ix, iz);
      let e = this.nodeHead[node];
      while (e >= 0) {
        if ((this.entFlags[e] & filter) !== 0) {
          st.objectsTested++;
          const b = e * 4;
          if (inside || this.objTest(B[b], B[b + 1], B[b + 2], B[b + 3])) {
            out.push(e);
            produced++;
          }
        }
        e = this.entNext[e];
      }
      if (l < this.maxDepth) {
        const nl = l + 1, bx = ix * 2, bz = iz * 2;
        for (let k = 0; k < 4; k++) {
          stack[sp] = (nl << 24) | ((bz + (k >> 1)) << 12) | (bx + (k & 1));
          stackIn[sp] = inside;
          sp++;
        }
      }
    }
    st.results += produced;
    this.lastQuadMask = mask;
  }

  private quadMaskForLevel1(ix: number, iz: number): number {
    // a level-1 node covers 2x2 quadrants (plus loose overlap: include neighbors conservatively)
    let m = 0;
    for (let z = Math.max(0, iz * 2 - 1); z <= Math.min(3, iz * 2 + 2); z++)
      for (let x = Math.max(0, ix * 2 - 1); x <= Math.min(3, ix * 2 + 2); x++) m |= 1 << (z * 4 + x);
    return m;
  }

  queryFrustum(vol: ConvexVolume, filter: number, out: IntList): void {
    this.qMode = 1;
    this.qVol = vol;
    this.traverse(filter, out);
    this.qVol = null;
  }

  querySphere(cx: number, cy: number, cz: number, radius: number, filter: number, out: IntList): void {
    this.qMode = 2;
    const q = this.qa;
    q[0] = cx; q[1] = cy; q[2] = cz; q[3] = radius;
    this.traverse(filter, out);
  }

  queryAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, filter: number, out: IntList): void {
    this.qMode = 3;
    const q = this.qa;
    q[0] = minX; q[1] = minY; q[2] = minZ; q[3] = maxX; q[4] = maxY; q[5] = maxZ;
    this.traverse(filter, out);
  }

  /** Visit nodes (for debug visualization). Calls fn(level, ix, iz, node) for non-empty nodes. */
  forEachNode(fn: (l: number, ix: number, iz: number, node: number) => void, maxLevel = this.maxDepth): void {
    for (let l = 0; l <= Math.min(maxLevel, this.maxDepth); l++) {
      const dim = 1 << l;
      for (let iz = 0; iz < dim; iz++) for (let ix = 0; ix < dim; ix++) {
        const n = this.nodeIndex(l, ix, iz);
        if (this.subtreeCount[n] > 0) fn(l, ix, iz, n);
      }
    }
  }

  resetStats(): void {
    const s = this.stats;
    s.queries = 0; s.nodesVisited = 0; s.objectsTested = 0; s.results = 0;
  }

  /** Bytes of our own index structures (exact typed array sizes). */
  bytes(): number {
    return this.nodeHead.byteLength + this.nodeObjects.byteLength + this.subtreeCount.byteLength + this.nodeFlags.byteLength +
      this.nodeMinY.byteLength + this.nodeMaxY.byteLength + this.entNode.byteLength + this.entNext.byteLength +
      this.entPrev.byteLength + this.entBounds.byteLength + this.entFlags.byteLength + this.entLevel.byteLength;
  }

  nonEmptyNodes(): number {
    let c = 0;
    for (let i = 0; i < this.nodeCount; i++) if (this.subtreeCount[i] > 0) c++;
    return c;
  }
}
