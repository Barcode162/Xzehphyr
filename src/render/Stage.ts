/**
 * STAGE — the rendering backend wrapper.
 *
 * Three.js is used strictly as a backend: the THREE.Scene here is a transient
 * *presentation container* that the active presenter fills each frame from
 * system results. It is never the source of truth for the world.
 */
import * as THREE from 'three';
import { LightingSystem, ActiveLight } from '../systems/LightingSystem';
import { MaterialLibrary } from './Materials';

export const LAYER_MAIN = 0;
export const LAYER_SHADOW_ONLY = 1;
export const LAYER_DEBUG = 2;

export interface StageOptions {
  canvas: HTMLCanvasElement;
  backend: 'webgl' | 'webgpu';
  antialias: boolean;
  shadowMapSize: number;
}

export class Stage {
  renderer!: THREE.WebGLRenderer;
  /** Non-null when the experimental WebGPU renderer is active. */
  webgpuRenderer: { render: (s: THREE.Scene, c: THREE.Camera) => void; info: THREE.WebGLRenderer['info'] } | null = null;
  readonly backend: 'webgl' | 'webgpu';
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.25, 1100);
  readonly observerCamera = new THREE.PerspectiveCamera(55, 1, 1, 3000);
  useObserver = false;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbcd4ff, 0x3a3020, 1);
  readonly pointLights: THREE.PointLight[] = [];
  readonly glows: THREE.Sprite[] = [];
  materials!: MaterialLibrary;
  private sky!: THREE.Mesh;
  private skyColors!: Float32Array;
  private skyDirs!: Float32Array;
  private sunDisc!: THREE.Sprite;
  private stars!: THREE.Points;
  private motes!: THREE.Points;
  private motePos!: Float32Array;
  private moteVel!: Float32Array;
  private lastSkyVersion = -1;
  shadowMapSize: number;
  pixelRatio = 1;
  renderScale = 1;
  maxDpr = 2;
  width = 1;
  height = 1;
  /** Ortho half-size of the fitted shadow camera (debug). */
  shadowHalf = 0;
  canvas: HTMLCanvasElement;
  contextLost = false;

  constructor(opts: StageOptions) {
    this.backend = opts.backend;
    this.canvas = opts.canvas;
    this.shadowMapSize = opts.shadowMapSize;
  }

  async init(opts: StageOptions): Promise<void> {
    if (opts.backend === 'webgpu') {
      // Experimental: dynamic import keeps the WebGPU build out of the default bundle.
      const mod = await import('three/webgpu');
      const r = new mod.WebGPURenderer({ canvas: opts.canvas, antialias: opts.antialias, trackTimestamp: true });
      await r.init();
      this.webgpuRenderer = r as unknown as Stage['webgpuRenderer'];
      this.renderer = r as unknown as THREE.WebGLRenderer;
    } else {
      this.renderer = new THREE.WebGLRenderer({
        canvas: opts.canvas, antialias: opts.antialias, powerPreference: 'high-performance', stencil: false,
        preserveDrawingBuffer: false,
      });
      opts.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
      opts.canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; });
    }
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = true;
    this.materials = new MaterialLibrary(this.backend === 'webgl');

    this.scene.fog = new THREE.FogExp2(0xbfd1e5, 0.004);
    this.camera.layers.set(LAYER_MAIN);
    this.observerCamera.layers.set(LAYER_MAIN);
    this.observerCamera.layers.enable(LAYER_DEBUG);
    // the observer also sees shadow-only contributors (normally they render only into the shadow map)
    this.observerCamera.layers.enable(LAYER_SHADOW_ONLY);
    this.camera.layers.enable(LAYER_DEBUG);

    // sun with camera-fitted shadow frustum
    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.04;
    s.shadow.camera.layers.set(LAYER_MAIN);
    s.shadow.camera.layers.enable(LAYER_SHADOW_ONLY);
    this.scene.add(s);
    this.scene.add(s.target);
    this.scene.add(this.hemi);

    // fixed pool of local lights (constant count => no shader recompiles)
    const glowTex = makeGlowTexture();
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(0xffaa66, 0, 14, 1.6);
      pl.castShadow = false;
      this.pointLights.push(pl);
      this.scene.add(pl);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      sp.scale.set(2.2, 2.2, 1);
      sp.visible = false;
      this.glows.push(sp);
      this.scene.add(sp);
    }
    this.buildSky(glowTex);
    this.buildAtmosphere();
  }

  private buildSky(glowTex: THREE.Texture): void {
    const geo = new THREE.SphereGeometry(900, 32, 16);
    const n = geo.attributes.position.count;
    this.skyColors = new Float32Array(n * 3);
    this.skyDirs = new Float32Array(n * 3);
    const p = geo.attributes.position.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.skyDirs[i * 3] = p[i * 3] / l; this.skyDirs[i * 3 + 1] = p[i * 3 + 1] / l; this.skyDirs[i * 3 + 2] = p[i * 3 + 2] / l;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(this.skyColors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff2d0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.sunDisc.scale.set(160, 160, 1);
    this.sunDisc.renderOrder = -9;
    this.sunDisc.frustumCulled = false;
    this.scene.add(this.sunDisc);
    // stars
    const sp = new Float32Array(900 * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 900; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      sp[i * 3] = Math.cos(a) * r * 850; sp[i * 3 + 1] = y * 850; sp[i * 3 + 2] = Math.sin(a) * r * 850;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.scene.add(this.stars);
  }

  private buildAtmosphere(): void {
    const n = 360;
    this.motePos = new Float32Array(n * 3);
    this.moteVel = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      this.motePos[i] = (Math.random() * 2 - 1) * 22;
      this.moteVel[i] = (Math.random() * 2 - 1) * 0.25;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.motes = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff0c0, size: 0.06, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.width = w; this.height = h;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.maxDpr) * this.renderScale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.observerCamera.aspect = w / h;
    this.observerCamera.updateProjectionMatrix();
  }

  get drawingBufferSize(): [number, number] {
    return [Math.round(this.width * this.pixelRatio), Math.round(this.height * this.pixelRatio)];
  }

  setShadowMapSize(size: number): void {
    if (size === this.shadowMapSize) return;
    this.shadowMapSize = size;
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget; }
  }

  /** Apply global lighting results (renderer-agnostic system output → Three objects). */
  applyLighting(L: LightingSystem, time: number): void {
    const s = this.sun;
    s.color.setRGB(L.sunColor[0], L.sunColor[1], L.sunColor[2]);
    s.intensity = L.sunIntensity;
    this.hemi.color.setRGB(L.hemiSky[0], L.hemiSky[1], L.hemiSky[2]);
    this.hemi.groundColor.setRGB(L.hemiGround[0], L.hemiGround[1], L.hemiGround[2]);
    this.hemi.intensity = L.hemiIntensity;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setRGB(L.fogColor[0], L.fogColor[1], L.fogColor[2]);
    fog.density = L.fogDensity;
    this.materials.setNight(L.night);
    if (L.sunVersion !== this.lastSkyVersion) {
      this.lastSkyVersion = L.sunVersion;
      this.updateSky(L);
    }
    const sm = this.stars.material as THREE.PointsMaterial;
    sm.opacity = L.night * 0.9;
    this.stars.visible = L.night > 0.02;
    const sd = this.sunDisc.material as THREE.SpriteMaterial;
    sd.color.setRGB(L.sunColor[0], L.sunColor[1], L.sunColor[2]);
    sd.opacity = L.isMoon ? 0.35 : 0.95;
    this.sunDisc.scale.setScalar(L.isMoon ? 60 : 170);
    // motes: dust by day, fireflies by night
    const mm = this.motes.material as THREE.PointsMaterial;
    mm.color.setRGB(L.night > 0.5 ? 0.75 : 1, L.night > 0.5 ? 1 : 0.95, L.night > 0.5 ? 0.45 : 0.8);
    mm.size = L.night > 0.5 ? 0.14 : 0.05;
    mm.opacity = L.night > 0.5 ? 0.6 + 0.4 * Math.sin(time * 3) : 0.35;
  }

  private updateSky(L: LightingSystem): void {
    const c = this.skyColors, d = this.skyDirs;
    const sx = L.sunDir[0], sy = L.sunDir[1], sz = L.sunDir[2];
    const n = c.length / 3;
    for (let i = 0; i < n; i++) {
      const y = d[i * 3 + 1];
      const t = Math.pow(Math.max(0, y), 0.55);
      let r = L.skyHorizon[0] + (L.skyZenith[0] - L.skyHorizon[0]) * t;
      let g = L.skyHorizon[1] + (L.skyZenith[1] - L.skyHorizon[1]) * t;
      let b = L.skyHorizon[2] + (L.skyZenith[2] - L.skyHorizon[2]) * t;
      if (y < 0) { const k = Math.min(1, -y * 3); r *= 1 - 0.3 * k; g *= 1 - 0.3 * k; b *= 1 - 0.25 * k; }
      if (!L.isMoon) {
        const dot = Math.max(0, d[i * 3] * sx + d[i * 3 + 1] * sy + d[i * 3 + 2] * sz);
        const glow = Math.pow(dot, 8) * 0.55 + Math.pow(dot, 64) * 0.6;
        r += glow * L.sunColor[0]; g += glow * L.sunColor[1] * 0.85; b += glow * L.sunColor[2] * 0.6;
      }
      c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    }
    (this.sky.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Assign the selected local lights to the fixed pool. */
  applyLocalLights(active: ActiveLight[]): void {
    for (let i = 0; i < this.pointLights.length; i++) {
      const pl = this.pointLights[i];
      const g = this.glows[i];
      const a = active[i];
      if (a) {
        pl.position.set(a.x, a.y, a.z);
        pl.color.setRGB(a.r, a.g, a.b);
        pl.intensity = a.intensity;
        pl.distance = a.range;
        g.visible = true;
        g.position.set(a.x, a.y, a.z);
        (g.material as THREE.SpriteMaterial).color.setRGB(a.r, a.g * 0.9, a.b * 0.7);
      } else {
        pl.intensity = 0;
        g.visible = false;
      }
    }
  }

  /**
   * Fit the directional shadow camera around the receiver region (truncated view
   * frustum corners), extended towards the sun so off-screen casters are inside.
   * Uses a constant-size bounding square snapped to shadow texels to avoid shimmer.
   */
  fitShadow(corners: Float64Array, sunDir: Float64Array, extendTowardSun: number): void {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < 8; i++) { cx += corners[i * 3]; cy += corners[i * 3 + 1]; cz += corners[i * 3 + 2]; }
    cx /= 8; cy /= 8; cz /= 8;
    let r = 0;
    for (let i = 0; i < 8; i++) r = Math.max(r, Math.hypot(corners[i * 3] - cx, corners[i * 3 + 1] - cy, corners[i * 3 + 2] - cz));
    r = Math.ceil(r / 4) * 4;
    this.shadowHalf = r;
    const s = this.sun;
    const dist = r + extendTowardSun + 20;
    // snap the center to the shadow texel grid in light space
    const texel = (2 * r) / this.shadowMapSize;
    const lightDir = _v1.set(sunDir[0], sunDir[1], sunDir[2]).normalize();
    const up = Math.abs(lightDir.y) > 0.99 ? _v2.set(0, 0, 1) : _v2.set(0, 1, 0);
    const right = _v3.crossVectors(up, lightDir).normalize();
    const lup = _v4.crossVectors(lightDir, right).normalize();
    const pr = right.x * cx + right.y * cy + right.z * cz;
    const pu = lup.x * cx + lup.y * cy + lup.z * cz;
    const dr = Math.round(pr / texel) * texel - pr;
    const du = Math.round(pu / texel) * texel - pu;
    cx += right.x * dr + lup.x * du; cy += right.y * dr + lup.y * du; cz += right.z * dr + lup.z * du;
    s.target.position.set(cx, cy, cz);
    s.position.set(cx + lightDir.x * dist, cy + lightDir.y * dist, cz + lightDir.z * dist);
    s.target.updateMatrixWorld();
    s.updateMatrixWorld();
    const cam = s.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1;
    cam.far = dist + r + 30;
    cam.updateProjectionMatrix();
  }

  updateAtmosphere(dt: number, camX: number, camY: number, camZ: number): void {
    const p = this.motePos, v = this.moteVel;
    const n = p.length / 3;
    const R = 22;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      p[o] += v[o] * dt; p[o + 1] += v[o + 1] * dt * 0.5; p[o + 2] += v[o + 2] * dt;
      // wrap around the camera
      if (p[o] - camX > R) p[o] -= 2 * R; else if (p[o] - camX < -R) p[o] += 2 * R;
      if (p[o + 1] - camY > R * 0.5) p[o + 1] -= R; else if (p[o + 1] - camY < -R * 0.5) p[o + 1] += R;
      if (p[o + 2] - camZ > R) p[o + 2] -= 2 * R; else if (p[o + 2] - camZ < -R) p[o + 2] += 2 * R;
    }
    (this.motes.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Keep sky elements centered on the active camera. */
  followCamera(cam: THREE.Camera, sunDir: Float64Array): void {
    this.sky.position.copy(cam.position);
    this.stars.position.copy(cam.position);
    this.sunDisc.position.set(cam.position.x + sunDir[0] * 800, cam.position.y + sunDir[1] * 800, cam.position.z + sunDir[2] * 800);
  }

  render(): void {
    const cam = this.useObserver ? this.observerCamera : this.camera;
    this.followCamera(cam, _sunTmp);
    this.renderer.render(this.scene, cam);
  }

  setSunForSky(sunDir: Float64Array): void {
    _sunTmp[0] = sunDir[0]; _sunTmp[1] = sunDir[1]; _sunTmp[2] = sunDir[2];
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _sunTmp = new Float64Array([0, 1, 0]);

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
