# Batching the visualizer's shadows — measured 2026-10-04

Status: one renderer setting changed, following measurements in the Codex
integrated browser on the owner's Windows machine. The rounded shadow painter
now explicitly batches its geometry. No layer, colour, animation, resolution,
or antialiasing setting was removed.

## Observation and method

The authenticated production Runs screen was inspected in the integrated
browser: WebGPU, 1066 × 930 CSS pixels at DPR 1, 916 scene objects, a last
scene rebuild of 54.3 ms, and a captured 44 FPS readout during a live run.
That is an observation, not a controlled performance sample or a run audit.
No run was started for this investigation.

Windows identifies a Ryzen 5 5500U and AMD Radeon Graphics, driver
31.0.21921.1000. The build uses Node 24.20.0, Pixi 8.20.1 and Vite 8.2.2.
The browser reports a non-fallback AMD WebGPU adapter; its
privacy-reduced architecture string says `rdna-2`, so that string is not used
to override the OS hardware identity.

The browser automation API exposes DOM inspection but no CPU profiler. A
local compiled copy was therefore served with diagnostic instrumentation,
and operated through the same integrated browser. The fixture and WebGPU
counter/timestamp implementation come from `scripts/viz-frame-probe.mjs`:
80 completed events, no provider calls, no live store. The instrumented page
adds measurements between Pixi's high- and low-priority ticker callbacks,
per-callback timings, WebGPU command counters, and attribution of standalone
Graphics draws to their scene labels. Results are written by the local page
to its loopback server, not read from browser-private state by automation.

Baseline: `f732a628561ce382d1bd1b5dcefd4d096687d2f7`. All paired measurements
below use the same compiled page, Runs selection, viewport, MSAA setting and
240-frame sample. The experiment temporarily changes only the existing
cast-shadow Graphics contexts' batching mode, then restores it. The compiled
source change was also loaded fresh and checked separately.

Raw JSON and the exact exploratory harness are archived in
[`evidence-2026-10-04/fps/`](evidence-2026-10-04/fps/). To reproduce the local
setup, copy `iab-probe.mjs.txt` to `.atoma-frame-probe/iab-probe.mjs`, compile
the GPU client into `.atoma-frame-probe/oct04-baseline` with Vite, and run the
harness with the pinned Node runtime. It serves only loopback fixtures; open
the printed URL with `?atomaDiag=1`, enter Runs, and use its measure buttons.
`?gpuTime=1` additionally enables timestamp readbacks. The `adapter-info.js.txt`
snippet was separately included in the compiled test HTML to record adapter
metadata. These are development experiments, not shipped product controls.

## What actually consumed time

Runs issued roughly 136 draws per frame. Around 55 standalone Graphics
executions were rounded shadows: about 25 on timeline cards, 9 on filter
chips, 6 in the sidebar, and the rest on panels, metrics and agent lanes.
These repeatedly broke the surrounding batches. Text atlasing is therefore
not the first explanation for the high draw count in this sample.

Pixi 8's automatic Graphics policy batches only contexts with fewer than
400 vertex coordinates (200 vertices). A five-layer shadow has about
225–245 vertices. Its geometry is static; only the transform/alpha changes,
so it can share the surrounding batch without changing its appearance.

The paired results:

| Measure | Auto 1 | Batched 1 | Auto 2 | Batched 2 |
|---|---:|---:|---:|---:|
| Main-thread ticker, mean ms/frame | 9.87 | 5.77 | 9.39 | 5.62 |
| Draws/frame | 135.8 | 36.5 | 135.7 | 36.5 |
| rAF interval, mean ms | 32.92 | 29.03 | 31.53 | 28.47 |
| rAF interval, P95 ms | 50.0 | 34.1 | 49.9 | 33.5 |
| Buffer uploads, KiB/frame | 147.2 | 241.1 | 147.2 | 241.8 |

The repeated effect is about 40% less main-thread frame time and 73% fewer
draws. The tradeoff is roughly 95 KiB more geometry uploaded per frame from
the retained animated bands. No new render target or GPU context is added.
Main-thread timings include time waiting inside GPU calls, not only JavaScript
computation.

The paired intervals correspond to about 30–32 → 34–35 FPS. They do **not**
establish a stable FPS promise: the later compiled-change sample still had
37.1 draws and 6.74 ms ticker time, but a 36.74 ms rAF mean. The machine and
the integrated browser's presentation cost varied enough to reverse the FPS
comparison across minutes. No tests or builds ran during these samples.

One timestamp-enabled sample at 1280 × 720 measured 6.78 ms of GPU passes per
frame. Vsync remained enabled in the integrated browser, so it is a load
measurement, not the unlocked GPU cost required by the earlier incident
records. Windows separately reported the ChatGPT GPU process at 43–45% of
the 3D engine and the desktop compositor at 5–6%; it cannot attribute that
process-level utilization solely to this canvas.

## Alternatives measured

- Hiding the crystal barely changed frame interval (31.18 → 30.77 ms); its
  animation still consumed around 1.4–1.7 ms CPU. That experiment hid the draw,
  not the animation callback, so it is not evidence that the callback is free.
- Disabling MSAA improved one idle sample, but the moving-pointer sample did
  not improve. Default antialiasing is preserved.
- Moving the pointer triggered about 1.7 external texture copies and 8.7
  render passes per frame, compared with zero copies and 1.7 passes at rest.
  Navigation icon relighting and its silhouette pass remain a follow-up;
  shadow batching alone does not remove that interaction cost.
  The later compiled pointer sample uploaded 613 KiB/frame as shadows moved,
  against 148 KiB before, and its 12.42 ms ticker mean did not improve on the
  earlier 11.96 ms sample. The supported gain here is the repeated idle
  comparison, not a claimed improvement to every interaction.
- The measured production scene rebuild remains a separate source of live
  refresh stutters. This change does not alter polling or scene reconstruction.

## Visual and behavioral validation

With the ticker stopped, the same complete scene was extracted with automatic
and forced shadow batching: 699,660 pixels, 416 differing pixels, maximum
channel difference **1/255**, and none above 2/255. Geometry, colours and alpha
coverage are preserved within raster rounding. The fresh compiled change was
also inspected visually in the integrated browser.

Validation with the pinned runtime:

- `npm run typecheck`: passed both TypeScript configurations.
- ESLint on `src/viz/client-gl/gpu-renderer.ts`: passed.
- Vitest on `viz-soft-shadow`, `viz-cast-shadow`, `viz-gpu-views`, and
  `viz-overlay-stack`: all 251 tests passed.
- `npm run docs:check`: passed.
- `npm run viz:smoke`: the full build and OAuth browser smoke passed. The GPU
  arm failed before loading its page (`ERR_CONNECTION_REFUSED`): its ten-second
  server-start deadline expired on this machine.
- A diagnostic copy with a 60-second startup deadline reached the graphical
  assertions. Background suspension, the crystal and camera travel checks
  passed, then `focused view frame composite is invalid` failed with zero
  frames. The graphical assertions were left unchanged. This is not a passing
  full browser smoke.
- The same diagnostic smoke against the archived **original** client bundle
  failed at the same assertion with exactly the same empty frame result. The
  control uses a copy of the compiled server changing only `CLIENT_DIR` to
  that bundle. The failure predates this batching change; the full smoke still
  needs its own investigation. Both logs are archived beside the measurements
  as `smoke-batched.log` and `smoke-baseline.log`.

During validation the checkout was reconciled to `7347ba48`; the renderer and
the relevant test/smoke sources were unchanged from the measurement baseline.
The same four-line renderer patch was reapplied after that reconciliation.
