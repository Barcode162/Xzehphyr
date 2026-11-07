/**
 * AUDIO POSITIONING — independent evaluation system.
 *
 * Discovers sound emitters near the listener (sphere query, cached per 4 m cell),
 * ranks them by estimated loudness and assigns the top K to a fixed pool of
 * spatialized WebAudio voices. Sounds are synthesized procedurally (no assets).
 *
 * The relevance query runs at 10 Hz even when audio output is disabled, so the
 * evaluation workload stays comparable across benchmark runs. WebAudio itself
 * starts only after a user gesture (required by iOS Safari).
 * CPU cost measured here is main-thread JavaScript only; audio rendering runs on
 * the browser's audio thread and is not observable from JS.
 */
import { Discovery } from '../spatial/Discovery';
import { QueryCache, cacheKey } from '../spatial/QueryCache';
import { WorldDatabase } from '../world/WorldDatabase';
import { FrameSystem } from '../world/FrameSystem';
import { Flag, SurfaceType } from '../world/types';
import { IntList } from '../util/math';
import { profiler, Scope, counters } from '../diagnostics/Profiler';

interface Voice {
  entity: number;
  kind: 'stream' | 'bird' | 'none';
  panner: PannerNode;
  gain: GainNode;
  src: AudioScheduledSourceNode | null;
  filter: BiquadFilterNode | null;
  nextChirp: number;
}

export interface AudibleSource {
  entity: number;
  x: number; y: number; z: number;
  loudness: number;
  sound: string;
}

