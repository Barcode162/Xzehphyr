#!/usr/bin/env python3
"""Render exported benchmark JSON (bench-<suite>.json) as markdown tables.
Usage: python3 scripts/results-to-markdown.py [results_dir] compare ablation sweep static stress overhead"""
import json, sys, os
SP = sys.argv[1] if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'results')
def f(v, d=2):
    if v is None: return 'n/a'
    if isinstance(v, (int, float)): return f'{v:.{d}f}'
    return str(v)
def scope(r, name):
    for k, v in r['scopesMean'].items():
        if k.startswith(name): return v
    return None
for suite in [a for a in sys.argv[1:] if not os.path.isdir(a)]:
    p = f'{SP}/bench-{suite}.json'
    if not os.path.exists(p): continue
    d = json.load(open(p))
    res = d['results']
    print(f'\n#### {suite}\n')
    print('| Scenario | Entities | JS ms mean (p95) | Δ JS vs first | Scene update / Resolution / Visibility / Shadow / Physics / Assembly / Submit (ms) | Draws | Triangles | Visible / shadow-only | Unresolved frames | Query-cache hit | Geometry gen | Geometry mem (est.) |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|')
    base = res[0]['cpu']['mean']
    for r in res:
        sc = [scope(r, 'Conventional'), scope(r, 'Reference resolution'), scope(r, 'Visibility'), scope(r, 'Shadow contributors'), scope(r, 'Physics '), scope(r, 'Render assembly'), scope(r, 'Render submit')]
        sc = ' / '.join(f(x, 2) if x else '–' for x in sc)
        delta = '' if r is res[0] else f"{(r['cpu']['mean'] - base) / base * 100:+.0f}%"
        hit = r['queryCacheHitRate']
        print(f"| {r['scenario']['label']} | {r['entityCount']:,} | {f(r['cpu']['mean'])} ({f(r['cpu']['p95'])}) | {delta} | {sc} | {f(r['draws']['mean'],0)} | {r['triangles']['mean']:,.0f} | {f(r['visibleMean'],0)} / {f(r['shadowOnlyMean'],0)} | {f(r['unresolvedFramesPct'],1)}% | {('%.0f%%' % (hit*100)) if hit is not None else 'n/a'} | {r['geometryGenerated']} | {f(r['memory']['estimates']['gpuGeometry.estimateMB'],1)} MB |")
    ys = [r for r in res if r.get('yawSectors')]
    if ys:
        print('\nCamera-direction sectors — JS ms / draws / triangles (k) / visible / shadow-only:\n')
        print('| Scenario | ' + ' | '.join(f"{s['sectorDeg']:.0f}°" for s in ys[0]['yawSectors']) + ' |')
        print('|---|' + '---|' * len(ys[0]['yawSectors']))
        for r in ys:
            cells = []
            for s in r['yawSectors']:
                v, sh = s['visibleMean'], s['shadowOnlyMean']
                cells.append(f"{s['cpuMean']:.2f} / {s['drawsMean']:.0f} / {s['trianglesMean']/1000:.0f} / {f(v,0)} / {f(sh,0)}")
            print(f"| {r['scenario']['label']} | " + ' | '.join(cells) + ' |')
