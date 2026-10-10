# Visualizer — AGENTS.md

`src/viz/` owns trace projection, gated HTTP, web push and the GPU client (MUI is frozen).

Read [`AGENTS.md`](../../AGENTS.md) first for cross-cutting rules.
Traces are immutable evidence: project them, never rewrite them.

Neighbours:

- [`src/auth`](../auth/AGENTS.md) — identities, organisations, the admin flag
- [`src/projects`](../projects/AGENTS.md) — org-scoped run storage
- [`src/platform`](../platform/AGENTS.md) — the journal push reads from
- [`src/core`](../core/AGENTS.md) — the trace shapes it projects

## Commands

Visualizer. The GPU client is the product UI (`npm run viz`); MUI is the frozen
fallback. Every launcher here also arms the mechanical watch in-process behind
the gate (`--no-sentinel`, `--sentinel-interval`, `--cost-alert`, or
`ATOMA_VIZ_SENTINEL=0` on the launcher path, which forwards no flags).
NO browser check is in `release:check` any more — `viz:smoke`, `viz:smoke:gc`
and the mark-turn film all need a real Chrome (and, for GC, a real WebGPU
adapter), which CI does not have. Run `viz:smoke` on a real machine before
shipping a viz change; the root file records why it left CI. CI carries it as a
MANUAL `workflow_dispatch` job (`viz-smoke`, `continue-on-error`): a button to
ask for the behavioural proof from a PR page, never a gate, because the runner
is the wrong machine to measure frame time on.
`npm run viz`, `doctor:dev` and `auth:dev` fill unset keys from checkout `.env`
so a local GitHub-gated visualizer does not need a shell export. Compiled
`viz:serve` does not load `.env`: production injects the process environment.
`ATOMA_DEPLOY_LOCK_PATH` is a host-owned drain marker: while it exists the server
keeps reads but refuses new mutating requests (an MCP message by what it does:
[src/mcp](../mcp/AGENTS.md)) and stateful OAuth GETs with 503, so an activation cannot race
newly admitted state. One naming its writer (`guard <pid> <identity>`) pauses only while that process lives.

`viz:shot` captures a PNG of the rendered client (logged-in via stubs or
anonymous) for visual review after UI edits — [docs/viz-screenshot.md](../../docs/viz-screenshot.md).

```bash
npm run viz
npm run viz:mui
npm run viz:serve
npm run viz:demo
npm run viz:shot -- --auth --select-first
npm run viz:smoke
npm run viz:smoke:files             # isolated shared-reader build, real formats and CSP checks
npm run viz:smoke:files -- --dev    # same proofs through Vite's development transforms
npm run viz:smoke:gc
npm run viz:mark-turn
npm run viz:mark-turn -- --degree 47
npm run viz:mark-turn -- --pointer
npm run viz:mark-turn:analyze
```

## Trace projection and the GPU client

- Viz projects immutable traces at the typed boundary. Do not mutate raw trace
  prose to display current taxonomy.
- The GPU client (`src/viz/client-gl/`) is the product UI. The MUI client
  (`src/viz/client/`) is FROZEN as a fallback (`ATOMA_VIZ_UI=mui`,
  `npm run viz:mui`): fix breakage, add nothing. Modules under `client/` that
  the GL client imports (types, run-utils, search, timeline-layout,
  structured-detail, i18n, data-api, pwa) are shared library code and stay live.
- `gpu-renderer.ts` holds the stateful renderer class only. Pure chip layout,
  event copy, shaders, motion, and the scroll pane live under
  `client-gl/renderer/`; views are free functions over the exported
  `RendererCtx` (a Pick over the class) in `renderer/views/`. New view code
  goes there, never back into the class.
- Scrollable GPU content goes through `createScrollPane` (bounded + masked);
  the wheel handler FAILS CLOSED on `scrollMax`, so a view that never declares
  its max does not scroll. Wheel ticks and one-finger touch drags share ONE router (`scrollAt`): the drag names its pane from where the finger LANDED and converts travel through the live camera. The canvas declares `touch-action: pan-y`, never `none` — the browser's `pointercancel` on a recognised pan is what keeps Pixi from reporting a tap on the row the finger began on (2026-09-15: a phone could neither scroll nor read the rail). Cull by skipping draws, not by stopping the layout cursor. Detail panes report `detailBounds`/`detailScrollMax`. Runs retains a bounded row window under a fixed mask. Reproject hit targets and shadow anchors on scroll; window crossings, changed data/selection/filters, resize and camera travel rebuild, and a window left with under half its overscan re-centres in the first still pause, so a crossing rarely lands mid-gesture. Retained listeners dispatch to the latest React callback.
- `prefersReducedMotion()` (`renderer/motion.ts`) is the only reduced-motion
  source in the GL client. Every animation system consults it and JUMPS to its
  final state — exit effects are skipped entirely, never left running.
- The GPU client uses one Pixi context (WebGPU with WebGL fallback). Do not add a second context for a tiny widget. Smoke tests assert exactly one canvas and both backends.
- Chevrons share the 14px geometry in `client-gl/button-icons.ts`: DOM
  disclosures and selects use its CSS variables; canvas controls use
  `drawChevron`. Never substitute a font glyph or a browser's native marker.
- New action buttons include a semantic icon beside their label, including
  compact controls such as Change model and Send. Reuse the shared 14px
  `client-gl/button-icons.ts` catalog through `ButtonIcon` for DOM buttons and
  `drawButtonIcon`/`buttonIconKind` for GPU buttons; add missing geometry there.
  Keep decorative icons hidden from accessibility and preserve the button's
  text or explicit accessible name. Do not introduce text-only action buttons,
  emoji substitutes, or a separate icon style for one feature.
- The renderer stops its ticker when the document is hidden or loses focus. Camera draws are gated too;
  background snapshots coalesce until focus returns, when the latest scene is rebuilt before animation resumes.
