# Architecture

> The world is not a picture waiting to be drawn. It is information that different
> observers and systems can interpret.

This document explains how the Relational World Engine (RWE) represents the world,
how each evaluation system queries it, and where the prototype compromises.

---

## 1. Layers

```
                ┌──────────────────────────── WORLD DATABASE (source of truth) ────────────────────────────┐
                │ entity table (SoA typed arrays): kind · flags · parent frame · frame mode · local ref ·  │
                │ shape scale · bounds hints · descriptor refs · state                                       │
                │ descriptor tables: procedural defs · materials · physical · acoustic · light                │
                │ typed relationships (edge list): PartOf · On · Spans · Illuminates · PerchedOn · EmittedBy │
                │ procedural fields: terrain (analytic height/normal/surface), curves (trail, stream)         │
                └───────────────┬───────────────────────────────┬───────────────────────────────┬────────────┘
                                │ derived, cached               │ derived, cached               │ derived, on demand
                    ┌───────────▼──────────┐        ┌───────────▼──────────┐        ┌───────────▼──────────┐
                    │ FRAME SYSTEM          │        │ SPATIAL DISCOVERY     │        │ GEOMETRY EVALUATOR    │
                    │ resolve local → world │        │ loose quadtree +      │        │ procedural def × LOD  │
                    │ version-checked cache │        │ per-node flag masks,  │        │ → typed arrays;       │
                    │ (or full recompute)   │        │ query cache w/ quad   │        │ time-budgeted queue;  │
                    └───────────┬──────────┘        │ dependency versions   │        │ LRU or keep-while-    │
                                │                    └───────────┬──────────┘        │ observed retention    │
                                │                                │                    └───────────┬──────────┘
      ┌─────────────────────────┼────────────────────────────────┼─────────────────────────────────┼──────────┐
      │ INDEPENDENT EVALUATION SYSTEMS (each asks its own question, keeps its own representation)            │
      │  Visibility  — "what is inside the observation frustum, at which LOD?"                                │
      │  Shadow      — "what casts a shadow into the receiver region?" (incl. off-screen casters)             │
      │  Lighting    — "which emitters influence what I can see?" + sun/sky/fog from time of day              │
      │  Physics     — "which colliders are near the runner?" analytic cylinders/spheres/deck + terrain field │
      │  Audio       — "which emitters can the listener hear?" ranked into a fixed voice pool                 │
      └──────────────────────────────────────────────┬────────────────────────────────────────────────────────┘
                                                     │ results (entity lists + parameters)
                                         ┌───────────▼──────────┐
                                         │ PRESENTATION          │  Three.js used as a *backend only*:
                                         │ RelationalPresenter   │  flat draw batches rebuilt from results
                                         │ (or Conventional, A)  │  every frame; the THREE.Scene is not the
                                         └──────────────────────┘  source of truth.
```

Source files:

| Concern | File |
|---|---|
| Entity table, descriptors, relationships | `src/world/WorldDatabase.ts`, `src/world/types.ts` |
| Reference frames & resolution cache | `src/world/FrameSystem.ts` |
| Curve frames (trail / stream) | `src/world/Curve.ts` |
| Analytic terrain field | `src/world/TerrainField.ts` |
| Procedural world authoring (data only) | `src/world/WorldGenerator.ts` |
| Loose quadtree | `src/spatial/SpatialIndex.ts` |
| Index / naive scan facade, dependency sync | `src/spatial/Discovery.ts` |
| Query result cache | `src/spatial/QueryCache.ts` |
| Renderer-agnostic frustum / convex volume | `src/spatial/Frustum.ts` |
| Systems | `src/systems/*.ts` |
| Geometry generators & store | `src/geometry/*.ts` |
| Relational presentation (B/C) | `src/render/RelationalPresenter.ts` |
| Conventional baseline (A/A2) | `src/render/ConventionalPresenter.ts` |
| Frame orchestration | `src/engine/Engine.ts` |

---

## 2. World database

* **Identity** is an integer row. Hot data lives in typed arrays (`Uint8Array kind`,
  `Uint32Array flags`, `Int32Array parent`, `Float64Array local` with 8 floats per entity, …).
* **No world matrices are stored.** An entity stores a *local reference* in its parent frame
  and a *frame mode* that says how to interpret it:
  * `Local` — position + quaternion + uniform scale relative to the parent.
  * `Grounded` — `(x, z)` relative to the parent; world `y` = terrain field height + local `y`.
    Trees, rocks, ferns never store an elevation.
  * `Curve` — the parent is a curve; local `x` = arc length `s`, `z` = lateral offset,
    `y` = height above the curve profile. The player, lanterns, bridges and stream sound
    emitters are positioned this way.
* **Procedural definitions** (`ProceduralDef`) are compact recipes (family, variant, seed,
  LOD distances, parameters). 30 shared archetypes describe ~13 000 vegetation/rock entities;
  terrain patches, water patches and bridges have unique definitions.
