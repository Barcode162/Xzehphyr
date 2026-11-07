/**
 * Core world vocabulary. These types describe *information* about the world.
 * None of them reference a renderer, a mesh, or a scene graph node.
 */

export enum Kind {
  Root = 0,
  Forest,
  Region,
  Trail,
  Stream,
  Bridge,
  Tree,
  Rock,
  Bush,
  Fern,
  Lantern,
  AudioEmitter,
  Bird,
  Player,
  TerrainPatch,
  WaterPatch,
  StressObject,
}

export const KIND_NAMES: string[] = [
  'Root', 'Forest', 'Region', 'Trail', 'Stream', 'Bridge', 'Tree', 'Rock', 'Bush', 'Fern',
  'Lantern', 'AudioEmitter', 'Bird', 'Player', 'TerrainPatch', 'WaterPatch', 'StressObject',
];

/** How an entity's local reference is interpreted relative to its parent frame. */
export enum FrameMode {
  /** Plain parent-relative position + orientation + uniform scale. */
  Local = 0,
  /** Local (x,z) relative to parent; world y = terrain height at that point + local y. */
  Grounded = 1,
  /** Parent is a curve (trail/stream). local x = arc length s, z = lateral offset, y = height above the curve profile. */
  Curve = 2,
}

/** Bit flags: which systems may be interested in an entity. Also aggregated per spatial-index node. */
export const Flag = {
  Visual: 1 << 0,
  Collider: 1 << 1,
  CastsShadow: 1 << 2,
  EmitsLight: 1 << 3,
  EmitsSound: 1 << 4,
  Dynamic: 1 << 5,
  Frame: 1 << 6,
  Terrain: 1 << 7,
  ReceivesShadow: 1 << 8,
  Water: 1 << 9,
} as const;

/** Geometry families understood by the geometry evaluator. */
export enum Family {
  None = 0,
  Pine,
  Oak,
  Birch,
  Rock,
  Bush,
  Fern,
  Lantern,
  Bridge,
  TerrainPatch,
  WaterPatch,
  StressPillar,
}

export const FAMILY_NAMES = ['None', 'Pine', 'Oak', 'Birch', 'Rock', 'Bush', 'Fern', 'Lantern', 'Bridge', 'Terrain', 'Water', 'StressPillar'];

/**
 * Procedural definition. A compact recipe from which any consumer can derive a
 * representation (visual mesh, collider proxy, acoustic proxy). Shared defs are
 * archetypes referenced by many entities; unique defs belong to one entity.
 */
export interface ProceduralDef {
  id: number;
  family: Family;
  variant: number;
  seed: number;
  /** Number of visual LOD levels the evaluator can produce. */
  lodCount: number;
  /** Squared camera distances at which LOD switches (length lodCount-1). */
  lodDist2: number[];
  /** Beyond this distance the visual representation is not requested at all. */
  maxDrawDist: number;
  /** Family-specific numeric parameters (e.g. bridge length, region bounds). */
  params: number[];
  /** True when many entities share this def (instancing candidate). */
  shared: boolean;
  /** Material descriptor id. */
  material: number;
}

export type SurfaceType = 'dirt' | 'grass' | 'wood' | 'rock' | 'water' | 'litter';

export interface MaterialDesc {
  id: number;
  name: string;
  /** Renderer-agnostic hints. */
  kind: 'foliage' | 'bark' | 'rock' | 'terrain' | 'wood' | 'water' | 'lamp' | 'generic';
  roughness: number;
  metalness: number;
  /** Wind sway amplitude hint (0 = rigid). */
  wind: number;
  emissive: number;
}

export enum ColliderShape {
  None = 0,
  /** Vertical cylinder: dims = [radius, height]. */
  Cylinder = 1,
  /** Sphere: dims = [radius, centerY]. */
  Sphere = 2,
  /** Oriented box in entity frame: dims = [halfX, halfY, halfZ, centerY]. */
  Box = 3,
  /** Bridge: deck walkable box + side rails (dims = [halfLength, halfWidth, deckThickness, railHeight]). */
  BridgeDeck = 4,
}

export interface PhysicalDesc {
  id: number;
  shape: ColliderShape;
  dims: number[];
  surface: SurfaceType;
  friction: number;
}

export interface AcousticDesc {
  id: number;
  sound: 'stream' | 'bird' | 'wind' | 'lantern-hum';
  gain: number;
  /** Audible radius in meters. */
  radius: number;
}

export interface LightDesc {
  id: number;
  color: [number, number, number];
  intensity: number;
  /** Influence radius (meters). */
  range: number;
  /** Only active when the sun is low. */
  nightOnly: boolean;
}

export enum Rel {
  /** Logical containment (tree is part of forest). Spatial parent is stored separately for speed. */
  PartOf = 0,
  /** Entity stands on / is positioned along another (lantern on trail). */
  On = 1,
  /** Bridge spans a stream. */
  Spans = 2,
  /** Light illuminates an entity/region. */
  Illuminates = 3,
  /** Audio source is attached to / emitted by another entity (bird perched on tree). */
  PerchedOn = 4,
  /** Entity's sound is produced by another entity (stream emitter of stream). */
  EmittedBy = 5,
}

export const REL_NAMES = ['PartOf', 'On', 'Spans', 'Illuminates', 'PerchedOn', 'EmittedBy'];
