# Property scraping priority — 2026-10-14

The owner explicitly put Spitogatos aside for now and requested continued
work on scraping xe.gr. Do not resume Spitogatos access experiments unless
the owner asks. Preserve its existing code, captures, and investigation notes.

## Development workflow — owner clarification, 2026-10-14

Advance the real-estate software through Atoma project runs. The exercise has
two simultaneous goals: build the Greek real-estate product and improve Atoma
through real usage. Codex should scope the next run, inspect its evidence and
deliverables, and fix demonstrated Atoma defects with regression coverage.
Do not routinely implement product features directly in the collector repository
instead of letting Atoma build them. Direct work already done in PR #1 is a
starting baseline, not the preferred workflow for subsequent features.
This workflow is confirmed in production project context version 4, decision
`4a597731-cd42-483b-9231-c0a719adaedb`.

Collector repository: https://github.com/mgtf/atoma-attica-property-flipping
Atoma project: `07864f7c-d8f2-4023-9fca-afd8a7a51e52`.
The previous investigation recorded 27 xe.gr listings already collected.
Check current code and production records before treating that count as current.

The priority is also confirmed in production project context version 2,
decision `9992bb2b-7163-42ee-a3bf-04cd3be03e04`.

## xe.gr live collection, 2026-10-14

Direct HTTP access works from both the Mac and atoma.run. The new bounded
`collect-xe-live.js` fetched three pages on atoma.run at 05:06:38–05:06:52 UTC:
102 unique SALE/APARTMENT listings, all HTTP 200, no rejected rows or duplicates.
Scope is Central Athens, not all Attica. No browser or VPN is needed for this
measured path; no scheduler was enabled. Requests are spaced by five seconds.
Source descriptions and structured features are included; relative publication
dates stay raw, and listing detail pages were not fetched.

Code and captured batch are in collector checkout `/private/tmp/atoma-attica-fixes`
(branch `codex/xe-live-collection`), batch `data/xe-live-2026-10-14/`.
The server pilot is `/tmp/xe-live-20261014-0515/batch`.
Five test scripts pass, including historical replay and Spitogatos preservation.
All 102 CSV/JSONL rows and three archived-response SHA-256 pairs were checked.
100 of 102 listings have a source description; two remain empty.
Saved to GitHub commit `3b5eeb02867431bde0edc40acdd3b4c59f7d3d0c`,
PR https://github.com/mgtf/atoma-attica-property-flipping/pull/1 merged by Codex
with explicit owner approval at 2026-10-14 05:22:08 UTC,
main commit `6ded9c44c3d04a8bd7fedf5c33846846f9a9a250`.
Collector checkout is clean and HEAD equals origin/codex/xe-live-collection.

## Atoma iteration after PR #1

Owner explicitly authorized Codex to merge PR #1 and continue the product via
Atoma. Started run `4a88c0af-cfef-4f41-840a-39da163e9b20` at
2026-10-14 05:23 UTC, idempotency key `xe-configurable-regions-types-20261014-v1`.
Approved scope: configurable zones/categories; bounded current collection for
two Attica sectors and apartments/houses, deduplication across searches,
CSV/JSONL and captured evidence, regression tests, preserved existing batches.
The run uses automatic GitHub reconciliation (no explicit baseRunId, which would
skip refresh) and names merged main `6ded9c44c3d04a8bd7fedf5c33846846f9a9a250`.

Observed startup gap: no trace or readable run.log until first trace event at
05:28:41 UTC (~5m31 after admission). SSH confirmed the child and Haystack Python
were active; no separate collection was launched. `spawnRun` retained output
only in memory until settlement. Fix in `src/cli/burnin.ts` makes the log readable
as chunks arrive, retaining the full final write and best-effort I/O semantics.
A real-child regression in `tests/burnin.test.ts` checks startup output before
the child may exit. Both burnin suites (28 tests), scoped ESLint and both
TypeScript configs passed. This does not yet optimize Haystack startup cost.