* **Physical / acoustic / light descriptors** are separate tables — physics never sees a mesh,
  audio never sees a material.
* **Relationships** are a typed edge list with per-entity adjacency (O(degree) lookups):
  `Bridge Spans Stream`, `Lantern On Trail (param = s)`, `Bird PerchedOn Tree`,
  `StreamEmitter EmittedBy Stream`, `Patch PartOf Region`, …
* An entity with a procedural definition has **no geometry** until a consumer requests one.

Default world: 768 m × 768 m, 144 region frames (64 m), ~13.8 k entities, ~14.3 k relationships,
built in ~90 ms (data only).

### Hierarchy used by the demo

```
World ─ Forest ─┬─ Region[ix,iz] (144 local frames) ─┬─ TerrainPatch (unique def, 3 LODs)
                │                                     ├─ WaterPatch (if the stream passes)
                │                                     ├─ Tree / Rock / Bush / Fern   (Grounded)
                │                                     │      └─ Bird (Local, perched relative to its tree)
                ├─ Trail (curve frame) ───────────────┬─ Lantern (Curve: s, lateral)
                │                                     ├─ Bridge  (Curve: s at the stream crossing)
                │                                     └─ Player  (Curve while on the trail)
                └─ Stream (curve frame) ───────────── AudioEmitter (Curve: s)
```

The player changes reference frame as it moves (**reference change**): on a bridge it is
`Local` in the bridge frame; within the trail corridor it is `Curve` on the trail
(`s`, lateral, height); elsewhere it is `Grounded` in the region frame under it. The
transition re-expresses the world pose in the new frame exactly (`FrameSystem.reexpress`).
The Dev → World tab shows the player's current frame and local coordinates.

---

## 3. Reference resolution & caching

`FrameSystem.resolve(e)` returns the world transform (position, quaternion, uniform scale).

* **Cached mode (Test C):** each resolved transform stores
  `(parentWorldVersion, localVersion, terrainVersion)`. A request walks up the chain checking
  versions; nothing is recomputed while they match. A global *mutation stamp* memoizes
  repeated requests until something in the world moves (then only O(depth) version checks).
* **Uncached mode (Test B):** every request recomputes every ancestor, including analytic
  terrain height evaluation for grounded entities.
* Moving a frame (e.g. Dev → "Nudge region") bumps its local version → every descendant
  recomputes on its next request, and `Discovery` re-indexes the descendants
  (*dependency-driven invalidation*).

Unit tests (`tests/frames.test.ts`) assert composition, cache-hit behaviour, invalidation
counts, cached ≡ uncached results, and round-trip accuracy of curve-relative positions.

---

## 4. Spatial discovery

`SpatialIndex` is a loose quadtree (depth 6 over 832 m → 13 m leaves, loose factor 2) in
flat typed arrays with intrusive per-node linked lists (O(1) insert/remove, allocation-free
traversal with a preallocated stack). Per node it aggregates:

* subtree object count (skip empty branches),
* **OR of entity flags** — a lighting query never descends into branches without emitters,
  physics skips branches without colliders,
* subtree vertical range (tight boxes for frustum/shadow tests),
* a "fully inside" shortcut that accepts whole subtrees without per-object tests.

Dynamic entities (the player) are not indexed; static entities are indexed once with their
resolved bounds and re-indexed only when an ancestor frame changes.

`Discovery` exposes `frustum / sphere / aabb` queries with two interchangeable strategies:
the index, or a **naive full scan** (resolution pass over all entities, then a test pass).
`tests/spatial.test.ts` asserts that both return *identical* result sets over randomized
frusta, spheres and boxes for every flag filter.

### Query cache

`QueryCache` stores result lists keyed by quantized query parameters. Each entry records the
version of every depth-2 quadrant it touched plus an extra dependency (e.g. sun direction).
An entry is reused only while all dependencies are unchanged:

| Consumer | Key | Typical hit rate |
|---|---|---|
| Visibility | exact (quantized) frustum planes | hits only when the camera is still |
| Shadow | frustum + sun version | idem |
| Lighting | 8 m camera cell (conservative radius) | high while moving |
| Physics broadphase | 4 m character cell (box expanded by margin) | high while moving |
| Audio | 4 m listener cell | high |

---

## 5. Independent evaluation systems

All systems take a renderer-agnostic `Observation` (position, basis, fov, near/far → 6
planes) or their own query region. None of them touches Three.js.

* **Visibility** — frustum query (Visual flag), distance culling against each definition's
  max draw distance, LOD selection by squared distance (terrain uses distance to the patch
  square).
* **Shadow contributors** — receiver region = view frustum truncated at the shadow distance;
  candidate region = its XZ bounds extended toward the sun by `maxCasterHeight / tan(elevation)`;
  each candidate's bounding sphere is swept along the light direction as a capsule and tested
  against the receiver region. Visible casters are already drawn; the rest become
  **shadow-only contributors**, rendered on a layer only the shadow camera sees.
  `tests/systems.test.ts` checks that an off-screen tree toward the sun is found and one
  away from the sun is not.
