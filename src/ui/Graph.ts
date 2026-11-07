/** Minimal allocation-light canvas line graph for frame-time history. */

export interface GraphSeries {
  color: string;
  values: Float64Array;
  count: number;
  label: string;
}

export function drawGraph(canvas: HTMLCanvasElement, series: GraphSeries[], maxY: number, guides: number[], unit = 'ms'): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(10,14,18,0.6)';
  g.fillRect(0, 0, w, h);
  g.font = '10px ui-monospace, Menlo, monospace';
  g.lineWidth = 1;
  for (const gv of guides) {
    if (gv > maxY) continue;
    const y = h - (gv / maxY) * h;
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText(`${gv}${unit}`, 3, y - 2);
  }
  for (const s of series) {
    const n = s.count;
    if (n < 2) continue;
    g.strokeStyle = s.color;
    g.lineWidth = 1.25;
    g.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) { started = false; continue; }
      const x = (i / (n - 1)) * w;
      const y = h - (Math.min(v, maxY) / maxY) * h;
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();
  }
  let lx = w - 4;
  g.textAlign = 'right';
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    g.fillStyle = s.color;
    g.fillText(s.label, lx, 11);
    lx -= g.measureText(s.label).width + 10;
  }
  g.textAlign = 'left';
}

export function drawBars(canvas: HTMLCanvasElement, rows: Array<{ label: string; value: number; color: string; note?: string }>, unit: string): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const rowH = 18;
  const h = Math.max(20, rows.length * rowH + 4);
  canvas.style.height = `${h}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const max = Math.max(1e-6, ...rows.map((r) => (Number.isFinite(r.value) ? r.value : 0)));
  const labelW = Math.min(150, w * 0.42);
  g.font = '11px ui-monospace, Menlo, monospace';
  rows.forEach((r, i) => {
    const y = 2 + i * rowH;
    g.fillStyle = 'rgba(230,236,240,0.85)';
    g.fillText(r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label, 2, y + 12);
    const bw = Number.isFinite(r.value) ? ((w - labelW - 70) * r.value) / max : 0;
    g.fillStyle = r.color;
    g.fillRect(labelW, y + 3, Math.max(1, bw), rowH - 7);
    g.fillStyle = 'rgba(230,236,240,0.9)';
    g.fillText(Number.isFinite(r.value) ? `${r.value.toFixed(3)} ${unit}` : 'n/a', labelW + bw + 4, y + 12);
  });
}
