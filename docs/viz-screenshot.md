# viz:shot — capture the GPU client for visual review

`npm run viz:shot` renders the real GPU client in headless Chrome and writes a
PNG. It exists so a UI change can be **seen** before it ships — the mocked test
suite proves geometry and contracts, but only a rendered frame shows spacing,
rhythm and colour the way a viewer meets them. It is a review tool, not a
release gate: nothing in `check` or `release:check` depends on it.

## Quick reference

```bash
npm run viz:shot                                    # anonymous visitor (login gate when auth is armed)
npm run viz:shot -- --auth                          # logged-in member, Projects MCP guide
npm run viz:shot -- --auth --assistant              # integrated conversation and approval card (stubbed)
npm run viz:shot -- --auth --assistant-reconnect    # missing connections and recovery controls (stubbed)
npm run viz:shot -- --auth --assistant-empty        # compact empty conversation before model selection
npm run viz:shot -- --auth --select-first --assistant-history --assistant-no-runs --camera overview # adaptive conversation height and speaker borders
npm run viz:shot -- --auth --select-first --assistant-history --assistant-scroll-probe # native chat wheel endpoints
npm run viz:shot -- --auth --assistant-model-probe  # remember an unsent model choice through a full reload
npm run viz:shot -- --auth --assistant-empty --assistant-own-agent # external guide and return to a preserved draft
npm run viz:shot -- --auth --select-first           # first project selected: conversation tab
npm run viz:shot -- --auth --select-first --assistant-read-runs # a start proposal that reads two earlier runs (stubbed)
npm run viz:shot -- --auth --select-first --assistant-history --project-tabs-probe # chat/run tabs, preserved draft
npm run viz:shot -- --url http://127.0.0.1:5187 --auth --select-first --assistant-links-probe # compact receipt buttons and their destinations on an isolated frontend
npm run viz:shot -- --auth --select-first --project-run-cards --readable-metrics # long run with millions of tokens
npm run viz:shot -- --auth --select-first --project-run-numbers --activate project.section.runs # numbered runs and the currently hosted version
npm run viz:shot -- --auth --select-first --project-run-cards # running/paused cards, also at --width 528
npm run viz:shot -- --auth --select-first --github-access # saved request awaiting GitHub authorization
npm run viz:shot -- --auth --select-first --github-access --github-access-probe # scroll and continue through the real canvas (stubbed response)
npm run viz:shot -- --auth --view Runs              # any nav tab by its label
npm run viz:shot -- --auth --view Runs --timeline-probe # hover preview and canvas navigation through the mini timeline
npm run viz:shot -- --auth --view Runs --branch-heading-probe # inherited brief: phase and execution headings through canvas clicks
npm run viz:shot -- --auth --view Runs --activate run.filter.branch.p1 # click a canvas target before capture; comma-separate IDs for a sequence
npm run viz:shot -- --auth --view Runs --event-participants-probe # tiered initiator/target controls and atom navigation
npm run viz:shot -- --auth --view Runs --planning-detail-probe # task and plan first; readable skill and raw context toggle
npm run viz:shot -- --auth --view Runs --recorded-run /path/to/evidence.json --detail-gallery /path/to/captures # local replay of saved MCP events
npm run viz:shot -- --auth --view Runs --skill-context-probe # readable skill recipe and recorded-context toggle through canvas clicks
npm run viz:shot -- --auth --view Runs --run-picker-probe # project-scoped search, counts and canvas selection
npm run viz:shot -- --auth --view Runs --result     # final answer, copy and download controls
npm run viz:shot -- --auth --view Runs --back-probe # Back to project, clicked on the canvas, lands on its Runs section
npm run viz:shot -- --auth --view Runs --preview-ready # a running app preview: open and stop end the action row
npm run viz:shot -- --auth --view Runs --result-artwork # saved SVG files, summary and collapsed technical evidence
npm run viz:shot -- --auth --view Runs --activity   # recorded steps and changed files
npm run viz:shot -- --auth --view Runs --activity-file app.js # bounded recorded edits
npm run viz:shot -- --auth --select-first --result  # same result reader inside the project
npm run viz:shot -- --auth --select-first --assistant-empty --overview-probe # overview column: slice bubble kept in the column, then folded (-hover/-folded PNGs)
npm run viz:shot -- --auth --select-first --files-probe # Files: reader docked beside the list, two files by canvas clicks
npm run viz:shot -- --auth --select-first --files-probe --width 900 # too narrow to dock: the modal reader
npm run viz:shot -- --auth --view Skills --select-first # member reads a shared recipe
npm run viz:shot -- --auth --view Registry --select-first # member reads a shared agent type
npm run viz:shot -- --auth --account-menu           # the account menu, open on the orb
npm run viz:shot -- --auth --appearance amethyst --theme-menu # selected theme and its choices
npm run viz:shot -- --auth --appearance amethyst --appearance-reveal-ms 1200 --out /tmp/theme-reveal.png # midpoint of the colour reveal
npm run viz:shot -- --auth --view Settings          # account menu, not a rail tab
npm run viz:shot -- --auth --platform-admin --view Settings --settings-tab limits # platform budgets
npm run viz:shot -- --auth --platform-admin --view "Platform" --platform-stats-probe # period controls and accessible daily data
npm run viz:shot -- --auth --platform-admin --view "Live runs" --live-runs-probe # cross-org list, canvas follow and live refresh
npm run viz:shot -- --auth --platform-admin --view Sentinel --activate sentinel.section.assayer,assayer.open.assay-demo # a Sentinel tab, an evaluation opened in place
npm run viz:shot -- --auth --view Settings --scroll-end  # org directory at the foot of the form
npm run viz:shot -- --auth --camera overview        # neutral, undeformed whole-scene pose
npm run viz:shot -- --auth --camera focus           # content-column pose (default)
npm run viz:shot -- --auth --tuning                  # open the floating Scene Tuning window
npm run viz:shot -- --out /tmp/before.png           # explicit destination
npm run viz:shot -- --auth --select-first --hold /api/assistant # leave a stubbed path unanswered: its loading notice stays on screen
npm run viz:shot -- --url http://127.0.0.1:5173     # attach to a dev stack already running
npm run viz:shot -- --debug                         # page console + failed requests on stderr
npm run viz:shot -- --width 528 --height 800        # narrow/compact layouts
npm run viz:shot -- --auth --select-first --touch-probe  # native mobile swipe regression
npm run viz:shot -- --handheld                      # phone: notice, acknowledgement, then login
npm run viz:shot -- --login-gate                    # anonymous gated arrival with the legal links (whoami stubbed)
```