- Keep GPU animation state out of React/Zustand hot paths. Use mutable samples
  read once per frame; do not rebuild the scene for pointer motion. A subtree
  that MUTATES EVERY FRAME draws into its own render group (`ctx.animatedLayer`,
  ONE per band): Pixi re-uploads a group's whole batch when anything in it moves. Frame cost is measured, never guessed: `npm run viz:frame-probe` ([record](../../docs/incidents/gpu-frame-cost-2026-09-06.md), [2026-09-30](../../docs/incidents/gpu-fps-2026-09-30.md)), with vsync UNLOCKED for cost: at 60 fps an integrated GPU down-clocks, so its pass timestamps read load, not cost. A LIVE run's own refresh (its growing trace, the run index, a project's run list while one is live) waits for a still reader — pointer and wheel quiet 400ms, one rebuild a second, never over 3s — and nothing a reader causes waits: `renderer/live-refresh.ts`.
- The hover bubble is ONE bubble, on its own sibling layer above the crystal,
  and it obeys the rule above: views declare RECTANGLES per render through
  `ctx.tooltip` (local coordinates, projected while the parent transform is
  live), and `renderer/tooltip.ts` moves the bubble from the same pointer
  sample the pointer light reads. That layer is never filtered — the pointer
  light must not smear text a reader opened the bubble to read — and never
  hit-tested, so it cannot eat a click meant for the row under it. The canvas
  is one DOM surface, so a Pixi label cannot carry a native `title=`; do not
  add a DOM overlay for one instead.
- Relative ages come from `renderer/relative-time.ts` alone: it owns the
  buckets and the two-week horizon past which an exact date is shown. NOT
  `Intl.RelativeTimeFormat`, which cannot say "hier" or "il y a quelques
  minutes"; it still formats the exact instant. The phrase is lossy by design,
  so every relative stamp keeps the exact instant reachable in a bubble, and a
  stamp this bundle cannot parse shows its RAW value rather than an empty
  column — the same tolerance journal rows apply to kind and severity.
- A Pixi filter that OUTLIVES one `render()` must never sit `enabled = false`
  across a GC window without `buffer.autoGarbageCollect = false` on its uniform
  buffer. Pixi skips disabled filters, so the buffer stops being touched, ages
  out and is destroyed, while `BindGroupSystem._hash` keeps serving a cached
  bind group that points at it — every later `queue.submit` is then a
  validation error, permanently. Today only the pointer light has that lifetime,
  and its two carriers share ONE uniform group, pinned once.
- Timeline card bodies use ONE direct shared `Mesh` for all visible faces. Its
  shader samples the CC0 diffuse + normal bitmaps once each and derives the
  specular term analytically; chrome remains ordinary Graphics in underlay and
  overlay layers. Never put a Pixi `Filter` or custom mesh on each card: every
  filter becomes its own render-to-texture pass and every custom mesh its own
  draw, so GPU cost diverges between ALL and TRUST. Hover/entry transforms and
  tint are interleaved attributes, flushed once before Pixi's render ticker.
- Navigation icons are real CC0 GLB meshes rendered by ONE shared, transparent
  Three.js renderer into twelve small dynamic Pixi textures. Three.js is an
  asset renderer here, never a second page canvas or React scene: Pixi still
  owns composition, hit testing and the shared cast-shadow painter. Render the
  resting icons once, normalise optical size from their rendered alpha area,
  use the one gold material across the set, and throttle pointer-light updates.
  Live textures match display pixels including hover, without mipmaps. Derive the white shadow mask on Pixi's device from the one uploaded face; never restore a shadow canvas upload. Inactive nav/filter/agent chips settle after entry/interaction; icon relighting stays independently live. Motion means activity: metric tiles pulse only for a LIVE run, and a finished run's settle after their entrance.
  The folder alone keeps its pale document material and a near-front rest pose
  so its pocket, rear tab and papers remain legible at rail size. Preserve the
  artist-authored GLB normals: recomputing them smears bevel lighting across
  flat faces. A mesh spins slowly only after click, with state retained across
  the view rebuild that click causes. Do not create a WebGL renderer per icon
  or restore the former pre-rendered PNG faces.
- Navigation mesh shadows use the same Pixi cast-shadow painter as the rest of
  the scene. Feed it a neutral white alpha mask derived from the live mesh
  render; tinting the coloured face texture directly creates dark colour chips.
- Human-readable product dates go through `client/date-format.ts`: use the
  locale-aware absolute formatter for persisted timestamps and omit seconds by
  default. Keep seconds only on operational surfaces where sub-minute ordering
  matters. Relative timestamps may reuse that absolute formatter for their
  expanded label instead of exposing ISO strings. Formatters come from its `dateTimeFormat` cache: a `toLocale*String` call builds a new `Intl.DateTimeFormat` every time, and one per card was a fifth of a Runs rebuild.
- Pixi 8.19.0 WebGPU GC also unloads in-use static uniform buffers (global
  uniforms, batcher UBOs) whose values have not changed, with the same
  destroyed-buffer submit (pixijs#12080). The engine fix (pixijs#12147) is
  not in a release. Until it is, WebGPU init sets `renderer.gc.enabled =
  false`. Do not re-enable GC on WebGPU without that Pixi release; keep the
  pointer-light pin either way. Scene resources are destroyed explicitly in
  `render()`. WebGL GC may stay on.
- GPU lifetime defects are invisible to `tests/` (mocked, no device) and to the
  WebGL fallback (no bind groups). They are covered by `npm run viz:smoke:gc`,
  which needs real Chrome plus a real WebGPU adapter and therefore stays OUT of
  `release:check`; it skips loudly rather than reporting "cannot observe" as
  "verified", and fails if its preconditions never arm. `?atomaDiag=1` exposes
  the read-only renderer handle those smokes need; it is inert otherwise.
- `isRunLive` / `isIndexEntryLive` are the only live predicates, and they live
  in `src/viz/liveness.ts`, OUTSIDE `client/`, because server-side readers ask
  the same question (the sentinel's operator source). `client/run-utils.ts`
  re-exports them, so there is one definition behind both import paths. The
  abandoned threshold exceeds plausible LLM/tool activity (currently 12 min).
- NOTHING outside `client/` and `client-gl/` may import `src/viz/client/*` at
  runtime. `viz:build` EMPTIES `dist/viz/client/`, so the `.js` tsc emitted
  there is gone by the end of `npm run build` and a compiled server importing
  it dies with ERR_MODULE_NOT_FOUND — invisible to typecheck, lint and
  `tests/`, all of which run from source. `tests/viz-client-bundle-boundary`
  is the cheap guard; `viz:smoke` is the behavioural proof.
- Runs rails remain aligned to viewport projection. Never apply scene parallax
  to causal timeline geometry.
- `runStatus` is the ONE definition of what happened to a run, and every
  surface that labels one uses it. Cancellation is not failure: a cancelled
  run records an error message by design, so `cancelled` wins over `error`.
- Registry counter events stamp the TARGET TYPE VERSION they credit or blame;
  they do not copy a full prompt snapshot into every event. The typed run
  projection recovers that version chronologically for older traces when it
  can, and the card omits an unknowable version instead of printing `v?`.
  `/api/runs` stays raw at the client reader: a delta rejoins the complete run
  BEFORE projection, or an earlier patch is invisible and the initial version
  can be stamped onto a later counter. Empty-delta identity comparisons ignore
  projection-only fields such as the rank derived from a stored numeric tier;
  otherwise every raw poll looks changed and rebuilds the GPU scene.
- EVERY DOM overlay over the canvas takes the veil: `inert`, the
  `.gpu-overlays-veiled` class, and its own `--gpu-overlay-left/top` so the
  menu hole is punched in its own box. Scene Tuning was the one exception and
  it was the worst place for one — `position: fixed; z-index: 8`, defaulting to
  the top-right corner the Pixi account menu anchors to (2026-08-27, 2.10). It
  is DRAGGED, so it restates that origin inline where CSS-positioned overlays
  restate it in the stylesheet.
- `GpuRenderer.destroy()` nulls `this.snapshot` FIRST. Two end-of-transition
  `requestAnimationFrame`s re-render behind an identity guard on that field,
  and nothing else in teardown makes them false.
- EVERY read of the run corpus goes through `readBoundedRunFile`
  (`runIndex.ts`), under the one `MAX_TRACE_BYTES` ceiling
  ([src/contracts](../contracts/AGENTS.md)). A trace has no cap in the
  pipeline and `/api/runs/:id` is polled ~1×/s per live tab, so an unbounded
  read there materialised an arbitrary document per second per client. Over
  the ceiling the detail route answers 413 — reusing the status this codebase
  gives an oversized request body, told apart by its `error` string, because
  404 would make an existing trace look deleted. The delta still parses the
  whole document once per poll: a cache keyed on mtime, or a streaming
  projection of `events`, is REGISTERED, not built.
- The runs timeline reads NEWEST FIRST and is framed by two bookend rows
  (run ended / run started) that carry the verdict. Bookends are view rows:
  the view publishes `rowOffset` on the timeline viewport and overlays add it,
  or they drift by exactly one row. Ordering lives in `buildTimelineLayout`
  (`newestFirst`) so cards, rails and connectors share one row space;
  `firstRow`/`lastRow` are the DISPLAY range while fork/join connectors keep
  causal rows.
- A branch rail spans its SUBTREE (`subtreeFirstRow`/`subtreeLastRow`): a
  parent is still alive while its children run, and a rail drawn over its own
  events alone leaves child branches visually detached.
- Pixi objects draw local geometry at local origin, then position the object.
  Avoid double-offset hit targets.
- The brand mark is a single all-diamond Pixi crystal with an archived inactive
  teal/amber/violet material palette, dynamic relighting, reduced-motion support,
  and no overlapping R3F logo.
- The pointer catch on that crystal is a finite-source specular lobe, never a
  screen-space pool under the cursor. Its peak comes from the real
  lamp/surface/camera half vector at the pinhole ray/facet-plane intersection,
  its width from the material roughness plus the one source radius, and its
  bounded isocontours supply the projected ellipse. Do not bend the facet
  normal or reintroduce a pointer-UV window.
- The gem's CAST is eight three-ray half-facet bundles on ONE receiver — the far-field
  mesh behind the UI. Filled controls occlude that plane; never duplicate the
  caustic in the full-stage pointer-light filter, which both invents a second
  receiver at the UI's depth and doubles the hottest fragment work.
  `projectMarkCaustic` alone traces and derives throw falloff,
  `packMarkCaustic` alone writes the bundles, and
  `renderer/caustic-shader.ts` alone reconstructs their bounded analytic
  footprints. The shader stays constant-cost: no generated sample grids,
  per-fragment loops, Gaussian kernel banks, negative shadow patch, or
  shader-authored bundle tints. Per-bundle RGB is allowed only when the CPU
  transport derives it from the entry/exit facet coatings and Fresnel energy.
  The eight primary bundles are traced at TWO wavelengths (the material
  dispersion band, diamond by default): the published corners are the mean
  trace and each carries its signed red−blue half-separation, so
  `causticDispersion` opens or closes the measured band while `causticDetail`
  changes concentration without changing sample count. After primary ranking,
  ONE partial-reflection branch may continue from the strongest complete
  bundle. The hard budget is therefore 8×3 primary + 1×3 secondary analytic
  footprints; never follow secondary rays for every candidate. Hero offscreen
  work is separately clocked and physically capped: backdrop at 30 Hz / 512 px,
  environment at 12 Hz / 256 px, and CPU caustic projection at 30 Hz; reduced
  motion renders those passes only on invalidation.
- The procedural far field (aurora, moving grid/scan and square stars) is HERO
  SCENERY only. Keep its compiled resources, but detach its fullscreen
  mesh after entry unless the retained crystal is at
  `ATOMA_MARK_ENV_MIN_SCALE` or larger. Ordinary app views have no replacement
  ambient grid. A pointer-lit compact crystal reuses that ONE receiver, clipped
  to its light bounds with scenery off; idle chrome detaches it and traces no
  caustics. Compact casts use minimum receiver display scale 4, including spectral offsets, to clear the shell; the hero spill stays off. Test visible pixels outside the crystal AND alpha coverage: zero-alpha RGB can survive headless captures but vanish in the desktop compositor. One camera sample serves every spill/corner; CPU casts stay at 30 Hz.
- The UI is `i18next` catalog-backed, including accessibility, crash and developer copy. Use flat `<key>_one` / `<key>_other` entries and call `<key>` with numeric `count`; never select suffixes or write `run(s)` / `entry(ies)`. Split multiple counts into independently pluralised fragments. The catalogs are JSON (`client/locales/*.json`), not TS literals: `en.json` is the source of truth, a blank or missing target value means "awaiting translation" (renders the EN fallback). Agents write EN only — never `fr.json` or any other target; the pre-commit hook blanks target values whose EN source changed and CI on main translates every target (`npm run i18n`, `scripts/i18n.mjs`). CI TRANSLATION IS ONE JOB OF THE `CI` WORKFLOW, not a separate workflow: one runner, one queue, no self-re-triggering push loop. Translation pins `gpt-5.6-sol`: local runs reuse `codex login` (ChatGPT Plus/Pro), while CI needs the separately billed `OPENAI_API_KEY`. A non-empty translation must carry exactly its EN `{{placeholder}}` signature (tests + `i18n check`); `i18n sync --locale=<code>` is an operator path without an API key, not an agent fill-in. TRANSLATION ISOLATES LOCALES: `translate` writes each catalog as its locale finishes, a failing language ends only itself — a sibling's success is never discarded (2026-08-27: ten `{}` catalogs after a zh failure). A REJECTED key gets one isolated retry, then survives as blank without failing the translate command; exit 1 there is for HARD failures. CI propagates those failures and runs `check --require-complete`: any remaining blank or missing target makes the job red. Ordinary `check` still accepts pending translations during development. Check/commit run `always()` to save partial work without masking failure (2026-09-14: exhausted API credits left 84 values untranslated in a green job under `continue-on-error`). `tests/i18n-pipeline.test.ts` pins the behaviour with a fake `codex` binary and the workflow's shape. BLANK IS ONE PREDICATE, and so are the placeholder signature and the pseudo-plural: all live in `scripts/i18n-predicates.mjs`, imported by the script and by `tests/locales-contract.test.ts`, because `translate` accepting `value.length > 0` where `check` demanded `value.trim()` wrote a whitespace-only value that no later pass could see — a permanently red job (2026-08-27) — and because the pseudo-plural rule lived only in the suite, `translate` committed `actif(s)` to main (2026-10-08). SEMANTIC DRIFT — a reworded EN value that keeps its placeholders — is invisible to `check` and `fix-drift` alike, so CI replays the hook's invalidation over the pushed range (`i18n invalidate-range --since=<sha>`, same code as `invalidate-staged`): the hook is skipped under `CI=true`, bypassed by `--no-verify`, and absent from the web editor.
- Push keeps a separate server catalog (never import the React catalog) but uses the same rules. English push copy is the explicit fallback until a target has reviewed copy; operator announcements are translated into every supported locale before sending.
- PWA/service-worker registration is production-default and dev-opt-in
  (`ATOMA_VIZ_SW_DEV=1` → `__ATOMA_SW_DEV__`). `serviceWorkerRegistrationAllowed()`
  in `client/pwa.ts` is the ONE answer, shared with the push prompt so an
  enable button never appears without a worker to attach to. The off state
  UNREGISTERS: the worker's scope is the ORIGIN, not the build, so a dev
  registration outlives its dev server and would control whatever is served on
  that port next — cleanup touches only a `/sw.js` registration and the
  `atoma-viz-` cache namespace, never a neighbour's. `isDevModuleGraph` keeps
  Vite's rewritten module URLs out of the shell cache. `/api/*`, `/auth/*`,
  `/webhooks/*`, and every response marked `Cache-Control: no-store` stay
  outside the cache so live data, identity state and GitHub deliveries cannot
  be hidden by an offline shell.
- The GPU production client checks content-hashed entry/CSS URLs every minute
  while visible and on focus/visibility return. Fetches use `no-store`, which
  the worker bypasses entirely: offline cache is never update evidence. A new
  build reloads only after five seconds without interaction, no editable work
  or pending API mutation, and outside settings, announcements, admin admission
  and tuning. Tab-local navigation is restored once for the same principal/org;
  no drafts or secrets are persisted. A failed/stale reload is rate-limited.
  Existing clients need one ordinary reload to acquire this updater. Back/Forward: `client-gl/navigation-history.ts` mirrors WHERE the viewer is (view, camera mode, selected project/run/atom/skill/docs theme) into session history — one entry per navigation, coalesced per microtask, the URL never changed (ids stay out of the address bar; a deep link is its own decision). A selection filled from nothing is a REPLACE (GpuApp's auto-select would otherwise make Back a no-op); scroll, filters and menus are not places. Entries carry the principal:organisation scope and are ignored under another.
- `vite-plugin-pwa` remains rejected: `devOptions` does not unregister workers,
  and `generateSW` cannot emit our push/click handlers. `injectManifest` would
  retain `sw.js` but add Workbox to the shipped bundle and change the build's
  tested publicDir-copy contract. Its update heuristic and navigation fallback
  hazards are already handled by our bypass list. Reconsider it for deliberate
  offline precaching: today's hand-written shell list caches hashed bundles
  only after successful fetches, never at install.
- Do not name a root client module `api.ts`; Vite's `/api` proxy can intercept it.
- ONE frame style, and ONE definition for the SINGLE-COLUMN views:
  `renderer/view-frame.ts`. Projects/Admin/Settings/Burn-in use its elevation-2
  `panel()`, title and `VIEW_FRAME_CONTENT_TOP`; the established split views
  (Registry/Skills/Docs/Runs) keep their own pane geometry. The app had grown
  two single-column conventions, one framed and one with a title floating at
  y = 78, so one product carried two ideas of what a surface is. The Projects
  form is the REFERENCE for a DOM overlay inside a column: its wrapper is
  transparent and the view draws its frame with the SAME `panel()` call as the
  project list below, so adjacent cards cannot disagree as the pointer moves.
  `.gpu-panel-skin`, the sole CSS restatement of `panel()`'s look, survives
  only on the overlays THE OVERLAY STACK entry grandfathers — a CSS-painted
  frame is out of the pointer light and over the hover bubble by construction.
  Do not add a per-form skin, and do not skin a new overlay at all.
- The app OPENS on Projects, the authenticated launch surface. Runs is where
  you go to watch what you started, which is a second step, not an arrival. The
  unroutable-view fallback lands on Projects too. On the ungated developer path
  project routes do not exist, so Projects shows its explanatory empty state
  and the DOM mutation form is absent.
- Handheld onboarding is required (owner reaffirmed 2026-10-02): crystal → Continue → white-out → mobile notice → Continue after two seconds → ordinary login/product entry. `isHandheldDevice()` (`client-gl/handheld.ts`) is the ONE pointer-capability predicate; `?atomaHandheld=1` rehearses it. Canvas and DOM entry share `useHandheldWhiteout`; the scene unmounts at white, reduced motion skips the animation, and acknowledgement persists in sessionStorage across OAuth/reloads. Before acknowledgement, neither a stored desktop entry nor a live device change may bypass the notice. Do not remove this journey as a “temporary disclaimer” or replace it with direct login without an explicit owner request. `viz:shot --handheld` proves the canvas path.
- The ADMIN PLANE is SIX views, one per job — Live runs, Organisations (`admin`), the
  platform journal, the catalogue ledger, the Sentinel, and Announcements —
  under one nav heading. It was one tab holding several: three questions on one
  screen, and one scroll position between them, so the journal could never page
  past its first page. `ADMIN_VIEWS` in `store.ts` is the one list and the rail
  reads it; each view's query is enabled on ITS OWN view. Announcements is the
  plane's only WRITE surface and is last for that reason. It draws a frame and
  nothing else: the composer is DOM filling the frame's content box, so unlike
  every other overlay here it has no GL content to reserve space against — the
  height contract is inverted, and the test pins the CSS box to
  `view-frame.ts`. It rode at the foot of the organisation list before, which
  put a broadcast composer under a screen nobody opens to broadcast and cost
  that list 260px on every visit.
- Live runs (`liveRuns`, `/api/admin/live-runs`) reads the transactional running
  set across organisations, including preparation before a trace exists. It
  polls only on its own view, audits foreign reads and exposes no host paths.
- The journal PAGES and FILTERS SERVER-SIDE. `nextBefore` is an exclusive
  `seq` cursor, so a page boundary can neither repeat nor skip a row; filters
  ride the query key, because filtering loaded pages client-side would THIN
  each page instead of finding more matching rows. Filters are two closed
  vocabularies: severity, and the kind's FAMILY
  (`PLATFORM_EVENT_FAMILIES`, derived from the kind list, never written twice).
  Live tailing polls only while ONE page is loaded — React Query refetches
  every loaded page. Reaching the bottom asks for the next page: the wheel
  handler is the only place that knows a view's scroll maximum, so it announces
  `scroll.end.<view>` through the ordinary activation channel and the handler
  is idempotent. The foot-of-list button is that page by keyboard.
- THE SERVER HOSTS THE MECHANICAL WATCH in-process whenever the auth gate is
  on: `npm run viz`, `viz:dev` and `viz:serve` are all this file, so one
  placement arms the development launcher and the release contract alike — a
  watch spawned beside `viz-dev.mjs` would have armed only the development
  path. It exists where the journal does, because de-duplication is against
  the journal and a watch with nowhere to write is theatre; the ungated path
  says so in the boot banner, and `npm run sentinel` is its watch. That banner
  line is also the answer to "one command for the whole stack": there is
  nothing else to launch, so there is no `npm run atoma` — and the MCP server
  could not join one anyway, spawned as it is by its client over stdio.
  `sentinelSources()` is shared with `/api/admin/sentinel`, so the screen
  describes the corpora the watch actually covers.
- The SENTINEL view may report the watch's health, and ONLY ITS OWN. That
  became sayable when the tick moved in-process; before, the honest answer was
  silence. The scope is stated on screen in every state rather than implied, a
  stale incumbent renders as an age and a timestamp instead of a red light, and
  an aggregate ("nothing is watching") stays forbidden — a sentinel on another
  machine or another store is invisible here. Still no control: a finding is a
  flag, never a judgment, and whether the sentinel may cancel a run is an open
  decision, so every button on that screen is a navigation. Coverage spans
  BOTH run corpora — see [`src/sentinel`](../sentinel/AGENTS.md).
- The Registry's ordinary one-store source is INFORMATION, not a selector:
  show its database basename and population, with the full path on hover.
  Repeated `--db` inputs turn that same row into measured, wrapping choices;
  no store may disappear behind a fixed slice.
- The agent detail pane names its sections. It showed the system prompt as one
  unlabelled monospace block and nothing else, while the payload already
  carried elements, parameters and provenance. Its header keeps the catalogue
  ordinal; elements retain both periodic metadata and their immutable call
  names; empty parameters say there is no type-level override; provenance
  names the latest archived change; and a bounded prompt preview says when it
  is incomplete. The USER INSTRUCTION comes BEFORE that prompt and has a
  heading but no body on purpose: it is composed per call from the task, the
  plan and injected skills, so it belongs to a run — the heading points at an
  LLM event in Runs rather than inventing a template nobody ever sent.
- A NAME WITHOUT A SNAPSHOT IS NOT DRAWN AS AN AGENT TYPE. `buildAtomMap`
  tags its placeholder (`AtomView.stub`) and Runs draws `atom-stub-detail.ts`:
  a run actor (`RUN_ACTORS`, [src/contracts](../contracts/AGENTS.md)) gets its
  role and its calls, models and verdicts in this run; an agent type the trace
  never snapshotted says so. Through the agent sheet, `run-root` read
  "L3 Tissue · #0 · v0" and "Created · ·" over an empty prompt (2026-10-06).
- The run-step detail pane is HIERARCHISED. Order is a PROJECTION ranked once
  in `client/structured-detail.ts` — verdict first, bulk last, eight ranks over
  a TYPE-derived default — so a new key lands mid-list. It sorts OBJECT entries
  before the `maxNodes` slice, never an array, and drops an entry with NO
  content (`stderr: ''`). `detail-layout.ts` packs adjacent fields up to THREE
  per row, at the narrowest count any MEASURES into: 2+2, not 3+1.
- Projects' Files explorer opens the newest retained delivered/partial lineage
  workspace, excluding comparison reruns. It labels the saved run and does not
  claim to be live GitHub. Folder/file navigation belongs to the shared GPU
  store and masked view, with a semantic twin. Files and result artifacts open
  the same Open File Viewer plane; the recorded-change diff remains separate.
  Where `workspaceSplit` (`workspace-browser.ts`, asked by renderer and GpuApp
  from the viewport width alone) fits both, a Files reader DOCKS beside the
  narrowed list — a transparent region over the view's `panel()`, scene left
  live, height from `--gpu-project-section-height` — so the next file is one
  canvas click in the same iframe; narrower, it stays the modal. Leaving the
  section, project or view clears `filePreview`, or it would reopen as a modal.
  All upstream format plugins are registered, with specialized decoders before
  text and the fallback last. Optional DWG/video decoders and PDF resources are
  packaged by the Vite asset adapter, including development. Viewer output
  lives in an iframe whose CSP forbids ALL scripts, with navigation sandboxed;
  the sandbox allows scripts only because Chrome otherwise suppresses canvas
  composition, even for trusted parent rendering. Tests prove CSP rejection.
  Remote images are limited to the GIS plugin's OpenStreetMap basemap.
  Generated HTML remains source text.
- Runs' Progress reader projects recorded branch lifecycles and tool receipts
  through `client-gl/run-activity.ts`, shared by GPU and accessibility views.
  Only successful `write_file`/`edit_file` receipts count as changed files;
  failed and unconfirmed attempts stay visible, and shell/compiled changes are
  not inferred. Branch closure is not approval. Edits are submitted excerpts,
  with merged/recovered receipts labelled, never a claimed repository diff.
  Render only the selected file's four-change page; the newest change opens
  by default and each change can collapse through the shared store. Show ALL
  recorded text, with no character/line cap. Cache alignment and measured row
  layout, bound alignment workspace, and draw only visible code inside the
  shared scroll pane. Source controls open the
  recorded event, full-width on a narrow viewport. The overview leads with
  saved files and explicit change links, then condenses activity to plan,
  changes and review. Counts describe recorded work, never approval. Keep the
  full brief in the selector; do not repeat it in the breadcrumb or step list.
  File excerpts use a split diff: before left, after right, one vertical
  scroll and aligned context lines. Wrap long code without ellipses, use the
  shared monospace stack, and label line numbers as excerpt-relative. An
  overwrite without prior content shows that absence, never invented removals.
- The timeline event card AND the run's two bookends are ONE LINE
  (`TIMELINE_ROW_HEIGHT` 40, card 30), shedding title > footer > actor > body
  as width runs out; a bookend's second line at `y + 28` drew outside its own
  cartouche. A `context` inject scrolls in the masked layer every other kind
  uses. `GPU_COLORS.muted` is a LEGIBILITY FLOOR for the 8–9px facts it is
  mostly spent on (~7.9:1) — do not lower it back.
- The nav is a LEFT RAIL (`renderer/views/sidebar.ts`), not a header tab strip.
  `visibleViews` remains the ONE definition of which tabs a viewer gets; the
  rail only groups them, and a test holds the group list to it so a new view
  cannot reach the nav ungrouped and silently vanish. Settings has no rail row
  on purpose — the account menu is its entrance, and a second one would put one
  job in two places.
- THE OVERLAY STACK IS FOUR LAYERS AND ONE LIGHT, in one fixed order:
  `ambientRoot` (far field) < `stage` — EVERY product surface: chrome, views,
  panels, overlay menus, and the layer THE POINTER LIGHT APPLIES TO — < (`lightRoot`, childless: on WebGPU with the far field detached it carries the light as a `blendRequired` filter over the light's reach alone, the same shading `stage`'s full-screen filter applies elsewhere, 2-3ms cheaper per lit frame; `?atomaLight=full` forces the latter)
  < `markRoot` (the retained crystal and avatar orbs, reached only through
  `retainAtomaMark`/`retainAvatarOrb`) < `tooltipRoot` (the one hover bubble;
  nothing ever mounts above it). A surface mounted above `stage` escapes the
  pointer light; one mounted above `tooltipRoot` buries the bubble a reader
  opened — the recurring hand-fixed z-order defect this entry retires
  (2026-08-28). DOM over the canvas is for INPUT the browser must own (fields,
  selects, links), on a TRANSPARENT wrapper with the frame drawn by the view
  (`panel()`, the Projects guide pattern): a DOM-painted frame has both defects
  at any z-index, because the canvas is one element. The CSS-framed overlays
  that predate this rule (`gpu-org-models-form`, `gpu-announce-form`, plus
  `gpu-scene-tuning`, a floating window) are grandfathered debts: migrate one
  with the Projects guide treatment, never add another. Settings is ONE tabbed DOM
  body; panels stay MOUNTED and `hidden` so a once-shown MCP token survives. `tests/viz-overlay-stack.test.ts` pins the
  mount order, the filter's home, the views' no-direct-`markRoot` rule and
  holds the skin list closed; `viz:smoke` remains the on-device proof.
- The renderer draws in two PIXI spaces. `stage` is the persistent scene root;
  `root` is the container the CURRENT pass draws into. Chrome (header, rail,
  overlays, account menu) draws into the stage, and each view draws into a
  viewport layer offset by `sidebarWidthForViewport(width)`. That layer is
  POSITIONED BEFORE the view draws, and the ordering is load-bearing: controls resolve
  their own screen geometry with `parent.toGlobal()`, sometimes lazily from a
  closure on a later pointer event. Reparenting a finished view left those
  closures holding the old ancestor — the tuning slider's drag then mapped the
  pointer against a track 208px from where it was drawn, and clamped to the
  range's end on first press. So views keep drawing from x = 0 and nothing
  shifts them afterwards. ONE face-on camera (`client-gl/scene-camera.ts`) drives Pixi's render transform and DOM's CSS matrix. The canvas cancels the outer CSS matrix: rasterise at final pixels, never upscale the bitmap or enlarge GPU targets. Scene/hit geometry stays in source space.
  Overview is identity; nav zooms to the compact rail, re-activation restores overview. The camera moves for a MODE change and NOTHING else: routing between two sections turns the CONTENT COLUMN like a box (`cube-turn.ts`, `CubeTurnPlane`, route from `navigation-intent.ts`) while the rail holds still — you navigate by the rail, and a camera pose or a whole-screen turn takes the destination you just clicked with it. Rail rows set the duration, the rail GROUP boundary sets the axis (swing within a group, tip across one). There is no cube: only the leaving and arriving faces exist and they are rebuilt per route, so six faces never bound the rail. The turn is CSS 3D on a wrapper ABOVE the camera plane, never camera yaw — the camera stays face-on inside the face, so Pixi's affine transform stays the exact homography the overlays and hit tests use. The arriving face is the LIVE canvas plus live DOM in one transformed subtree (forms keep state); the leaving one is a still from `captureSceneBitmap` PLUS a dead clone of the overlays it owned — React unmounts a view's forms the instant the route lands, so the clone is taken in `getSnapshotBeforeUpdate` (the only hook that runs BEFORE the mutation; a layout effect clones an already-empty plane) and is `inert`, `aria-hidden`, id-stripped, canvas-host-free, with typed values copied because `cloneNode` does not carry them (off-screen re-render through the live camera transform + readback at resolution 1, released at settle) and therefore carries no DOM. Both faces are CLIPPED to the column and hinge on ITS centre, and since the rail is inside the arriving face it is served for the turn by its OWN still, above both faces and never transformed. That still is RETAKEN every `CUBE_RAIL_REFRESH_MS`, never taken once: frozen, the crystal stopped turning and the pointer light stopped following for the length of the turn. A capture costs 0.33ms and 60fps holds at one a frame (measured on the compiled build), so the cadence bounds ALLOCATION — a screen of pixels each — not time. Its clip bleeds `CUBE_RAIL_BLEED_PX` past the boundary because the focused crop leaves the destination tile's right edge flush with the rail's, and a clip laid exactly there shaves the tile's stroke and selection glow; the bleed stays inside the column's gutter. Faces must be OPAQUE (`backgroundAlpha: 0` would show one through the other) and are ordered by depth, not `backface-visibility`, which cannot cull a wall parallel to the line of sight. The column boundary is PROJECTED through the live camera frame (the rail's width is a source measurement the focused crop shrinks), read from the scene plane INSIDE the face — `sceneCameraViewport` looks upwards. Canvas pointer input is suspended while it turns because the inverse hit test knows the camera, not the box; DOM overlays stay live. The light sweep shares the turn's duration. `SceneCameraPlane`
  rAF-interpolates ONE shared frame — NEVER a CSS transition — so CSS and inverse homography stay atomic. Pixi events, wheel routing, lights
  and diagnostics use that frame, not the transformed canvas' axis-aligned bounds. While it travels, author the view ONCE at maximum height and resize retained outer panels + mask from that frame; NEVER call `GpuRenderer.render()` per camera rAF — the one settle rebuild commits scroll layout at the already-matching height.
  `recordHitTarget` projects a target through its live parent with `toGlobal()` but
  leaves it in the final PIXI renderer plane; a real click additionally uses
  `projectRendererPoint`. Raw x/y must never enter `metrics.hitTargets`. `detailBounds` is translated once by
  the view offset because the wheel router compares its plain Rectangle with a
  camera-unprojected renderer position; a retained avatar orb sits on `markRoot`, so
  `retainAvatarOrb` resolves the caller's coordinates through `this.root` and
  keys the retention on the resolved pair. Any DOM overlay that sits over a
  VIEW is positioned from the `--gpu-sidebar` CSS variable, whose CSS clamp a
  test holds equal to `sidebarWidthForViewport`: overview shrinks 208px to a
  112px floor, and at or below `SIDEBAR_COMPACT_MAX_VIEWPORT` (431px, where that floor and the 320px content minimum no longer fit together) the rail is the 56px `sidebarCompactWidth` of centred icon tiles with no label column — a label with 20px to live in is an ellipsis, not a destination; focus preserves that source layout while the camera crops its trailing icon tile. The
  run search input is not one of them, it lives in the header band. With a
  Pixi overlay menu open, view DOM overlays stay mounted, render INERT
  (`inert`) and dim (`.gpu-overlays-veiled`): they sit above the canvas, so
  the veil also clip-paths a hole from `overlayMenuClip` or fields paint
  through the menu. Short viewports
  compact the rail, then drop group headings before they drop a destination.
  The accessibility bridge is visually clipped only at rest; `:focus-within`
  reveals it as a bounded command palette so keyboard focus is never invisible.
- A CANVAS CONTROL MUST BE REPRODUCED AND TESTED AS A CANVAS CONTROL. The DOM
  tablist is an accessibility mirror: clicking its `role="tab"` button proves
  neither Pixi's `pointertap` handler nor the active rail target that the user
  actually clicked. When a state transition belongs to both surfaces, put its
  signal in `store.ts` and let both surfaces consume that one state; do not
  route it through one-off React state or a callback bridge in `GpuApp`, which
  can pass a DOM test while the canvas path remains broken. A regression first
  drives the complete precondition (for example compose → review → send →
  receipt), then resolves the exact id from `__ATOMA_GPU__.hitTargets()` and
  mouse-clicks its projected centre in `viz:smoke`; assert the resulting UI,
  not merely that the activation callback fired. Finally verify from a fresh
  page or full scene rebuild: Fast Refresh can leave an already-created Pixi
  listener holding the pre-edit closure, so the current tab is not proof of
  the newly loaded path.
- Scene Tuning is a floating DOM window, not Runs content or a second canvas.
  Its toggle is the final control in the ADMIN rail, its pressed state is the
  window's visibility, and its DOM layer sits above view forms. Title-bar
  dragging clamps the complete window inside the viewport; slider values stay
  in the mutable live sample so pointer motion never rebuilds the GPU scene.
- The Projects collection is ONE DOM guide card above the GPU project list.
  A selected project opens **Continue this project**, with **Runs** in a
  separate tab; never stack the conversation above its run history. Keep the
  conversation mounted but hidden across section changes, preserving drafts
  and pending replies. The measured section controls wrap when needed and
  publish the same content top to the GPU and DOM. For a member the guide HOSTS the
  integrated conversation (`assistant` prop, owner 2026-10-09: it no longer
  replaces the screen, and a second card read as the assistant twice), with
  the external-agent path (connection notice, copyable request, MCP, GitHub,
  upstream) accessible from a `<details>`. Opening it uses the whole card;
  returning to the conversation preserves its draft. Never squeeze that guide
  into a small scroll strip below the composer. `projectsGuideLayoutHeight`
  gives the selected conversation all available viewport height; the collection
  reserves room for the project list. The renderer publishes that height to the DOM;
  `projectsGuideHeight` supplies the minimum and compact bands,
  with a shorter band for the guide or an empty conversation
  (`projectAssistantCompact`); an empty log reserves no history space.
  An empty conversation measures its natural DOM height, including wrapped
  controls, into `projectAssistantCompactHeight`; the GPU card and project
  rows use that same value. Fixed compact bands are the loading fallback and
  the external guide's height, not reserved blank space below an empty form.
  The "fold once MCP is connected" rule stops applying to the assistant.
  The model shares the guide heading and is read-only until Change model is
  pressed. The browser remembers the exact model/payer choice per principal
  and organisation, even before sending; a revoked choice never falls back
  to another payer. User, assistant and activity messages keep distinct rails.
  A viewer sees the guide alone, as before.
  The collection guide's toggle collapses the whole card, conversation included, and
  creating a project from it keeps the card open on the new project's page.
  Creation and launch require separate proposal confirmations. GitHub remains reachable when the organisation has
  no installation. A selected project's name owns the page title (`Project :
  <name>`) and is not repeated as an active row in its detail card.
  Re-clicking Projects in the rail returns to the full list; the accessible DOM
  mirror preserves the same toggle semantics. Projects must not auto-select
  the first project: that hid the full list and
  re-selected immediately after every deselect. Only the repair remains: a
  selection whose project is gone falls back to the first that exists. The
  GitHub access recovery offers installation settings in a new tab and Verify
  and continue (or publish), with an accessible twin. It resumes only a typed,
  host-recorded interruption, never inferring authority from error prose.
  The MCP guide has one explicit TS/CSS height contract for wide and narrow
  layouts; GPU rows start below it. Compact GL project and run rows stack
  status metadata below their full-width targets. A SELECTION IS A FILTER:
  one selected project draws that card alone. `projectHidden` is the one rule,
  read by both measuring and drawing, keeping `scrollMax` in sync. The guide
  remains a transparent DOM overlay above the canvas, with its frame drawn on
  the GPU.
- A selected project's OVERVIEW (`renderer/views/project-overview.ts`) is a right column beside Conversation and Runs where `projectAsideLayout` fits it, and heads the Runs list otherwise; the renderer publishes its reserve as `--gpu-project-aside` so the DOM conversation and its GPU card share one right edge. It aggregates the run list already fetched (`client-gl/project-overview.ts`), never a second request; the pie slices come from `runCostBreakdown` ([src/contracts](../contracts/AGENTS.md)), attributed by the PIN that served a call, and include Jev, which a run's LLM total does not — the column says so rather than reconciling the two figures.
- WIDTHS ARE MEASURED, NEVER ESTIMATED, and row copy stays single-line: a
  character count is not a geometry bound. `ctx.measureText`/`ctx.fitText` are
  the one source and `button()` fits every label through them, so views pass
  UNBOUNDED copy. A reserved column is measured from the copy the VISIBLE rows
  carry, floored, and ceilinged as a SHARE of the card — never a constant,
  which both steals width from its neighbour and under-serves itself. A run
  TOTAL renders in whole cents, not `fmtCost`'s four decimals, which price ONE
  LLM call. A row stacking a second line APPENDS it below a FIXED control.
  `chip-layout.ts` is deliberately Pixi-free so recordings test geometry with
  no renderer; it obeys this rule by INJECTION — a view passes `ctx.measureText`
  through the layout's `measure` option (bound to the face the chips draw
  with), and the per-character `gpuFilterButtonWidth*` estimates are the
  renderer-less FALLBACK only. An estimate must over-shoot to never clip, so
  it pads long labels unevenly; do not add a new chip surface on the fallback.
- There is no Launch tab in the GPU client. Projects offers the integrated
  assistant or an agent connected through Settings → MCP; both prepare goals
  and criteria for client approval. The assistant's transparent DOM conversation
  uses a GPU-drawn Projects panel. Its project-owned shared history is principal/org scoped,
  with version-bound confirmations and separately recorded model/payer usage.
  A project chat's model context is scoped by the conversation's saved project ID:
  filter catalogue metadata before serialization, omit organisation installation
  discovery, and read only that project's brief, readiness and runs. Organisation
  project discovery belongs only to the unbound new-project conversation.
  The person selects a connected personal subscription, organisation API key or
  explicit platform API model; an unavailable selection never changes payer.
  Its fixed context reads and confirmed writes use the existing HTTP MCP;
  see [contract and limits](../../docs/integrated-assistant.md).
  The `atoma_goal` MCP prompt and server tool guidance own the agent-facing
  instructions. `/api/goal-guidance` remains a read-only compatibility route;
  it has no browser launch power. The frozen MUI fallback keeps its own Launch
  tab because it has no Projects screen to use this flow.
- DOCS IS THE MEMBER FIELD GUIDE, not an index of implementation contracts or
  platform-admin surfaces. `docs-content.ts` is the structured source shared by
  the Pixi article and its semantic DOM twin; the former canvas is aria-hidden,
  so a topic or content block present in one must be present in both. Keep the
  guide limited to member-visible Projects/Runs workflows and current product
  boundaries. Member-facing MCP connection and briefing guidance belongs
  here; repository paths, shell commands, operator MCP internals, Registry,
  Skills, Burn-in and the admin plane belong in operator documentation.
  Topic changes reset `scrollY.docs`, and the narrow layout stacks the complete
  topic index above the article rather than squeezing or clipping either pane.
- `TraceRecorder.persist()` IS A WIRE CONTRACT for one reader outside this
  subsystem. It must keep emitting ONE top-level JSON object whose members are
  `VizRun`'s, because the projects control plane decides delivered-versus-failed
  from six of them through
  [`readTraceTopLevelFields`](../contracts/AGENTS.md) rather than by parsing the
  document — a trace grows ~19KB per tool call and a 512KB whole-file cap
  recorded a delivered run as failed. That reader depends on neither member
  ORDER nor INDENTATION, which is deliberate: a throttled partial flush already
  moves `totals` ahead of `endedAt`, so order was never stable. Changing the
  document to a stream of records, or nesting the terminal members, is a change
  to that contract.
- TWO hand-rolled JSON scanners now exist and they own different jobs: this
  subsystem's neighbour `src/atoms/json.ts` (`findBalancedEnd`,
  `repairPrematureClose`) repairs a whole model-authored STRING already in
  memory; `traceFields.ts` projects depth-1 members out of a FILE it must never
  hold. Neither may drift into the other's job — the second exists precisely
  because the first needs the whole document.
## Server and gated surfaces
- `benchmarkRuns.ts` admits `<runs-dir>/benchmarks/` only for platform admins
  or the ungated operator. Bounded receipts locate originals; reject escapes/symlinks, label campaign/question/arm, never create project rows.
- Operator source launchers (`npm run viz`, `doctor:dev`, `auth:dev`) fill
  unset keys from checkout `.env`. Do not load `.env` inside `src/viz/server.ts`:
  process-level tests spawn it from the repository cwd with a cleaned env.
- Behind the gate `/api/burnin` answers ONLY the platform admin (403 otherwise): an invitation
  must not read operator-level state (review 2026-08-20 §2.2). The admin also reads every
  organisation's projects and run traces, and manages organisations through
  `/api/admin/organisations` and `/api/admin/invitations` (same-origin POST); writes stay
  bound to the viewer's ACTIVE organisation for admins too. `visibleViews` is the one nav
  definition; the ungated developer path is unchanged. `/api/admin/settings`: run limits, [src/platform](../platform/AGENTS.md).
- The server FOLDS every configured store at startup (`openDb`); read-only handles never fold,
  and an unfoldable store is logged, never served as duplicates ([src/registry](../registry/AGENTS.md)).
- Registry and Skills are WORKSPACE destinations for every authenticated role (Registry since
  2026-09-15): ONE registry and ONE catalog for every run, so a member reads what their own
  runs earn on ([src/skills](../skills/AGENTS.md)). `/api/registries` and `/api/registry/:id`
  redact the store's host path for non-admins; `/api/skills` uses public namespace metadata.
  `/api/skills` also resolves an ABSORBED atom id through `atom_id_merges` to the kept
  namespace (chain-followed): the fold moves recipes under the kept identity while traces and
  bookmarks keep carrying the old one, so the typed boundary answers the historical URL —
  traces are never rewritten to do it (2026-09-18).
- A skill card is addressed by the event's OWNER pair (`l1AtomId`), never by
  `executorName` ([src/skills](../skills/AGENTS.md)); a body that will not load
  stays OUT of the global `error` and surfaces as `skillDetailFailed` in its own
  pane, as the project-route 404s and tray errors already do — a run cites the
  identities it saw, and one dangling reference never banners the graph.
- `/mcp` is the ONE MCP (contract in [src/mcp](../mcp/AGENTS.md)): OAuth or
  API bearer token behind the gate, the operator on the ungated loopback, Host
  pinned either way. `/api/tokens` mints (POST, same-origin, journaled
  `token.created`), lists (GET, secret-free) and revokes (DELETE, journaled
  `token.revoked`) the SESSION's principal's tokens for its ACTIVE
  organisation; the plaintext leaves the server once, in the POST response.
  `McpAccessPanel` leads with the URL, browser sign-in and authorized access.
  Client commands are selectable; config and manual tokens stay collapsed. An
  access with a non-null last-use date and no revocation hides setup by default;
  authorized access comes first, the URL stays visible, and a connect-another
  button reopens setup. Unused tokens alone never hide setup. A minted
  token opens its disclosure and is shown once, with copy and revoke. It
  resets when the active identity/org changes and never re-reads a secret.
  GET describes ungated operator access; mutations there return 409. A failed
  refresh preserves a newly minted secret for copying.
- `/api/account/subscriptions*` is self-scoped from the resolved session and
  never accepts a principal id. Status is secret-free; device login material
  is memory-only; connect/cancel/disconnect are same-origin and require
  `org:member+`. Settings connects Claude by a pasted `claude setup-token`
  token (beta, [src/auth](../auth/AGENTS.md)) and offers personal Codex models
  only while the server confirms the requester's private profile. Disconnect refuses an active run and never
  deletes another principal's generation.

## Web push

- Web push notifications exist only behind the viz auth gate. The VAPID
  keypair is generated once and persisted in the product store
  (`push_vapid_keys`); rotating it orphans every browser subscription.
  `ATOMA_VIZ_VAPID_SUBJECT` optionally overrides the JWT subject (default:
  the public origin). Subscriptions (`push_subscriptions`) are
  principal-scoped self-service rows behind same-origin `/api/push/*`
  POSTs; a 404/410 from the push service prunes the row.
  `src/viz/push/webpush.ts` is the ONE RFC 8291/8292 implementation
  (node:crypto only — no web-push dependency), pinned by the RFC 8291
  Appendix A known-answer test. Payloads are bounded and secret-free
  (status title, bounded excerpt, same-origin path — never trace prose).
  The browser permission ask lives in the FIRST LIVE RUN for members
  (`shouldOfferPushPrompt`), never in their login or signup flow — login
  stays zero-friction; the run is where the value shows. PLATFORM ADMINS
  are the one exception: push routes target them for a CURATED set of
  instance-wide platform events (not every run) whether or not they ever
  launch one, so an unsubscribed admin is an admin whose alerts go nowhere.
  Admins are asked on their first console entry after login and their
  "not now" is session-scoped
  (`pushPromptStorage`: sessionStorage for admins, localStorage for members)
  and cleared on logout (`clearSessionPushDismissal`), so each new login
  asks again until the browser permission itself settles. A permission
  already GRANTED shows no prompt by construction, so an admin in that
  state is silently re-subscribed at login instead
  (`shouldEnsureAdminSubscription`) — which also repairs a server row the
  push service pruned. The prompt follows the WORKER, not the build
  (`serviceWorkerRegistrationAllowed`), so it is silent in a dev session
  until that session opts the worker in. The subscriber's
  language rides the subscription (`locale` column, captured at subscribe
  time) because a push is generated from an event with no request left to
  read a header off; rendering uses the server-side frozen `PUSH_COPY`
  map in `src/viz/push/routes.ts`, never the client i18n catalog (a
  `.tsx` carrying a React provider must not reach the server).
  The worker logs whether `showNotification` was accepted or rejected with
  the notification tag only, never the title or body: DevTools diagnostics
  must be observable without copying operator or project text into a log. A CLICK opens the event's subject: the router writes it into the URL (`contracts/notificationLink.ts`: kind, org, project, run trace — ids only), the worker posts it to an open tab (never navigates it: the tab keeps its screen) or opens a window on it, and the app resolves it with `notificationTarget`, the tray's ONE rule, then strips it from the address bar.
- OPERATOR ANNOUNCEMENTS (`platform.announcement`) are the ONE push whose
  words a human writes, and the only route with an audience wider than an
  organisation. Two steps, and the split is the safety property:
  `/api/admin/announce/draft` proposes translations and sends NOTHING;
  `/api/admin/announce` delivers only text the admin read in EVERY
  supported language. That review is what keeps model prose out of the
  audit row (`src/platform/AGENTS.md`) — a translation an operator
  accepted is the operator's text — and out of a tray no one can undo.
  After delivery, re-activating the already-active Announcements destination
  returns the composer to its empty initial state; the same gesture while a
  draft is in progress preserves it. It follows the canvas-control method
  above: the reset signal lives in the shared GPU store, and the real-GPU smoke
  drives the active Pixi hit target after a complete stubbed send.
  `src/viz/push/translate.ts` is the announcement LLM call site (run titles are
  src/projects'): tier 1, built on first use so no deployment is asked for a credential it never
  needs, and returning `null` (never a partial draft) whenever the
  provider is absent or the reply unreadable — the form then asks the
  admin to write the other languages. The segment (`src/viz/push/
  segments.ts`) is resolved ONCE by the emitter against the projects
  store and journaled, so the router stays identity-only; `orgIds` absent
  means everyone, and an EMPTY list can never mean that. `orgCount`, not
  the id list, rides the row: `detail` is capped and the journal is
  fail-open, so an oversized row would lose the audit trail AND the push.
  The router refuses to deliver a push that renders no title. The composer
  is its own admin view (above), not a form at the foot of another.

## Public showcase

- With `ATOMA_PUBLIC_SHOWCASE=1` it IS the home page: a bare `/` from a visitor
  with no session (`servesShowcaseHome`; a query string means the shell, which
  reads `?authNotice=`/`?invite=`). Everyone else, and `/app`, get the app shell:
  the arrival gate and handheld notice stay the way in ("Sign in" links to
  `/app`). Stories are `/showcase/<run id>`; both send `no-store`, or the
  service worker would keep one as its offline `/`.
- It shows the DELIVERED runs, never a comparison rerun, a platform admin
  requested in an organisation they FOUNDED (its first member) and still OWN
  (`org:owner`), never a client organisation's, even one the admin joined as
  an owner (owner decision 2026-10-09), save a `showcase: hidden` project (set
  at creation, or later by an organisation admin; [src/projects](../projects/AGENTS.md#readers-outside-this-subsystem)).
  Flag and role are read per query, and the page reuses one read for
  `SHOWCASE_TTL_MS` (a minute of elapsed time), so a revocation leaves it
  within that. In such an organisation the Projects list tells owners, admins
  and platform admins, first on each card, whether the project is on it,
  eligible or hidden; members see nothing. A project of any other
  organisation carries no showcase field, so nobody sees a badge for it.
  Fail closed: opt-in, gate on, else
  404. One store query (`listShowcaseRuns`), an allow-list projection
  (`showcase.ts`): title, request, numbers, file NAMES, a text answer; never
  identities, paths, repositories or bytes. Server-rendered, all values
  escaped, one script pinned by hash in its CSP. English only.
- Categories follow delivered file formats, never words in the request. Software
  markers win over bundled assets; EPUB books win over WIF weaving patterns,
  then STL/3MF/STEP/STP models, then typefaces, then preview images. A BDF is a typeface;
  OTF/TTF only beside their sources (.glyphs, .designspace, .ufo, .sfd, .fea), since alone
  they are what reports and posters bundle. Ambiguous OBJ files and WOFF/WOFF2 establish nothing.
- The home feed starts from newest projects, but `showcasePage.ts` pulls the
  newest different kind forward after two cards of one kind. Within each
  kind, the order remains newest first. This keeps answers, reports and media
  visible near recent software without suggesting strict global chronology.
- Its crystals are the REAL Pixi mark (`showcase-mark.ts`, built alone by
  `vite.showcase.config.ts`: as a second app input it would leave the lazy
  renderer chunk), over a static SVG visible until its canvas is ready. Offscreen
  crystals wait until they approach the viewport. The versioned bundle is served
  with Brotli and an immutable cache lifetime. All built JS/CSS assets are
  precompressed once by `scripts/viz-build.mjs`; the server negotiates Brotli
  and keeps the original bytes as an identity fallback. ONE per
  page is lit: drawn over its `data-atoma-receiver` section, behind content, on
  `createFarField` (scenery off) so its light and caustics reach the background;
  the others snapshot and restore the page-global field light around each frame.

## Intentional choices and rejected shortcuts

- `vite-plugin-pwa`: rejected and restated here because it looks like the
  obvious answer every time. `devOptions` does not unregister workers,
  `generateSW` cannot emit our push/click handlers, and `injectManifest` would
  add Workbox to the shipped bundle and change the build's tested
  publicDir-copy contract. Reconsider it only for deliberate offline
  precaching.
- Filtering loaded pages client-side: refused. Filters ride the QUERY KEY,
  because filtering after the fact THINS each page instead of finding more
  matching rows — a list that empties as you refine it is a lie about the
  corpus.
- Writing the event-kind families a second time: refused.
  `PLATFORM_EVENT_FAMILIES` is derived from the kind list, so a new kind
  cannot acquire a family nobody chose.
- An aggregate "nothing is watching" indicator: forbidden. A sentinel on
  another machine or another store is invisible here, so the scope is stated
  on screen in every state, and a stale incumbent renders as an age and a
  timestamp rather than a red light. The panel still offers no control: a
  finding is a fact, not a button.
- Printing `v?` for an unknowable registry version: refused, the card omits it.
  `/api/runs` stays raw at the client reader for the same reason — a delta
  must rejoin the complete run BEFORE projection, or an earlier patch is
  invisible.
- A rail row for Settings: deliberately absent. The account menu is its
  entrance, and a second one would put one job in two places.
- Giving `chip-layout.ts` a Pixi dependency: refused. It stays renderer-free
  so recordings test geometry with no renderer, and it obeys the measurement
  rule by INJECTION — the view passes `ctx.measureText` through the layout's
  `measure` option.
- Showing a platform admin's runs in every organisation they belong to, or
  in every one they own: refused 2026-10-09. Every invitation, `org:owner`
  included, is minted by a platform admin or the host CLI, so an admin who
  joined a client organisation would publish that client's work under a
  `listed` default it never chose; founding the run's organisation, and still
  owning it, decides. Sending `showcase: null` for such a project is refused
  too: the client renders a badge for anything but an absent field.
- Authoring or repairing a target locale catalog by hand: refused for agents
  and humans alike. `en.json` is the source, a blank target means "awaiting
  translation", and CI fills it. A hand-written translation is a value no
  drift check can ever invalidate.
