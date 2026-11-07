# Relational World Engine

**A camera-driven, demand-evaluated 3D world architecture — playable forest-running prototype with
extensive, honest performance instrumentation.**

The world exists as **data**: entity identities, typed relationships, local positional references
in hierarchical reference frames, procedural definitions, and material / physical / acoustic /
light descriptors. There is no permanently constructed scene. The camera, shadows, lighting,
physics and audio each *ask the world their own question* and keep their own representation;
the frame is assembled from their answers. Geometry is generated only when a consumer requests it.

![Gameplay (relational mode C)](docs/screenshots/gameplay.png)
![Observer view: geometry exists only where the player camera — or a shadow into its view — requested it](docs/screenshots/observer.png)

* [What is implemented](#what-is-implemented)
* [Run it (desktop)](#run-it-desktop) · [Run it on an iPhone](#run-it-on-an-iphone)
* [Controls](#controls)
* [How the architecture works](#how-the-architecture-works) (full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md))
* [Developer visualization](#developer-visualization)
* [Diagnostics dashboard & metric provenance](#diagnostics-dashboard)
* [Benchmarks](#benchmarks) · [Measured results](#measured-results-in-this-environment)
* [Bottlenecks](#biggest-measured-bottlenecks) · [Limitations](#limitations--compromises) · [Next steps](#what-to-investigate-next)
* Browser/iOS limitations: [docs/BROWSER_LIMITATIONS.md](docs/BROWSER_LIMITATIONS.md)

---

## What is implemented

| Requirement | Where |
|---|---|
| World database (identities, relationships, local references, state, procedural defs, materials, physical/acoustic/light properties; no stored geometry) | `src/world/WorldDatabase.ts`, `src/world/types.ts`, `src/world/WorldGenerator.ts` |
| Relational spatial system: parent-relative, grounded (terrain-relative) and curve-relative (trail) frames, rotation, reference changes, relationship updates, version-cached resolution | `src/world/FrameSystem.ts`, `src/world/Curve.ts` |
| Analytic terrain *field* (no collision mesh, no stored heights) | `src/world/TerrainField.ts` |
| Spatial discovery: loose quadtree with per-node flag masks & Y-ranges, naive full scan for comparison, lazy re-indexing driven by frame changes, cached query results with quadrant-level dependency invalidation | `src/spatial/*` |
| Independent systems: visibility, shadow contribution (incl. off-screen casters), lighting (sun/sky/fog + local-light pool), collision & physics (own analytic representation), audio positioning (WebAudio, procedural sounds), geometry evaluation | `src/systems/*`, `src/geometry/*` |
| Demand-driven rendering with time-budgeted generation, LOD fallback, unresolved tracking, shadow-only layer, instance caches | `src/render/RelationalPresenter.ts`, `src/geometry/GeometryStore.ts` |
| Conventional baselines (A: scene graph, A2: static batching) from the same data and generators | `src/render/ConventionalPresenter.ts` |
| Playable third-person runner: procedural humanoid (walk/run/jump/land animation), collision, follow camera with trunk occlusion, touch joystick + look + buttons, keyboard/mouse | `src/render/Character.ts`, `src/game/*`, `src/systems/PhysicsSystem.ts` |
| Forest: winding 1.5 km loop trail, stream with wooden bridges, ~7.5 k trees (pine/oak/birch), rocks, bushes, ferns, grass, lanterns, sun & dynamic shadows, sky, fog, dust motes / fireflies, time of day | world + render |
| Developer visualization (11 toggles + observer/god view) | `src/debug/DebugViz.ts` |
| Diagnostics dashboard (live, history graphs, subsystems, memory, GPU, device, APIs, world) | `src/ui/Dashboard.ts`, `src/diagnostics/*` |
| Benchmark suite A/A2/B/C, camera sweep, static, ablation, instrumentation overhead, stress D | `src/bench/Benchmark.ts` |
| CSV / JSON / device-report export, reset, run again — all local | Export tab, `src/diagnostics/Export.ts` |
| Tests (24 unit tests) + Node data-layer benchmark | `tests/*`, `scripts/node-bench.ts` |

Stack: **TypeScript 5.9 + Vite 7 + Three.js r187 (WebGL2 backend)**; experimental optional
WebGPU backend via `three/webgpu` (`?backend=webgpu`). Three.js is used only to submit draw
batches — it does not hold the world.

---

## Run it (desktop)

```bash
npm install          # .npmrc sets legacy-peer-deps (works around an npm 10 peer-resolution bug)
npm run dev          # http://localhost:5173  (also printed: a Network URL for phones)
npm test             # unit tests (vitest)
npm run build        # type-check + production build into dist/
npm run preview      # serve dist/ on :4173 (no hot reload — use this for benchmarks)
npm run bench:node   # data-layer micro-benchmark in Node (index vs scan, cached vs uncached)
```

URL parameters: `?arch=A|A2|B|C` (initial architecture, default C), `?quality=mobile|desktop`,
`?backend=webgpu` (experimental), `?autobench=compare&frames=300` (run a suite on load).

Both dev and preview servers send COOP/COEP headers so Chromium is cross-origin isolated
(5 µs timer resolution instead of 100 µs). The app makes **no network requests** at runtime.

## Run it on an iPhone

1. Put the computer and the iPhone on the **same Wi-Fi network**.
2. On the computer: `npm install && npm run build && npm run preview`
   (or `npm run dev` for live editing). Both listen on all interfaces and print a
   `Network: http://192.168.x.y:4173/` URL. Allow incoming connections if the OS firewall asks.
3. On the iPhone open that URL in **Safari**.
4. For a full-screen experience: **Share → Add to Home Screen**, then launch it from the home
   screen icon (standalone mode; iPhone Safari has no Fullscreen API for canvas).
5. Tap **Start with sound** (iOS requires a user gesture for Web Audio) or **Start silent**.
6. For benchmarks: keep the phone plugged in, disable Low Power Mode (it caps rAF at 30 Hz),
   keep the screen awake, close other tabs, and use `npm run preview` (no hot-reload client).

Notes:
* Plain-HTTP LAN URLs are **not a secure context**: WebGPU and cross-origin isolation are
  unavailable there. Everything else works. For WebGPU on iOS, serve `dist/` over HTTPS
  (any static host you control, or a local HTTPS proxy) and append `?backend=webgpu`.
* The "mobile" quality preset is selected automatically on phones (1024² shadow map, max
  DPR 2, lighter grass, LOD scale 0.85, 3 ms geometry budget). Adjust in **Dev → Quality**.

## Controls

| Touch (iPhone) | Desktop |
|---|---|
| Left half: virtual joystick (push far = run, small = walk) | WASD / arrows (C or Alt = walk) |
| Right half: drag to look | Mouse drag to look, wheel to zoom |
| **JUMP** button | Space |
| **SPRINT** toggle | Shift |

Toolbar: **Stats** (diagnostics) · **Viz** (architecture overlay) · **God** (observer view) ·
**Dev** (overlay toggles, time of day, quality, invalidation demo) · **Mode** (architecture A/A2/B/C
or custom flags, instrumentation switches) · **Bench** (benchmarks). Tap the HUD to expand it.

---

## How the architecture works

1. **The world database is the only source of truth.** Struct-of-arrays entity table:
   kind, flags (which systems may care), parent frame, frame mode, local reference
   (8 floats), shape scale, bounds hints, references to descriptor tables, state.
   Relationships are a typed edge list (`Bridge Spans Stream`, `Lantern On Trail@s`,
   `Bird PerchedOn Tree`, …). ~13.8 k entities and ~14.3 k relationships build in ~90 ms —
   with zero geometry.
2. **Positions are relational.** A tree stores `(x, z)` in its 64 m region frame and *no
   elevation* — its height comes from the terrain field when resolved. The runner stores
   `(s, lateral, height)` along the trail while on it, switches to the bridge frame on a
   bridge, and to the region frame off-trail (each switch is a *reference change* preserving
   the world pose). World transforms are derived on request and cached by version
   (parent version, local version, terrain version).
3. **Discovery, not search.** Every system asks spatial questions through `Discovery`
   (frustum / sphere / AABB with a flag filter). The loose quadtree prunes by bounds *and* by
   flag masks; a naive full scan is available for comparison and is tested to return identical
   results. Query results are cached with dependency versions per quadrant.
4. **Independent systems** answer their own questions with their own representations:
   visibility (frustum + LOD), shadow contributors (receiver region swept toward the sun —
   finds off-screen casters), lighting (time-of-day sun/sky/fog; local lights ranked into a
   fixed pool of 4), physics (analytic cylinders/spheres/deck on the analytic terrain field),
   audio (ranked emitters into 6 WebAudio voices).
5. **Demand-driven rendering.** The presenter requests a representation per (definition, LOD)
   for each requested entity; missing ones are generated nearest-first under a per-frame time
   budget (LOD fallback meanwhile; still-missing entities are counted as *unresolved*).
   Draw batches: one instanced batch per (archetype, LOD) for the camera pass, one per
   (archetype, LOD) on a **shadow-only layer** for off-screen casters, pooled unique meshes
   for terrain/water/bridges, one grass batch from 8 m cells.

Architectures you can switch between at runtime (**Mode** tab, or `?arch=`):

| Mode | Meaning |
|---|---|
| **A** | Conventional scene graph: all geometry prebuilt; one `THREE.LOD` + meshes per entity under region groups; Three.js traversal, per-object culling, LOD, shadow pass. |
| **A2** | Conventional static batching: prebuilt `InstancedMesh` per (region, archetype, LOD) with region-level LOD — a strong conventional baseline. |
| **B** | Relational, uncached: full-chain reference resolution on every request, full scans for every query, no query cache, geometry kept only while observed. |
| **C** | Relational + cached reference resolution + spatial index + query cache + LRU geometry cache + cached instance transforms + skip-unchanged assembly. |
| custom | Any combination of the C optimizations (ablation). |

---

## Developer visualization

Open **Dev** (or tap **Viz**). Toggles (each uses its own color language):

| Toggle | What you see |
|---|---|
| World entity references | One point per entity: grey = exists only as data, green = visible, violet = shadow-only contributor, red = collider candidate, cyan = audible, yellow = active light |
| Local coordinate frames | Axis triads at region frames, trail stations, bridges, the player and its current parent frame; trail-relative station of the player |
| Parent–child relationships | Spatial parent links near the player (white), typed relations (orange) |
| Spatial index regions | Quadtree nodes visited this frame, colored by the querying system |
| Camera observation region | Player-camera frustum (white), shadow receiver region (violet) |
| Light influence regions | Influence spheres (selected vs considered), sun direction |
| Shadow contributors | Light-direction rays from off-screen casters, candidate search box |
| Collision queries | Broadphase box, candidate analytic colliders, contact normals |
| Generated / Cached / Unresolved geometry | Green = generated in the last second, blue = served from cache, grey = requested but not yet generated |

**God** switches to an observer camera above the runner while the *player camera still drives
every query*. Drag to orbit; run around and watch terrain patches, trees and shadow-only
casters appear and disappear. Shadow-only casters are rendered visibly in the observer view
(they are normally only in the shadow map), so you can see trees that exist solely because
their shadow falls into the view.

**Dependency invalidation demo:** *Nudge region ahead* moves one region frame by 2 m. Every
descendant re-resolves (trees re-ground on the terrain), is re-indexed, and only cached queries
touching that quadrant are invalidated (watch the Systems tab counters).

---

## Diagnostics dashboard

Tabs: **Live** (frame-time graph, FPS, avg/min/max/p95/p99, variance, 1% low, long and
delayed frames, JS vs GPU time, subsystem bars) · **Systems** (every subsystem timer, work
counters, cache hit rates, profiler overhead) · **Memory** · **GPU** · **Device** · **APIs** ·
**World** (entity counts, player reference frame, world rebuild with density/stress) · **Dev** ·
**Mode** · **Bench** · **Export**.

### Metric provenance (what is real, what is estimated)

| Metric | Source | Label in UI |
|---|---|---|
| Frame interval, FPS, min/max/p95/p99, variance, 1% low (≥100 samples), long frames | `requestAnimationFrame` timestamps | measured |
| Delayed frames | interval > 1.5 × refresh estimate | inferred from rAF |
| JS frame time, every subsystem time, geometry generation time | `performance.now()` around code blocks | measured (quantized by timer resolution — shown) |
| "Render submit (CPU)" | `performance.now()` around `renderer.render()` | measured — **CPU submission, not GPU execution** |
| GPU frame time | `EXT_disjoint_timer_query_webgl2` (async, attributed to the issuing frame; disjoint/implausible results discarded) | measured, or **"unavailable — reason"** |
| Draw calls, triangles, points, lines, programs, textures, geometries | Three.js renderer counters (`renderer.info`, includes the shadow pass) | renderer counters |
| WebGL draws/instances/program switches/upload bytes | optional wrapper around the GL context | exact counts (adds overhead; off by default) |
| Queries, nodes visited, objects tested, resolutions, recomputes, cache hits/misses, geometry generated/evicted, unresolved, instances written, upload bytes | engine counters | exact |
| JS heap used/total/limit | `performance.memory` (Chromium only) | browser-reported or "not exposed" |
| GC events | drops > 1 MB in `usedJSHeapSize` | inferred |
| Entity table, frame cache, index, generated geometry (CPU), instance buffers | byte length of typed arrays allocated by the engine | exact (allocated bytes) |
| GPU geometry memory, shadow map, drawing buffer | derived from uploaded sizes / dimensions | **estimate** |
| Refresh rate | median rAF interval over 90 frames | estimate |
| Profiler overhead | calibrated cost of one begin/end pair × pairs per frame | estimate; the **overhead benchmark** measures it directly |

Device/API report: UA, browser, OS, screen, viewport, DPR, hardware concurrency, device-memory
hint, touch, WebGL version/limits/extensions, unmasked GPU strings (if exposed), WebGPU adapter
info/features, timer resolution, cross-origin isolation, PerformanceObserver entry types,
Resource Timing — and an explicit list of iOS/Safari restrictions when detected.

The instrumentation can be switched off (**Mode → Per-subsystem profiler**); the whole-frame
timer (2 `performance.now()` calls) always stays on so runs remain comparable.

---

## Benchmarks

Open **Bench**, choose a suite, set frames/density (and stress steps for D), press **Run**.
**Run again** repeats the last suite; **Reset results** clears the table. Results show FPS,
1% low, frame time, JS time (with Δ vs the first row), GPU time, draws, triangles, visible /
shadow-only counts, unresolved fraction, queries & query-cache hit rate, geometry generated,
heap and estimated geometry memory. Export the full results (every per-frame sample, device
report, methodology) as JSON from **Export**.

| Suite | Content |
|---|---|
| **A / A2 / B / C comparison** | Same world, same scripted trail run, each architecture (TEST A, B, C). |
| **Camera direction sweep** | Fixed position, 360° camera orbit, results per 45° sector (A2 vs C). |
| **Static camera** | Cache effectiveness & per-frame traversal cost with no motion. |
| **Ablation** | C with each optimization removed in turn. |
| **Instrumentation overhead** | C with the profiler on vs off. |
| **D · Stress** | Progressive steps adding off-camera trees (default 0 / 15 k / 40 k), tall shadow casters and extra lights; dusk; 360° sweep per step; selectable architectures. |

Reproducibility: fixed world seed; **fixed 1/60 s simulation step per frame** (camera poses are
a function of the frame index, not wall time — identical across devices and frame rates);
scripted trail-relative camera paths; cold caches at scenario start; warm-up frames reported
separately; identical resolution, quality settings and content per scenario. If the median
frame interval equals the refresh interval the result is flagged **vsync-capped** — compare JS
and GPU time instead of FPS.

---

## Measured results (in this environment)

RESULTS_PLACEHOLDER

---

## Biggest measured bottlenecks

BOTTLENECKS_PLACEHOLDER

---

## Limitations & compromises

Summarized here; details in [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-compromises-and-limitations-honest-list).

* Three.js requires a `THREE.Scene`; the presenter uses it as a flat, per-frame-refilled
  container of draw batches (presentation state only).
* Vegetation uses 30 shared archetypes + per-entity scale/yaw/shape/tint; grass is a per-patch
  procedural field, not entities.
* Terrain carving uses curve copies made at world build; moving the forest/trail frame would
  not re-carve terrain until rebuild.
* Test B keeps geometry while observed and shares the generation time budget, so it shows
  pop-in (reported as *unresolved*) rather than unbounded frame times.
* Conventional LOD distances are measured from object origins (THREE.LOD), ours from bounds
  centers; A2's region-level LOD draws more triangles than per-entity LOD.
* GPU time is only available where a timer-query extension exists (not on iOS).
* The WebGPU backend is experimental and was **not** exercised here (no WebGPU adapter in the
  container): wind/tint shader injection is WebGL-only and shadow-only layering relies on
  WebGL shadow-map semantics.
* Headless measurements in this repository were taken with a **software GPU (SwiftShader)** on
  a shared 4-core container — they validate the pipeline and the *relative CPU-side* behaviour,
  not iPhone performance. Run the suites on the target device.

---

## What to investigate next

INVESTIGATE_PLACEHOLDER

---

## Project layout

```
src/
  world/      WorldDatabase, types, FrameSystem, Curve, TerrainField, WorldGenerator
  spatial/    SpatialIndex (loose quadtree), Discovery (index | naive), QueryCache, Frustum
  systems/    Observation, Visibility, Shadow, Lighting, Physics, Audio
  geometry/   MeshBuilder, Generators (trees, rocks, ferns, lanterns, bridges, terrain, water, grass), GeometryStore
  render/     Stage (backend), Materials, RelationalPresenter, ConventionalPresenter, Character
  engine/     Engine (frame orchestration, architectures, scripted cameras)
  game/       Input (touch + keyboard/mouse), CameraController
  debug/      DebugViz
  diagnostics/ Profiler, FrameStats, GpuTimer, GLInstrument, DeviceInfo, PerfObservers, Export
  bench/      Benchmark suites & runner
  ui/         Dashboard, Graph
tests/        frames, spatial (index ≡ naive), systems (physics, shadows, geometry, cache, stats)
scripts/      node-bench.ts
docs/         ARCHITECTURE.md, BROWSER_LIMITATIONS.md, screenshots/
```