The log fix is commit `403c09f1e4b026392cf7f5fd1a3627158f1714f7`, pushed to
main after the owner's explicit confirmation of this publication. CI:
https://github.com/atoma-run/atoma/actions/runs/38517332772 (pending when read).

The Atoma run's first xe.gr request at 05:30:12 UTC received HTTP 403 with an
explicit CAPTCHA (CloudFront, FRA56-P14). It correctly stopped after one
request; three other requested searches remained unattempted. The earlier
direct collector's HTTP 200 is historical evidence, not proof access remains
available. The tool and direct collector use Node fetch with matching supplied
Accept/User-Agent headers. The worker's isolation proxy tunnels HTTPS without
rewriting it; the cause of the different outcome is unproven. Do not retry the
blocked source blindly or bypass the challenge. Trace event:
`9d4ca2d5-6082-4a57-94fe-15ff4292cce4`.

The first root acceptance check rejected the incomplete implementation (only
2/6 criteria met, notably missing cross-search deduplication tests). Atoma
started an internal repair using existing captures and offline tests, retaining
the stop after the challenge. Await the final artifact review before treating
this iteration as complete or publishing it.

Run `4a88c0af` ended partial after 835 seconds, one internal repair, no new
listings. Manual artifact review found `collect()` discards `loadLiveConfig()`'s
return value and still uses constant Central Athens/APARTMENT/5000 ms. The new
pagination/budget/dedup helpers are unused by collection; helper tests pass
without proving integration. A local network-free reproduction in
`/private/tmp/xe-review-JRHoQG/reproduce-config.cjs` confirms a synthetic
north/south configuration with 9000 ms still requests Central Athens at 5000 ms.
The run remains unaccepted/unpublished. A corrective short Atoma run was
started from that exact partial workspace with idempotency key
`xe-wire-config-offline-20261014-v1`: wire configuration into the real collect/CLI
path, preserve every provenance observation, add integration tests, make no
external requests, and preserve the original capture timestamps and batches.
Corrective run ID: `c50f3566-b08c-4b7b-8269-9a027b27f2e0`, admitted at
05:40:15 UTC. The second startup also exceeded five minutes before any trace.
Code inspection: retrieval-haystack.py's init embeds the selected documents on
CPU in the run-owned process; latency optimization remains open, not fixed by
the logging change. Do not confuse a deploy workflow's headSha with the
artifact it activated: workflow 38517645747 showed head 403c09f1 but activated
the prior CI artifact 15dd953a. Check the host release receipt/path.

Corrective run c50f3566 delivered with 6/6 criteria, modifying only four files.
Its xe-live test suite also passed locally. Independent review still reproduced
two defects in `/private/tmp/xe-final-review-GqLBEO/review-edge-cases.cjs`:
budget exhaustion reports complete and counts one uncalled search as attempted;
configured `legacy:true` lets an arbitrary startUrl bypass scope validation.
A final narrow offline Atoma correction is requested with idempotency key
`xe-budget-scope-review-fixes-20261014-v1`, based on c50f3566. No artifact has
been accepted or published yet. Logs fix CI 38517332772 passed; production
now runs deb31f2e (contains 403c09f1; another task added its analyst CLI fix).

Final narrow run `66aed165-4526-4deb-b4c2-c9e7b1cdf3cc` started at 06:00:57 UTC
after the post-mortem analyst released admission (earlier busy responses did
not create runs). The new live-log behavior is confirmed through the production
MCP: a 6,919-character runner log was readable during preparation, before the
first trace, on this run. This closes the demonstrated observability defect;
embedding latency itself remains unchanged.

Run 66aed165 ended partial: the independent offline review now passes budget
exhaustion, empty page, already-consumed discovery budget, global bounded
coverage, and legacy startUrl rejection before any call. Atoma's final review
still refused c3 because the variation query parameter can contradict category.
A narrowly scoped continuation is prepared with key
`xe-query-variation-consistency-20261014-v1`. Preserve the historical observed
variation `poliseis-diamerismaton`; it is not the export label `appartements`.
That continuation is run `7ab2c661-31e5-4da1-96d3-65c11622ce74`, admitted at
06:16:41 UTC. Prior accepted-reference run is unchanged: client acceptance and
GitHub publication have not happened for any of these new product iterations.

