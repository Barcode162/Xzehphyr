/**
 * Presentation materials. Maps renderer-agnostic material descriptors to
 * Three.js materials. Wind sway and per-instance tint are injected into the
 * WebGL shaders; on the experimental WebGPU backend they are skipped
 * (onBeforeCompile is a WebGL-only hook) and vegetation is static.
 */
import * as THREE from 'three';

export const sharedUniforms = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uGrassFar: { value: 34 },
};

type Kind = 'vegetation' | 'rigid' | 'terrain' | 'water' | 'grass' | 'lamp' | 'character';

function injectWind(mat: THREE.Material, mode: 'tree' | 'grass' | 'tint'): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWind = sharedUniforms.uWind;
    shader.uniforms.uGrassFar = sharedUniforms.uGrassFar;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWind;
uniform float uGrassFar;
vec3 rweInstPos() {
#ifdef USE_INSTANCING
  return vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
  return vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
#endif
}`)
      .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR_ALPHA
  { vec3 ip = rweInstPos(); float hsh = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
    vColor.rgb *= ${mode === 'grass' ? '0.86 + 0.28 * hsh' : '0.88 + 0.24 * hsh'}; }
#endif`)
      .replace('#include <begin_vertex>', mode === 'tint' ? '#include <begin_vertex>' : `#include <begin_vertex>
  {
    vec3 ip = rweInstPos();
    float ph = dot(ip.xz, vec2(0.13, 0.17));
${mode === 'tree' ? `    float h = max(0.0, position.y - 1.5);
    float sway = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.7 + ph * 1.7) * 0.25;
    transformed.x += sway * h * h * 0.0014 * uWind;
    transformed.z += cos(uTime * 1.1 + ph) * h * h * 0.001 * uWind;` : `    float h = position.y;
    float sway = sin(uTime * 2.1 + ph * 3.0) * 0.7 + sin(uTime * 3.7 + ph * 5.0) * 0.3;
    transformed.x += sway * h * 0.35 * uWind;
    transformed.z += cos(uTime * 1.7 + ph * 4.0) * h * 0.25 * uWind;
    float camD = distance(ip, cameraPosition);
    transformed *= smoothstep(uGrassFar, uGrassFar - 7.0, camD);`}
  }`);
  };
  mat.customProgramCacheKey = () => `rwe-${mode}`;
}

export class MaterialLibrary {
  readonly webgl: boolean;
  readonly mats = new Map<Kind, THREE.Material>();
  lamp: THREE.MeshLambertMaterial;
  lampPost: THREE.MeshLambertMaterial;
  water: THREE.MeshStandardMaterial;

  constructor(webgl: boolean) {
    this.webgl = webgl;
    const veg = new THREE.MeshLambertMaterial({ vertexColors: true });
    const rigid = new THREE.MeshLambertMaterial({ vertexColors: true });
    const terrain = new THREE.MeshLambertMaterial({ vertexColors: true });
    const grass = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const character = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.water = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.84 });
    this.lampPost = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.lamp = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(1.0, 0.7, 0.35), emissiveIntensity: 0 });
    if (webgl) {
      injectWind(veg, 'tree');
      injectWind(grass, 'grass');
      injectWind(rigid, 'tint');
    }
    this.mats.set('vegetation', veg);
    this.mats.set('rigid', rigid);
    this.mats.set('terrain', terrain);
    this.mats.set('grass', grass);
    this.mats.set('water', this.water);
    this.mats.set('character', character);
  }

  get(kind: Kind): THREE.Material {
    return this.mats.get(kind)!;
  }

  /** Lanterns use a two-group geometry: [post, glowing lamp]. */
  lanternMaterials(): THREE.Material[] {
    return [this.lampPost, this.lamp];
  }

  setNight(night: number): void {
    this.lamp.emissiveIntensity = night * 2.2;
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
    this.lamp.dispose();
    this.lampPost.dispose();
  }
}

/** Convert renderer-agnostic GeometryData into a GPU-ready BufferGeometry. */
export function toBufferGeometry(g: {
  positions: Float32Array; normals: Float32Array; colors: Uint8Array; index: Uint16Array | Uint32Array;
  groups: { start: number; count: number; materialIndex: number }[] | null;
}): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 4, true));
  geo.setIndex(new THREE.BufferAttribute(g.index, 1));
  if (g.groups) for (const gr of g.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
  geo.computeBoundingSphere();
  return geo;
}
