/**
 * Procedural humanoid runner. A visual *presentation* of the player entity:
 * its pose is derived from the physics body state each frame.
 */
import * as THREE from 'three';
import { CharacterBody } from '../systems/PhysicsSystem';
import { clamp, damp, lerp } from '../util/math';

interface Limb { upper: THREE.Group; lower: THREE.Group; }

export class Character {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Group();
  private spine = new THREE.Group();
  private head = new THREE.Group();
  private armL: Limb;
  private armR: Limb;
  private legL: Limb;
  private legR: Limb;
  private phase = 0;
  private runBlend = 0;
  private moveBlend = 0;
  private airBlend = 0;
  private lean = 0;
  private lastYaw = 0;
  private landKick = 0;
  /** Footstep callback (phase crossings). */
  onFootstep: ((intensity: number) => void) | null = null;
  private lastStepPhase = 0;

  constructor() {
    const jacket = new THREE.MeshLambertMaterial({ color: 0xe8552a });
    const pants = new THREE.MeshLambertMaterial({ color: 0x23324a });
    const skin = new THREE.MeshLambertMaterial({ color: 0xd9a27c });
    const shoe = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const hair = new THREE.MeshLambertMaterial({ color: 0x2a1c14 });
    const pack = new THREE.MeshLambertMaterial({ color: 0x2f6f4f });
    const cap = (r: number, l: number, m: THREE.Material, y: number) => {
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 3, 8), m);
      mesh.position.y = y;
      mesh.castShadow = true;
      return mesh;
    };
    this.root.add(this.pelvis);
    this.pelvis.position.y = 0.98;
    const hips = cap(0.16, 0.12, pants, 0);
    hips.rotation.z = Math.PI / 2;
    this.pelvis.add(hips);
    this.pelvis.add(this.spine);
    this.spine.position.y = 0.06;
    this.spine.add(cap(0.17, 0.32, jacket, 0.27));
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.12), pack);
    backpack.position.set(0, 0.32, -0.18);
    backpack.castShadow = true;
    this.spine.add(backpack);
    this.spine.add(this.head);
    this.head.position.y = 0.62;
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), skin);
    headMesh.position.y = 0.1;
    headMesh.castShadow = true;
    this.head.add(headMesh);
    const hairMesh = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    hairMesh.position.y = 0.11;
    hairMesh.rotation.x = -0.25;
    this.head.add(hairMesh);
    const limb = (parent: THREE.Object3D, x: number, y: number, r: number, l1: number, l2: number, m1: THREE.Material, m2: THREE.Material, foot?: THREE.Material): Limb => {
      const upper = new THREE.Group();
      upper.position.set(x, y, 0);
      parent.add(upper);
      upper.add(cap(r, l1, m1, -l1 / 2 - r * 0.5));
      const lower = new THREE.Group();
      lower.position.y = -l1 - r * 0.6;
      upper.add(lower);
      lower.add(cap(r * 0.85, l2, m2, -l2 / 2 - r * 0.4));
      if (foot) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, r * 0.9, r * 3.2), foot);
        f.position.set(0, -l2 - r * 1.1, r * 0.8);
        f.castShadow = true;
        lower.add(f);
      }
      return { upper, lower };
    };
    this.armL = limb(this.spine, 0.23, 0.5, 0.058, 0.24, 0.22, jacket, skin);
    this.armR = limb(this.spine, -0.23, 0.5, 0.058, 0.24, 0.22, jacket, skin);
    this.legL = limb(this.pelvis, 0.1, -0.04, 0.075, 0.36, 0.36, pants, pants, shoe);
    this.legR = limb(this.pelvis, -0.1, -0.04, 0.075, 0.36, 0.36, pants, pants, shoe);
  }

  /** Pose from physics body state. */
  update(body: CharacterBody, dt: number, time: number): void {
    if (!(dt > 0)) { this.root.position.set(body.x, body.y, body.z); return; }
    const speed = Number.isFinite(body.speed) ? body.speed : 0;
    this.moveBlend = damp(this.moveBlend, clamp(speed / 2.5, 0, 1), 10, dt);
    this.runBlend = damp(this.runBlend, clamp((speed - 3) / 3.5, 0, 1), 6, dt);
    this.airBlend = damp(this.airBlend, body.grounded ? 0 : 1, body.grounded ? 14 : 8, dt);
    const strideLen = lerp(1.25, 2.6, this.runBlend);
    if (body.grounded) this.phase = (body.stride / strideLen) * Math.PI * 2;
    // footsteps at each half cycle
    const stepIdx = Math.floor(this.phase / Math.PI);
    if (body.grounded && stepIdx !== this.lastStepPhase && speed > 0.5) {
      this.onFootstep?.(clamp(speed / 7, 0.3, 1));
    }
    this.lastStepPhase = stepIdx;
    const p = this.phase;
    const s = Math.sin(p), c = Math.cos(p);
    const mv = this.moveBlend * (1 - this.airBlend);
    const run = this.runBlend;
    const legAmp = lerp(0.45, 0.95, run) * mv;
    const kneeAmp = lerp(0.5, 1.5, run) * mv;
    const armAmp = lerp(0.35, 1.0, run) * mv;
    // legs
    this.legL.upper.rotation.x = -s * legAmp;
    this.legR.upper.rotation.x = s * legAmp;
    this.legL.lower.rotation.x = Math.max(0, -c) * kneeAmp + 0.1 * mv;
    this.legR.lower.rotation.x = Math.max(0, c) * kneeAmp + 0.1 * mv;
    // arms counter-swing, elbows bent while running
    this.armL.upper.rotation.x = s * armAmp;
    this.armR.upper.rotation.x = -s * armAmp;
    this.armL.lower.rotation.x = -lerp(0.25, 1.3, run) * Math.max(mv, 0.25);
    this.armR.lower.rotation.x = -lerp(0.25, 1.3, run) * Math.max(mv, 0.25);
    this.armL.upper.rotation.z = 0.12;
    this.armR.upper.rotation.z = -0.12;
    // airborne pose
    const a = this.airBlend;
    this.legL.upper.rotation.x = lerp(this.legL.upper.rotation.x, -0.9, a);
    this.legL.lower.rotation.x = lerp(this.legL.lower.rotation.x, 1.4, a);
    this.legR.upper.rotation.x = lerp(this.legR.upper.rotation.x, 0.3, a);
    this.legR.lower.rotation.x = lerp(this.legR.lower.rotation.x, 0.5, a);
    this.armL.upper.rotation.x = lerp(this.armL.upper.rotation.x, -1.2, a);
    this.armR.upper.rotation.x = lerp(this.armR.upper.rotation.x, -1.0, a);
    this.armL.upper.rotation.z = lerp(this.armL.upper.rotation.z, 0.6, a);
    this.armR.upper.rotation.z = lerp(this.armR.upper.rotation.z, -0.6, a);
    // body bob, forward lean, turn lean, idle breathing
    if (body.landedImpulse > 0) { this.landKick = body.landedImpulse; body.landedImpulse = 0; }
    this.landKick = damp(this.landKick, 0, 8, dt);
    const bob = Math.abs(c) * lerp(0.03, 0.08, run) * mv;
    const breathe = Math.sin(time * 2.2) * 0.01 * (1 - mv);
    this.pelvis.position.y = 0.98 + bob + breathe - this.landKick * 0.18;
    const yawRate = dt > 0 ? angleDiff(body.yaw, this.lastYaw) / dt : 0;
    this.lastYaw = body.yaw;
    this.lean = damp(this.lean, clamp(-yawRate * 0.06 * mv, -0.3, 0.3), 6, dt);
    this.spine.rotation.x = lerp(0.04, 0.22, run) * mv + a * 0.1;
    this.spine.rotation.y = s * 0.12 * mv;
    this.root.rotation.z = this.lean;
    this.head.rotation.x = -this.spine.rotation.x * 0.6;
    // world placement
    this.root.position.set(body.x, body.y, body.z);
    this.root.rotation.y = body.yaw;
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