Run 7ab2c661 delivered with 3/3 final criteria and manifest hash
`4c2ec0f930d6f8327fba3405621fe250da192e71b36b449e0de72c171c3edcf9`.
The HTTP `variation` is explicit per configured search, separate from the
export `categorySlug`; one URL validator checks departure and pagination.
Local verification in `/private/tmp/xe-final-review-GqLBEO` passed the delivered
xe-live suite plus independent regressions for budget exhaustion after an empty
page, discovery-consumed budget, global partial coverage, first/last invalid
configured URLs and contradictory variations. Comparing saved manifests with
the first iteration shows only README, collect-xe-live, collectors/xe and
tests/xe-live changed; 64 other files including all data stayed unchanged.
The owner was asked to accept this reviewed delivery for Atoma publication and
merge of its resulting PR; publication must wait for that answer. The new
configurable real capture is still blocked; there are 102 retained real rows,
not newly collected rows from these Atoma iterations.

## Accepted and published — 2026-10-14 06:32 UTC

The owner answered "oui" to publication and merge of the reviewed final delivery.
Atoma accepted run `7ab2c661-31e5-4da1-96d3-65c11622ce74` with the manifest hash
above and published commit `a38c86e3fca7e3fac469ef20523eb27936e2a46d` directly
to `main` under the project's existing direct-publication policy. No new PR was
created or needed; PR #1 was already merged. Git fetch confirmed that exact
remote main SHA. The accepted reference now points to this run.

A fresh archive of published main in `/private/tmp/xe-published-review-a38c86e`
matched all 68 accepted manifest hashes. All six offline test scripts passed on
that archive; GitHub reports no check runs for this commit. The original 102-row
live batch, historical listing CSV/JSONL, and Spitogatos browser captures are
byte-identical to PR #1's main. The full publication also carries inherited
Spitogatos files and historical replay metadata from the seeded workspace;
the three historical metadata files differ only in batchId/exportedAt from
PR #1. No new Spitogatos collection was performed. Diff whitespace checking
reports two inherited whitespace lines (collect-spitogatos and the diagnostic
report); do not claim a clean diff check. Expanded xe.gr live access remains
blocked by the recorded CAPTCHA; no additional real rows were collected.

## Local Docker pilot approved — 2026-10-14

The owner proposed running Atoma-produced applications in Docker on their own
Mac and approved trying it. Start with the xe.gr application as the concrete
pilot, then use measured results to inform an Atoma local deployment mechanism.
Docker Desktop 4.58.1 / Engine 29.1.5 is running locally on arm64 using
desktop-linux. Do not treat Docker networking as a guarantee of CAPTCHA-free
access. No permanent cloud-to-host control service or Docker socket exposure
is authorized by this small initial pilot.

Atoma run `f2522b78-8e26-4aba-b06e-d4883160ec35`, key
`xe-local-docker-pilot-20261014-v1`, started at 06:47:19 UTC from published
main. It packages the existing collector for Node 24 Docker, safe help/offline
verification, explicit one-page live mode, dedicated persistent output and
user documentation. No external source requests occur in the Atoma run;
actual Docker execution and the bounded live trial happen on this Mac after
artifact review. Preserve all existing data and Spitogatos files.