PNGs default to `screenshots/<view>-<auth-mode>-<camera>.png` (git-ignored). Viewport
defaults to 1600×900 at deviceScaleFactor 2.

`--assistant-empty` checks that the empty hint sits next to the composer and
the external-agent entry remains in the card. `--assistant-own-agent` checks
that the opened guide has a usable height and that returning to the chat
preserves the draft. Combine either with `--width 528` for the narrow layout.
`--project-tabs-probe` clicks the Conversation and Runs canvas tabs, checks
that run cards appear only under Runs and that the draft survives the switch.
It saves the Runs view beside the conversation image with a `-runs` suffix.

`--touch-probe` requires `--auth --select-first` on Projects. It resizes to
390×600, checks the compact rail, and sends native Chrome touch events over a
run row. The list must move without opening the run. The captured image shows
the result after scrolling. Use `--camera overview` or `--camera focus` to
exercise either camera pose. The same probe is part of `viz:smoke`.

## What each mode renders

`--recorded-run` accepts a saved object with `runId`, `capturedAt`, `summaries`
(paged MCP trace summaries) and full `events` read through the MCP's event
reader. Optional `goal` and `projectId` preserve the run context. It replays
only these saved bytes, with absent API data returning 404 rather than reading
the local store. `--detail-gallery` selects each event, resets its disclosure
through the normal store action, and saves its right-hand pane plus an
event-ID manifest. This is a source-development replay, not a new run or a
claim of live verification; no recorded command is executed.

- **No flags** — whatever an anonymous browser gets. With the checkout `.env`
  arming the auth gate (the usual state here) that is the **login gate**, and
  the script says so instead of failing. With auth off it enters the app and
  opens the requested view.