export class AudioSystem {
  readonly K = 6;
  queryRadius = 48;
  readonly candidates = new IntList(128);
  readonly audible: AudibleSource[] = [];
  private pool: AudibleSource[] = [];
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private noiseBuf: AudioBuffer | null = null;
  enabled = false;
  supported = typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window);
  lastUpdate = -1;
  updateInterval = 0.1;
  fromCache = false;
  volume = 0.8;

  constructor() {
    for (let i = 0; i < 128; i++) this.pool.push({ entity: -1, x: 0, y: 0, z: 0, loudness: 0, sound: '' });
  }

  /** Must be called from a user gesture handler. */
  async enable(): Promise<boolean> {
    if (!this.supported) return false;
    if (!this.ctx) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuf = this.makeNoise(2);
      this.startWind();
      for (let i = 0; i < this.K; i++) {
        const panner = this.ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = 4;
        panner.maxDistance = 60;
        panner.rolloffFactor = 1.4;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        gain.connect(panner);
        panner.connect(this.master);
        this.voices.push({ entity: -1, kind: 'none', panner, gain, src: null, filter: null, nextChirp: 0 });
      }
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.enabled = true;
    return true;
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume(): void {
    if (this.ctx && this.enabled && this.ctx.state !== 'running') void this.ctx.resume();
  }
  disable(): void {
    this.enabled = false;
    this.suspend();
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    return buf;
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain);
    lfoGain.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(this.master!);
    src.start();
    lfo.start();
  }

  /** Relevance query + voice assignment. Runs at 10 Hz. */
  update(time: number, lx: number, ly: number, lz: number, fx: number, fz: number,
    discovery: Discovery, qcache: QueryCache, db: WorldDatabase, frames: FrameSystem): void {
    if (this.lastUpdate >= 0 && time - this.lastUpdate < this.updateInterval) return;
    this.lastUpdate = time;
    profiler.begin(Scope.Audio);
    const cell = 4;
    const qx = Math.floor(lx / cell), qz = Math.floor(lz / cell);
    const key = cacheKey(qx, qz, 0x41554449, Math.round(this.queryRadius));
    profiler.begin(Scope.CacheLookup);
    let list = qcache.lookup(key, discovery.index, db.structureVersion);
    profiler.end(Scope.CacheLookup);
    this.fromCache = list !== null;
    if (!list) {
      this.candidates.clear();
      discovery.sphere((qx + 0.5) * cell, ly, (qz + 0.5) * cell, this.queryRadius + cell, Flag.EmitsSound, this.candidates);
      list = this.candidates;
      qcache.store(key, list, discovery.lastMask, discovery.index, db.structureVersion);
    }
    if (this.fromCache) counters.qcacheHits++; else counters.qcacheMisses++;
    // rank by estimated loudness
    this.audible.length = 0;
    const W = frames.world;
    let n = 0;
    for (let i = 0; i < list.length && n < this.pool.length; i++) {
      const e = list.data[i];
      const ai = db.acoustic[e];
      if (ai < 0) continue;
      const desc = db.acoustics[ai];
      const o = frames.resolve(e);
      const dx = W[o] - lx, dy = W[o + 1] - ly, dz = W[o + 2] - lz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > desc.radius * desc.radius) continue;
      const s = this.pool[n++];
      s.entity = e; s.x = W[o]; s.y = W[o + 1]; s.z = W[o + 2];
      s.loudness = desc.gain / (1 + d2 / 64);
      s.sound = desc.sound;
    }
    for (let k = 0; k < this.K && k < n; k++) {
      let best = k;
      for (let j = k + 1; j < n; j++) if (this.pool[j].loudness > this.pool[best].loudness) best = j;
      const t = this.pool[k]; this.pool[k] = this.pool[best]; this.pool[best] = t;
      this.audible.push(this.pool[k]);
    }
    counters.audioSources = this.audible.length;
    if (this.enabled && this.ctx) this.applyVoices(lx, ly, lz, fx, fz);
    profiler.end(Scope.Audio);
  }

  private applyVoices(lx: number, ly: number, lz: number, fx: number, fz: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(lx, now, 0.05);
      L.positionY.setTargetAtTime(ly, now, 0.05);
      L.positionZ.setTargetAtTime(lz, now, 0.05);
      L.forwardX.setTargetAtTime(fx, now, 0.05);
      L.forwardY.setTargetAtTime(0, now, 0.05);
      L.forwardZ.setTargetAtTime(fz, now, 0.05);
    } else {
      // older Safari
      (L as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(lx, ly, lz);
      (L as unknown as { setOrientation: (a: number, b: number, c: number, d: number, e: number, f: number) => void }).setOrientation(fx, 0, fz, 0, 1, 0);
    }
    // keep voices whose entity is still audible, release the rest
    const wanted = new Set(this.audible.map((a) => a.entity));
    for (const v of this.voices) {
      if (v.entity >= 0 && !wanted.has(v.entity)) {
        v.gain.gain.setTargetAtTime(0, now, 0.3);
        v.entity = -1;
      }
    }
    for (const a of this.audible) {
      let v = this.voices.find((x) => x.entity === a.entity);
      if (!v) {
        v = this.voices.find((x) => x.entity < 0);
        if (!v) continue;
        this.bindVoice(v, a);
      }
      if (v.panner.positionX) {
        v.panner.positionX.setTargetAtTime(a.x, now, 0.1);
        v.panner.positionY.setTargetAtTime(a.y, now, 0.1);
        v.panner.positionZ.setTargetAtTime(a.z, now, 0.1);
      } else {
        (v.panner as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(a.x, a.y, a.z);
      }
      if (v.kind === 'bird' && now > v.nextChirp) this.chirp(v, now);
    }
  }

  private bindVoice(v: Voice, a: AudibleSource): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (v.src) { try { v.src.stop(); } catch { /* already stopped */ } v.src.disconnect(); v.src = null; }
    if (v.filter) { v.filter.disconnect(); v.filter = null; }
    v.entity = a.entity;
    if (a.sound === 'stream') {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      src.playbackRate.value = 0.9 + Math.random() * 0.3;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900 + Math.random() * 500;
      f.Q.value = 0.5;
      src.connect(f); f.connect(v.gain);
      src.start(now, Math.random() * 1.5);
      v.src = src; v.filter = f; v.kind = 'stream';
      v.gain.gain.setTargetAtTime(0.9, now, 0.4);
    } else {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 2400;
      osc.connect(v.gain);
      osc.start(now);
      v.src = osc; v.kind = 'bird';
      v.gain.gain.setValueAtTime(0, now);
      v.nextChirp = now + Math.random() * 2;
    }
  }

  private chirp(v: Voice, now: number): void {
    const osc = v.src as OscillatorNode;
    const base = 2200 + Math.random() * 1800;
    const notes = 2 + Math.floor(Math.random() * 4);
    let t = now + 0.02;
    for (let i = 0; i < notes; i++) {
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.5), t + 0.07);
      v.gain.gain.setValueAtTime(0, t);
      v.gain.gain.linearRampToValueAtTime(0.22, t + 0.01);
      v.gain.gain.linearRampToValueAtTime(0, t + 0.09);
      t += 0.12 + Math.random() * 0.06;
    }
    v.nextChirp = t + 1.5 + Math.random() * 4;
  }

  /** Short synthesized footstep for the surface under the runner. */
  footstep(surface: SurfaceType, intensity: number): void {
    if (!this.enabled || !this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let dur = 0.07, vol = 0.28 * intensity;
    switch (surface) {
      case 'wood': f.type = 'bandpass'; f.frequency.value = 380; f.Q.value = 2.5; vol *= 1.6; dur = 0.09; break;
      case 'water': f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.7; dur = 0.22; vol *= 1.2; break;
      case 'grass': case 'litter': f.type = 'highpass'; f.frequency.value = 1800; dur = 0.08; vol *= 0.7; break;
      case 'rock': f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 1.4; dur = 0.05; break;
      default: f.type = 'lowpass'; f.frequency.value = 900; break;
    }
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(f); f.connect(g); g.connect(this.master!);
    src.start(now, Math.random() * 1.5, dur + 0.02);
  }

  get state(): string {
    return this.ctx ? this.ctx.state : this.supported ? 'not started (needs user gesture)' : 'unsupported';
  }
  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 0;
  }
  get baseLatency(): number {
    return this.ctx && 'baseLatency' in this.ctx ? this.ctx.baseLatency : NaN;
  }
}