* **Lighting** — time of day → sun/moon direction, colors, sky gradient, hemisphere ambient,
  fog. Local lights (lanterns, wisps) are discovered with a sphere query, refined by testing
  their influence sphere against the frustum, ranked by estimated contribution and mapped to a
  **fixed pool of 4 point lights** (constant shader permutations).
* **Physics** — character controller on the analytic terrain field; colliders are analytic
  shapes from physical descriptors (vertical cylinders, spheres, bridge deck + rails).
  Broadphase through spatial discovery (Collider flag) with a cell-keyed query cache.
  Camera occlusion uses the same representation (segment vs trunk cylinders).
* **Audio** — sphere query (EmitsSound), loudness ranking, fixed pool of 6 spatialized
  WebAudio voices with procedural synthesis (stream noise, bird chirps, footsteps by surface).

---

## 6. Demand-driven rendering

Per frame (`Engine.evaluateRelational`):

1. `Discovery.sync()` — apply dependency invalidations.
2. Visibility → Lighting → Shadow contributors.
3. `RelationalPresenter.assemble()` — for every requested entity, request its representation
   from the `GeometryStore` (`def × LOD`). Missing representations are queued; the presenter
   falls back to any other available LOD, otherwise counts the entity as **unresolved**.
   Instance matrices are written into one `InstancedMesh` per `(archetype, LOD)` for the camera
   pass and one per `(archetype, LOD)` on the shadow-only layer. Unique entities (terrain,
   water, bridges) use pooled meshes. Grass is a single batch filled from 8 m cells of the
   nearby terrain patches.
4. `GeometryStore.process(budget)` — generate queued representations nearest-first within a
   per-frame time budget (3–4 ms default).
5. `GeometryStore.endFrame()` — Test C: LRU eviction above a byte budget. Test B:
   dispose everything not requested this frame.

Test C additionally caches **instance-ready matrices per entity** (validated by the entity's
resolved-transform version) and **skips assembly entirely** when the observation is
unchanged, both query results came from the cache, and no geometry changed.

### Conventional baseline (A / A2)

`ConventionalPresenter` builds a permanent Three.js scene from the *same* world data and the
*same* generators: every archetype LOD, every terrain patch LOD and all grass are generated
up front. A uses one `THREE.LOD` (+ a mesh per level) per entity under region groups; A2 uses
prebuilt static `InstancedMesh` batches per (region, archetype, LOD) with region-level LOD
switching. Three.js performs scene traversal, per-object frustum culling, LOD selection and
the shadow pass over all casters. Lighting (sun, sky, local light pool), shadow-camera fitting,
physics and audio are shared with the relational path, so the comparison isolates the
*scene representation & rendering path*.

---

## 7. Compromises and limitations (honest list)

1. **Three.js needs a `THREE.Scene`.** The presenter keeps a flat container of draw batches
   that it refills from system results every frame. It is presentation state, not the world.
2. **Archetype instancing.** Vegetation uses 30 shared archetypes; per-entity variation is
   scale, yaw, shape scale and a hash-based tint. Fully unique procedural geometry per entity
   would multiply generation and memory costs.
3. **Grass is a per-patch procedural field**, not entities. Grass blocks assume translation-only
   region frames (true in this world).
4. **Terrain carving uses world-space copies of the curves** computed at build time. Moving
   the forest/trail frame does not re-carve the terrain (it would require bumping the terrain
   version, which the cache already supports, but carving is rebuilt only on world rebuild).
5. **The index stores bounds captured at index time.** Correctness relies on dependency
   invalidation (`Discovery.sync`) after frame changes. Removal does not shrink node
   Y-ranges (conservative, still correct).
6. **The shadow capsule test is conservative** (per-plane rejection), so a few casters whose
   shadows narrowly miss the view are still included.
7. **Grounded resolution assumes yaw-only parent frames** (gravity is world-down).
8. **Curve projection** at polyline vertices can lose up to ~2 cm of tangential offset on the
   convex side (tested bound); positions are otherwise exact.
9. **Conventional LOD distances differ slightly**: THREE.LOD measures to the object origin
   (tree base / region center), ours to the bounding-sphere center / patch square. A2's
   region-level LOD renders more triangles than per-entity LOD at the same thresholds.
10. **Test B's geometry policy** is "keep while observed" (not "regenerate every frame"), and
    it shares the generation time budget, so B shows *pop-in* (unresolved entities) instead of
    unbounded frame times. The benchmark reports the unresolved fraction so this is visible.
11. **WebGPU backend is experimental**: wind/tint shader injection is WebGL-only, the
    shadow-only layer mechanism relies on Three.js WebGL shadow-map layer semantics, and the
    backend could not be exercised in the development container (no WebGPU adapter).
