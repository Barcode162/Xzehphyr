# Browser & device limitations

The diagnostics never invent values. When an API is missing, the dashboard says so and
shows `n/a` with the reason. The **APIs** tab lists live availability on the current device.

## iPhone / iOS Safari (primary target)

All iOS browsers (Safari, Chrome for iOS, Firefox for iOS, in-app browsers) use WebKit, so
the API surface is the same.

| Capability | Status on iOS Safari | Effect in this app |
|---|---|---|
| `performance.memory` (JS heap) | **Not exposed** | Heap shown as "not exposed"; GC events cannot be inferred. Memory tab shows only engine-side exact byte counts and labeled estimates. |
| `navigator.deviceMemory` | Not exposed | Shown as "not exposed". |
| User-Agent Client Hints | Not exposed | Device model is not available; OS version parsed from the UA string. |
| `EXT_disjoint_timer_query_webgl2` | **Not exposed** | **GPU execution time cannot be measured.** Only CPU render-submit time is shown, and it is labeled as CPU time. |
| `WEBGL_debug_renderer_info` | Returns a generic "Apple GPU" | GPU model not identifiable. |
| `PerformanceObserver` `longtask` / `long-animation-frame` | Not supported | Long frames are detected from rAF intervals only (> 50 ms, and > 1.5× refresh). |
| `performance.now()` resolution | Coarsened | Measured at startup and displayed. Per-frame subsystem timings are quantized; compare **means over many frames**. |
| `requestAnimationFrame` rate | Typically capped at 60 Hz; 30 Hz in Low Power Mode | Many scenarios will be vsync-limited; benchmarks flag `vsyncLimited` and you should compare JS time instead of FPS. |
| Fullscreen API on `<canvas>` (iPhone) | Not available | Use **Share → Add to Home Screen** for a chrome-less standalone view (manifest + `apple-mobile-web-app-capable`). |
| Pinch / double-tap zoom | `user-scalable=no` is ignored by iOS for accessibility | The game surface uses `touch-action: none`, blocks `gesturestart/gesturechange`, and calls `preventDefault()` on touch events. Panels stay scrollable. |
| Web Audio | Requires a user gesture; may follow the hardware silent switch | Audio starts only from "Start with sound". |
| WebGPU | Depends on iOS/Safari version; requires a **secure context** | Detected, never assumed. Over `http://<LAN-IP>` it is unavailable (not a secure context). |
| Cross-origin isolation | Requires HTTPS + COOP/COEP | The dev server sends COOP/COEP, but over plain-HTTP LAN it has no effect. |
| Memory limits | Tabs can be killed under memory pressure without warning | Test A (all geometry prebuilt, ~60 k scene objects) is the most memory-hungry mode; prefer A2/C on older phones. |

## Chromium (desktop / Android)

* `performance.memory` available (bucketed, non-standard) → heap and inferred GC.
* `EXT_disjoint_timer_query_webgl2` often available on desktop GPUs → GPU time. Results are
  asynchronous (1–3 frames later) and discarded on disjoint events; implausible values
  (software rasterizers) are rejected and counted.
* `long-animation-frame` / `longtask` observers available.
* `performance.now()` is 100 µs-coarsened unless the page is cross-origin isolated
  (5 µs). `npm run dev` / `npm run preview` send COOP/COEP headers for this reason.

## Firefox

* No `performance.memory`, no `deviceMemory`, timer queries disabled by default,
  `performance.now()` coarsened to ~1 ms (more with resistFingerprinting).

## What is never attempted

* No fingerprinting beyond what the page needs to label its own measurements.
* No attempt to bypass timer coarsening, GPU string masking or permission prompts.
* No network requests at runtime: all assets are procedural, nothing is uploaded.
  Exports are local files (download or the share sheet).
