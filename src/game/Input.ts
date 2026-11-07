/**
 * Input: touch-first (virtual joystick on the left half, drag-to-look on the
 * right half, jump/sprint buttons), with keyboard + mouse for desktop.
 * Pinch-zoom, double-tap zoom and iOS gesture events are suppressed on the game
 * surface only, so the diagnostics panels remain scrollable.
 */

export class Input {
  moveX = 0; // -1..1 (right)
  moveY = 0; // -1..1 (forward)
  lookDX = 0; // accumulated pixels since last read
  lookDY = 0;
  zoomDelta = 0;
  jumpPressed = false;
  sprint = false;
  private keys = new Set<string>();
  private joyId: number | null = null;
  private joyOX = 0;
  private joyOY = 0;
  private lookId: number | null = null;
  private lookLX = 0;
  private lookLY = 0;
  private mouseDown = false;
  private joyEl: HTMLElement;
  private knobEl: HTMLElement;
  readonly radius = 56;
  touchActive = false;
  enabled = true;
  /** Timestamp of the last input event (for event-to-frame latency observations). */
  lastEventTime = 0;

  constructor(private surface: HTMLElement, jumpBtn: HTMLElement, sprintBtn: HTMLElement) {
    this.joyEl = document.getElementById('joystick')!;
    this.knobEl = document.getElementById('joystick-knob')!;
    const opts = { passive: false } as AddEventListenerOptions;
    surface.addEventListener('touchstart', (e) => this.onTouchStart(e), opts);
    surface.addEventListener('touchmove', (e) => this.onTouchMove(e), opts);
    surface.addEventListener('touchend', (e) => this.onTouchEnd(e), opts);
    surface.addEventListener('touchcancel', (e) => this.onTouchEnd(e), opts);
    // iOS Safari gesture events (pinch) — prevent page zoom on the game surface
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) surface.addEventListener(ev, (e) => e.preventDefault(), opts);
    surface.addEventListener('dblclick', (e) => e.preventDefault());
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    surface.addEventListener('mousedown', (e) => { this.mouseDown = true; this.lookLX = e.clientX; this.lookLY = e.clientY; this.lastEventTime = performance.now(); });
    window.addEventListener('mouseup', () => { this.mouseDown = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.mouseDown || !this.enabled) return;
      this.lookDX += e.clientX - this.lookLX;
      this.lookDY += e.clientY - this.lookLY;
      this.lookLX = e.clientX; this.lookLY = e.clientY;
      this.lastEventTime = performance.now();
    });
    surface.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomDelta += e.deltaY; }, opts);
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      this.keys.add(e.code);
      if (e.code === 'Space') { this.jumpPressed = true; e.preventDefault(); }
      this.lastEventTime = performance.now();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; });
    const press = (el: HTMLElement, fn: (down: boolean) => void) => {
      el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fn(true); }, opts);
      el.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); fn(false); }, opts);
      el.addEventListener('mousedown', (e) => { e.stopPropagation(); fn(true); });
      el.addEventListener('mouseup', (e) => { e.stopPropagation(); fn(false); });
    };
    press(jumpBtn, (d) => { if (d) this.jumpPressed = true; });
    press(sprintBtn, (d) => { if (d) { this.sprint = !this.sprint; sprintBtn.classList.toggle('on', this.sprint); } });
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    this.touchActive = true;
    this.lastEventTime = performance.now();
    const w = this.surface.clientWidth;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < w * 0.45 && this.joyId === null) {
        this.joyId = t.identifier;
        this.joyOX = t.clientX; this.joyOY = t.clientY;
        this.joyEl.style.display = 'block';
        this.joyEl.style.left = `${t.clientX - this.radius}px`;
        this.joyEl.style.top = `${t.clientY - this.radius}px`;
        this.knobEl.style.transform = 'translate(0px, 0px)';
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.lookLX = t.clientX; this.lookLY = t.clientY;
      }
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    this.lastEventTime = performance.now();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joyId) {
        let dx = t.clientX - this.joyOX, dy = t.clientY - this.joyOY;
        const l = Math.hypot(dx, dy);
        if (l > this.radius) { dx *= this.radius / l; dy *= this.radius / l; }
        this.moveX = dx / this.radius;
        this.moveY = -dy / this.radius;
        this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (t.identifier === this.lookId) {
        this.lookDX += (t.clientX - this.lookLX) * 1.3;
        this.lookDY += (t.clientY - this.lookLY) * 1.3;
        this.lookLX = t.clientX; this.lookLY = t.clientY;
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joyId) {
        this.joyId = null;
        this.moveX = 0; this.moveY = 0;
        this.joyEl.style.display = 'none';
      } else if (t.identifier === this.lookId) {
        this.lookId = null;
      }
    }
  }

  /** Combined movement vector (touch joystick or keyboard). */
  readMove(out: { x: number; y: number; mag: number }): void {
    let x = this.moveX, y = this.moveY;
    if (this.joyId === null) {
      x = 0; y = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      const walk = this.keys.has('AltLeft') || this.keys.has('KeyC');
      if (walk) { x *= 0.45; y *= 0.45; }
    }
    out.x = x; out.y = y;
    out.mag = Math.min(1, Math.hypot(x, y));
  }

  get sprintHeld(): boolean {
    return this.sprint || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  consumeJump(): boolean {
    const j = this.jumpPressed;
    this.jumpPressed = false;
    return j;
  }

  consumeLook(out: { dx: number; dy: number; zoom: number }): void {
    out.dx = this.lookDX; out.dy = this.lookDY; out.zoom = this.zoomDelta;
    this.lookDX = 0; this.lookDY = 0; this.zoomDelta = 0;
  }

  keyDown(code: string): boolean {
    return this.keys.has(code);
  }
}