The local one-page pilot SUCCEEDED at 06:53:08–06:53:10 UTC: HTTP 200,
34 unique rows, one request, page_limit. All 34 IDs already exist in the
historical 102-row batch; this is a fresh observation, not 34 additional IDs.
CSV/JSONL counts and compressed/decoded response hashes verified. Output:
`/Users/mgtf/Atoma/attica-property-flipping/data/xe-local-2026-10-14-pilot`.
Retained stopped container: `atoma-xe-local-pilot-20261014`, exit 0,
user 501:20, root read-only, read-only code and one persistent /output mount.
This used accepted collector a38c86e on official Node 24 Docker index digest
`sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
All six offline suites also passed with network none and /tmp tmpfs.

Run f2522b78 produced three packaging files and README; all 67 other files
unchanged. It finished partial because the worker could not perform a Docker
build/runtime proof (the caller had explicitly reserved that verification).
Local image `atoma-xe-pilot:f2522b78` builds, but the documented offline launch
fails EROFS at mkdtemp: missing writable /tmp. Adding bounded tmpfs locally
fixes it. Review also found missing build-context exclusions, version-label-only
update instructions and --rm conflicting with retained logs. Corrective Atoma
run `d49796f8-b95a-4eb0-8dff-464b11dfc6dd`, key
`xe-local-docker-runtime-fixes-20261014-v1`, started 06:59:46 UTC, based on
f2522b78. It must fix packaging/docs only, preserving historical files and
making no external requests. No publication acceptance has been requested.

### Reusable local installation verified — 2026-10-14 07:16 UTC

Corrective run d49796f8 delivered 4/4 criteria; manifest hash
`46faa077d7e0aca9ff98af2dee9fa13a232a9882d2831b92fb2944826a15437d`.
Compared with accepted 7ab2c661: four added packaging files, README modified,
67 unchanged, no removals. Installed exact 72-file snapshot at
`/Users/mgtf/Atoma/attica-property-flipping/releases/d49796f8`; `current` points
there. A local .env (excluded from the Docker build) supplies APP_VERSION,
uid 501, gid 20 and the absolute persistent data directory. This installation
is a pilot, not a connected Atoma local-device service or a published release.

Built ARM64 image `xe-collector:atoma-d49796f8`, image id
`sha256:4f85bd8755a3edc4723ff4a6b23fb6904c75ab82d6f98eca761e8f99f0631f8d`.
Default help and all six offline scripts passed with network none, non-root,
read-only root and 64 MiB /tmp tmpfs. An independent entrypoint fixture check
proved distinct persistent output paths, repeated 34-row archived replay and
403 exit 1 without network; fixture outputs stay in /private/tmp, separate
from real data. Docker Compose help also passed using the installed .env.
AMD64 runtime was not tested. Retained stopped offline container:
`atoma-xe-offline-d49796f8`. Live pilot container also remains stopped.

Evidence and deployment identity are in the local `receipts/local-pilot.json`,
`receipts/d49796f8-manifest.json`, `receipts/d49796f8-offline.log`, and the
independent entrypoint proof script. Exactly one live xe.gr request was made
on this Mac; later final-image verification was offline. Do not claim the
corrected image performed another live capture or permanent CAPTCHA resolution.
No new Atoma engine changes, publication acceptance, GitHub push, scheduler,
background application, or permanent device-control connection in this turn.

## Human CAPTCHA handoff — owner requirement, 2026-10-14

The owner corrected the proposed end-client flow: when xe.gr presents a CAPTCHA,
pause collection and show the actual challenge so the client can complete it
manually, then resume when the site grants access. Preserve progress and use
the same local browser session for verification and collection; a separate
unrelated browser window or a client "done" click alone does not establish
restored access. Keep data and remain paused on cancellation/continued blocking.
This requires an interactive browser path beyond the current HTTP-only pilot;
it is a recorded product requirement, not yet implemented or tested. Other
access refusals retain their stops. No automated CAPTCHA solving was requested.
Production project context v6 confirms decision
`5fa7a47a-fce6-4f61-bc01-2d058f72c9b1`; Spitogatos remains paused.

Owner said "Continuons donc" after confirming human CAPTCHA handoff.
Started deep Atoma run `a7c3ef40-bf42-439c-9cbd-ddf6fd1ace27` at
2026-10-14 07:24:27 UTC, key `xe-local-human-captcha-handoff-20261014-v1`,
explicitly based on locally verified (not GitHub-published) d49796f8.
Scope: opt-in interactive browser Docker mode with a local control UI,
same-session manual challenge completion, pause/checkpoint/resume/cancel,
local profile isolation and a loopback fixture demo. No external xe.gr or
Spitogatos requests in the Atoma run. Verify fixture interaction and actual
ARM64 Docker locally after delivery; do not solve real CAPTCHAs automatically.
Preserve the existing lightweight HTTP CLI and all historic data. This does
not yet add the general Atoma device-pairing/remote-control companion.

This run exposed a separate Atoma false refusal: `record_probe` treated
`node --check browser/control-server.js` as executing the server it only parses
(trace events 05557be5 and 6a3a5eab). Fixed in commit `3e9f35ca`:
recognize a literal leading Node --check/-c with exactly one file, independently
per shell clause. Real later servers, trailing script flags and preload clauses
remain refused. Production-path record-probe suite: 62 passing tests, both
TypeScript configs, scoped ESLint and docs checks pass. Another task published
descendant `9b54ac14`; CI 38530437018 was still running at 07:48 UTC.
Do not claim deployment until its receipt is checked. The product run itself
was refused at root for fake-session rather than actual browser evidence and
is performing its internal repair; final local acceptance is still pending.

Run a7c3ef40 finished partial after 2,797.54 s (5/6 criteria, $1.2475 reported),
manifest `25cf649f4827a4926747843d1eea9957db34690fbce8f692a89ab3c555f4c732`.
Saved comparison to d49796f8: 71 unchanged originals, README modified, 223 added.
All historical data/evidence are unchanged. Caller independently ran all six
original offline scripts in network-none ARM64 Docker successfully. The root
refusal's missing baseline and invented access-replay TypeError are therefore
not demonstrated regressions in those files.

Independent source review found actual defects missed by Atoma's 5/6 verdict:
the browser collector rejects every non-fixture URL; Docker ignore excludes
required session.js modules; control binds only container loopback; Origin
comparison ignores ports; cancellation only works paused; progress is not
checkpointed per page; the old Playwright 1.48.2 dependency has a high audit
finding. Saved manifest also contains 201 .local-browser runtime/profile files.
Those private generated files were NOT downloaded or published. The 94 source
and original-data files alone were materialized/hash-verified at
`/private/tmp/xe-browser-review-a7c3ef40`; the source-only payload is
`/private/tmp/xe-interactive-a7c3ef40-source-only.json`. Do not call that reduced
copy the exact full delivery. Original d497 local installation remains active.

Focused short corrective Atoma iteration requested from a7c3ef40, key
`xe-browser-production-path-packaging-repair-20261014-v1`. It must remove
generated private state, use temporary test profiles outside workspace, wire
the real known Central Athens browser collection path, correct Docker/control
security/persistence, keep the existing UI, and test offline only. Docker and
headed noVNC verification are explicitly caller-side, not worker requirements.
Corrective run ID `7d3373ba-6542-4675-a2f6-6250b2902ca7`, admitted
2026-10-14 08:16:28 UTC. The first request exceeded the MCP 4,000-character
goal limit and created no run; the accepted request is 3,903 characters.

Local dependency image `xe-browser-runtime-base:20261014` built on ARM64 using
the pinned Node base and Debian chromium/xvfb/openbox/x11vnc/novnc/websockify.
Network-none check confirmed aarch64, Chromium 155.0.8059.39 and every required
binary/noVNC asset. This is a dependency cache, not a working product image.
Atoma correction 3e9f35ca shipped in 9b54ac14; CI 38530437018 and deploy
38531295274 succeeded. Production provenance should be read from the next run.

Run 7d3373ba provenance confirms 9b54ac14. Its short attempt deepened into an
L3 four-phase plan after repeated refusals; independent final Docker review
is still pending. At 08:55 UTC a request to pause at the next validated phase
was refused: MCP conflict, "No sequential phase is available to pause".
The run was NOT paused or cancelled. It remains active; do not assume a
deepened sequential plan exposes a resumable checkpoint. Cancellation skips
artifact finalization in projects/coordinator.ts, so it would not provide
the ordinary artifact API needed for local verification.

### 2026-10-14 09:34 UTC — local browser pilot completed

Owner explicitly approved cancellation of looping run 7d3373ba and completing
its local pilot. MCP confirmed cancellation at 09:18:49.092 UTC; all 1,423
summary events were read to the end. Reported subscription-equivalent cost was
$1.8543 (89 calls), not a claim of an extra API invoice. Cancellation did not
produce an accepted artifact manifest. After MCP established that limitation,
a read-only SSH allowlist snapshot recovered source files from this exact run;
no browser profiles, cookies or runtime state were copied. Final source snapshot
and the rejected generated verifier documents are retained as evidence.

Installed a clearly labelled local derivative under
`/Users/mgtf/Atoma/attica-property-flipping/releases/browser-20261014-v2`;
`browser-current` selects it, while the previous HTTP `current` stays unchanged.
Image `xe-browser:local-20261014-v2` (ARM64) has ID
`sha256:50662e1b057d5d87162c8a65d9be54c276efc10e7f8724d743bc3db8611b2fb0`.
Root launchers: `Start xe browser.command`, `Start demo.command`,
`Stop browser.command`. Control http://127.0.0.1:3300/; controlled browser
http://127.0.0.1:6081/vnc.html?autoconnect=1 . Both ports bind host loopback.
The container runs as 501:20 with read-only root and only a private state mount.
Live and demo profiles/exports are separate. The final service is LIVE and IDLE;
no real xe.gr collection was automatically started during this handoff.

Atoma supplied the browser collector core. Local integration repaired guarded
noVNC HTTP/WebSocket access, checkpoint location, per-page exports, durable
request reservation before navigation, active cancellation on resume, per-batch
budget reset/archive, refusal/Retry-After persistence, explicit recovery after
aborted navigation, target scope and human challenge subframes. Playwright is
locked to 1.55.1 with system Chromium; dependency audit passed. This pilot is
not an accepted Atoma delivery or a general Atoma paired-device service.

Final image verification: 17 browser tests and all six original offline scripts
passed in network-none Docker. All 95 installed source/data files match the
local manifest; all 45 historical data/evidence files match d49796f8. Seven HTTP
boundary cases passed. Actual noVNC UI demonstration proved pause -> premature
resume stays paused -> synthetic human approval in the same Chromium session
-> explicit resume completes two unique rows, with four consumed navigations.
CSV and JSONL both contain those two rows. Restart/container replacement kept
the paused row and budget without automatically fetching another page. Earlier
batch archiving and foreign/wrong-port WebSocket Origin rejection were verified.
Receipts and logs: `receipts/browser-20261014/` under the installation root,
including `final-validation.json`, `demo-complete-v2.json`, `live-ready.json`.
No real xe.gr CAPTCHA was solved or validated; that is the next product test.

Atoma improvement already shipped: record_probe Node syntax-check fix 3e9f35ca,
62 regression tests, delivered in 9b54ac14 (CI 38530437018 and deployment
38531295274 succeeded; corrective run provenance confirms that revision).
Remaining observed platform issues: pause unavailable after short-run deepening,
private runtime/profile artifacts admitted to run1's manifest, repeated verifier
loops and baseline assumptions, and generated integrity verification that rejects
intentionally changed implementation files. Do not claim those issues fixed.
No new browser-pilot GitHub publication and no further paid run were started.
Spitogatos stays paused; future product iterations should continue through Atoma.

### 2026-10-14 — real post-CAPTCHA parser defect fixed in local v3

Owner completed the real xe.gr CAPTCHA, then reported `xe.gr search payload
missing or malformed`. The controlled browser showed the actual search page.
Cause reproduced offline through real Chromium with the authentic archived HTML:
`page.content()` serializes double-quoted attributes with literal apostrophes,
but both xe parsers used a regex that terminated on either quote. The earlier
non-fixture test passed archived bytes directly through a fake browser, missing
this serialization boundary. Fixed the shared attribute extraction to honor its
matching delimiter and decode entities in one pass (preserves literal &lt; etc).
Regression first failed with the user's exact error, then passed with the fix.
19 browser tests and all six original offline scripts pass, network disabled.

Installed local `browser-20261014-v3`; image
`sha256:c58d6e5193092d6b37b014a1105193fc9fb0e7d24979e855392319c12b43152b`.
Same private browser profile retained; stopped state backed up locally under
`browser-state-backups/before-parser-v3`, never sent to Atoma or published.
Resumed the existing two-page batch: COMPLETE, 68 unique real xe.gr listings,
68 CSV and 68 JSONL rows, two additional navigations (budget 4 -> 6).
No new CAPTCHA required; the agent did not solve any real CAPTCHA. All 45
historical data/evidence files remain unchanged. Live exports are in
`/Users/mgtf/Atoma/attica-property-flipping/browser-state/output/`.
Receipts: `receipts/browser-parser-20261014/manifest.json`, `offline-tests.log`,
`live-validation.json`. This supersedes the prior 'real CAPTCHA untested' limit:
the user-solved verification and subsequent collection now have live evidence.
The parser patch is local product code, not an Atoma platform patch or a new
accepted/published Atoma run. Carry the missing real-browser serialization test
into subsequent Atoma product iterations instead of trusting fake DOM evidence.


### 2026-10-14 — portable installer integration run

Owner approved completing Attica integration into the new Atoma Docker guide
("Ok fait le"). Production run `1a4dd9b1-e6a7-4729-bba7-7af623c8fec8`,
key `attica-portable-installation-20261014-v1`, admitted 10:37:37 UTC. It uses
ordinary repository synchronization, not an explicit obsolete run base. Private
project main `bd66fbb` adds `integration/attica-local-v3-source.json`: only 32
reviewed code/configuration files, no data/evidence contents, profiles, cookies
or current exports. Full 98-file payload was rejected by automatic approval
review for possible sensitive evidence; narrowed source-only transfer passed.
Run must apply/hash-check sources, remove integration input/generated profiles,
finish portable descriptor/Compose and customer docs, and run offline regressions.
Caller verifies actual downloaded ZIP and Docker afterward. Existing Mac pilot
on 3300/6081 and its 68 live rows remain untouched; candidate uses 3310/6082.
The guide requires delivered status; client acceptance/publication is distinct.

Run 1a4dd9b1 delivered at 10:46:54 UTC, all 3/3 criteria met, manifest
`1448d7af37bd39bfa783604c73c7312e9cf211da9fd9974590d498e6b894d340`.
All 80 trace summary events were read; production record_probe confirms 19
real Chromium browser regressions plus six historical offline suites. Saved
comparison against d49796f8: 26 added, 2 modified (README and xe parser), 70
unchanged, no removals; all historical data/evidence unchanged. Generated
.local-browser files and the consumed integration input are absent.

Production Atoma Files now displays the Docker guide for Attica. Downloaded
actual UI ZIP: 22 sources + 5 platform launcher/help files, 37,531 bytes, SHA-256
`d8c1e8937a820c2188d43e5ecda1f1e4d4912eb1baced2cf703c7ebcea00a9c9`.
All source bytes verified. Exact Start.command built a healthy ARM64 service,
501:20/read-only root/loopback3310+6082; UI idle and noVNC HTTP200. Exact
Stop/Start preserved a synthetic state marker; marker removed and new service
stopped. Original pilot on3300/6081 remains complete with68 real rows. No new
collection or CAPTCHA trial. Native Windows unverified. Stable downloaded
package: `/Users/mgtf/Atoma/attica-property-flipping/releases/portable-1a4dd9b1`.
Receipts: `receipts/portable-1a4dd9b1/validation.json` under installation root.

This is now an Atoma DELIVERED snapshot available for installation. No client
acceptance/publication was recorded: that is distinct from model validation;
acceptedReference remains7ab2c661. GitHub main contains source integration input
bd66fbb, not yet the completed snapshot. Never claim GitHub publication here.