- **`--auth`** — a logged-in org member **without any real OAuth session**:
  `/auth/whoami`, `/api/org`, `/api/org/models`, `/api/org/mcp-servers`, `/api/projects`, the run list,
  `/api/goal-guidance`, `/api/account/models` and `/api/github/installations` are
  stubbed via Puppeteer request interception (the same technique as
  `viz-gpu-smoke`'s account arm). Settings is not a rail tab: `--view Settings`
  opens the a11y account menu and clicks the Settings item. The fixture is one
  project with five runs covering delivered
  (+ commit receipt), failed (+ error line) and cost display. `/api/runs` and
  its trace are stubbed too, so `--view Runs` renders a full run: summary card
  with the metric tiles, branch filter chips, and a two-phase forked timeline.
- **`--handheld`** — emulates a phone (390×844, DPR 3, native touch). Captures
  `<out>-gate.png` and taps the real canvas Continue. The white-out unmounts
  the scene and shows the mobile notice (`<out>-notice.png`); Continue appears
  after two seconds. Acknowledgement survives a full reload. Anonymous entry
  then reaches the OAuth route (intercepted before external sign-in); with
  `--auth`, entry reaches the MCP guide and writes `<out>-projects.png`.
  The pointer-capability media query must match.
- **`--select-first`** — clicks the first project row through the canvas hit
  targets (`?atomaDiag=1`), opening **Continue this project**. Run-oriented
  probes select **Runs** before exercising its controls.
  Opening a project focuses the content and compacts the left rail, including
  when the capture starts with `--camera overview`.
- **`--scroll-end`** — Settings only: scrolls `.gpu-org-models-form` to its
  end so the organisation directory (below the keys) is in frame.
- **`--camera overview|focus`** — captures either endpoint of the global scene
  camera. Overview re-activates the selected menu after navigation, exercising
  the same return transition as the product and restoring the exact undeformed
  scene; focus is the compact icon rail + content-column pose and is the default.

## Caustic tuning

The Scene Tuning window keeps the crystal's caustic structure separate from
its colour dispersion:

- **Caustic detail** controls filament sharpness and the asymmetric fourth
  fold. At `0×` the broader three-fold reconstruction remains and the fourth
  fold is skipped; `1×` is the shipped look; values above it tighten the
  filaments and strengthen the additional fold.
- **Caustic dispersion** controls only the distance between the traced red and
  blue wavelengths. `0×` collapses both onto the mean trace, `1×` preserves
  the measured diamond band, and `2×` doubles its visible separation.

Both controls are live uniforms shared by the far-field and pointer-light
surfaces. Moving either slider must not rebuild the Pixi scene.

## How it works, and its sharp edges

- With no `--url` it spawns `scripts/viz-dev.mjs` (source path, no build) on
  two freshly reserved ports and tears it down afterwards. The two ports are
  reserved **simultaneously** — two sequential `listen(0)` calls can return the
  same port.
- The arrival gate is passed through the a11y bridge; `atoma.viz.entered` is
  cleared first so the capture is always a fresh visitor.
- Every un-stubbed `/api/*` call in `--auth` mode still reaches the real dev
  server, which answers 401 when the gate is armed. A 401 on a route the
  client treats as session loss causes a **reload loop** — the symptom is a
  timeout with an empty `#root`. If a capture starts timing out after new API
  routes are added to the client, run `--debug`, look for `[http 401]`, and add
  the route to `gatedStubs()` in `scripts/viz-screenshot.mjs`.
- The interception handler must never throw: an interception left neither
  responded nor continued hangs its request forever, which presents as the
  same empty-page timeout.

## Reviewing a change

Capture before and after on the same flags and compare:

```bash
git stash && npm run viz:shot -- --auth --select-first --out screenshots/before.png && git stash pop
npm run viz:shot -- --auth --select-first --out screenshots/after.png
```

For layout work also capture a narrow viewport (`--width 528`) — the compact
project rows and the stacked MCP guide have their own geometry.

Project deployment settings: `npm run viz:shot -- --auth --select-first --project-settings`.


### Responsive UI matrix

`npm run viz:shot -- --auth --platform-admin --view Settings --ui-matrix /tmp/atoma-settings`
captures the selected fixture state at 390, 528, 768, 1024, 1440 and 1920 pixels
in both camera positions, plus the five themes and French, Arabic and German.
The JSON manifest records dimensions, theme, language and overflow checks.
It waits for the camera, palette and retained crystal to settle. This mode only
supports a local source server; use `--url` to share one running dev stack.
API mutations remain local fixtures. Screenshots are evidence of the recorded
state, not proof of every possible content length or permission combination.
