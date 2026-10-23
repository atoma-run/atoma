# Contracts — AGENTS.md

`src/contracts/` owns the shared runtime shapes: one schema per shape,
inferred types, and the merge semantics readers and writers agree on.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Define a schema once and import it everywhere.

Neighbours:

- [`src/tools`](../tools/AGENTS.md) — the writers bound by these merge rules
- [`src/platform`](../platform/AGENTS.md) — the closed event-kind vocabulary
- [`src/atoms`](../atoms/AGENTS.md) — the plan and verdict shapes

## Workspace control protocol

`computeDevice.ts` owns desktop capability, session, resource and assignment
shapes. A connection generation fences sockets; a separate execution generation
fences workload effects. Advertised resources are not independently verified
proof. Server admission requires an operator-approved app version and image digest.

`computeProtocol.ts` wraps private workspace commands in run/generation/request
identities on the authenticated WSS channel. Its 1 MiB application-frame budget
includes that envelope; transfer chunks stay bounded by `checkpointTransfer.ts`.
`computeTransport.ts` owns the opt-in transport envelope (1 MiB + 1 KiB), sequence
acknowledgements and authenticated resume shape. No application command, storage
schema or lease changes; legacy peers remain compatible. Transport state and
resume capabilities are memory-only and never logged.

`workspaceProtocol.ts` is a private runtime channel, separate from
`workerProtocol.ts` and all element declarations. It has no caller-selected
root or arbitrary command. Replies reuse the owning evidence schemas; guards
are opaque service-local handles. Snapshot bytes and filesystem identities
never ride in a guard reply. `checkpointTransfer.ts` defines bounded chunks
and portable relative paths; its receiver reuses the local checkpoint digest
encoding instead of inventing a second snapshot identity.
Lifecycle commands use launcher-bound seed/read-run sources, never request paths.
Import handles are service-local and exclusive with live guards/exports; a lost
commit acknowledgement never authorizes replay. Error details are bounded and
untrusted diagnostics, not executable instructions. Source selectors carry only
a seed discriminator or an authorized reference id. Artifact exports share the
chunk channel but carry the publication inventory for independent byte validation.

## Haystack runtime configuration

`computeRetrievalConfig.ts` owns the host-only UUID-keyed Compute override map
and reader. It reuses `retrievalHaystack.ts`'s full runtime/model pin schema, is
bounded to 64 KiB and refuses malformed configuration. It is not a request,
public setting or client capability, and introduces no stored runtime identity.

## Schemas and examples

- Transport witnesses carry optional host-observed `exitCode` for bounded historical evidence selection. Missing legacy status is unknown; declarations and output prose cannot supply it.

- Contract examples are parsed at module load. A schema/example mismatch must
  fail tests immediately.

## Probe manifests

- Result review receives a bounded shell command/exit index from the parsed
  manifest, prioritizing exact reported commands. Large stdout fields cannot
  hide a later entry behind the generic file excerpt. Omitted entries remain
  unknown; stored values establish neither execution nor current-state proof.
  Each exact command/exit pair is marked PRESENT, independently of neighboring
  build/test commands. A healthy shell-only manifest uses this index instead
  of a second generic file head when both reads have identical bytes; mixed,
  malformed or changed manifests keep their raw diagnostic excerpt. Presence
  proves storage only; semantic review and transport evidence remain required.
  Same-command replacement remains latest-only; transport receipts establish
  earlier mutant outcomes, never a fabricated replay obligation.

- Shell replacements retain the last eight replaced command/exit pairs in
  `replacementHistory`, with explicit truncation. They are history, not replay
  obligations or equal-coverage attestations; same-command reruns preserve them.

- Probe manifests are structured records. Normalize paths before recognizing
  `.atoma-probes.json`; its three machine writers merge entries
  (`mergeShellProbe`, `appendHttpProbe`, `appendWebProbe`), and no model writes
  it: `write_file` and `edit_file` refuse the path (2026-10-11).
- Manifest MERGE semantics have one definition: `src/contracts/probeManifest.ts`
  owns entry identity per shape (shell by `cmd`, web by `webEntryIdentity`,
  http = ordered append) and documents the three writers' corrupt-input
  policies side by side. Never re-implement a merge in a tool. Web identity
  is what a replay runs (file, interactions, smoke, viewport, settle time),
  read as `validate_html` reads a call: `webCheck.ts` holds that reading
  (`parseInteractions`, the defaults and caps), which the tool, the merge and
  the inherited-check replay all import. A Space check and an S check
  reading one smoke are two checks (run 0b51e494).
- A SEEDED workspace inherits the manifest as a replay baseline, filtered by
  `inheritProbeManifest`: an entry `probeEntryProblems` rejects is dropped, one
  by one (HTTP included — a seeded HTTP list is several runs' appends, not one
  sequence), except a shell entry whose only flaw is a port-bearing stdout,
  which is REPAIRED (stdout omitted: the reader compares its exit code), and a
  clean manifest is copied byte for byte. That per-entry
  function is the one definition of a well-formed entry; `validateProbeManifest`
  is built on it. Do not stamp provenance into entries: web entries and
  compiled verifiers rewrite them whole, so a stamp depends on its writers.
  Attempt-scoped observation is the witness channel
  ([seed inheritance](../../docs/decisions/seed-inheritance-2026-09-25.md)). The ONE
  stamp is the host's dead mark (`deadSince`, `deadReason`, `deadCheck`),
  and it is written so its writers cannot make it lie. It is honoured only
  on the check its `deadCheck` digest names, and only when every entry of
  that check carries it: a mark copied onto fresh evidence is ignored, and
  one a writer drops only delays a removal.
- The browser-probe discriminant has ONE taught literal
  (`WEB_PROBE_DISCRIMINANT`), and both the manifest writer block and the web
  canonical prompt's `output.probes` example are generated from it. Aliases
  (`REPORTED_WEB_PROBE_ALIASES`) are READER tolerance for recipes distilled
  before a rename; never teach one, and never widen the on-disk checker to
  accept one — a compiled script dispatches on that discriminator.
- `probeManifest.ts` also hosts the taught two-call `validate_html` shape
  (`SMOKE_TWO_CALL_SHAPE`, rendered as `SMOKE_TWO_CALL_LINES`) for the same
  reason it hosts `EXAMPLE_WEB_ENTRY`: one constant, rendered by two layers
  that may not import each other (the tool's refusal and the shared smoke
  guidance). It is the executed-interactions counterpart of
  `establishesDomInteraction`; its second call changes state once before the
  reset because a reset on a fresh page proves nothing. Generic vocabulary
  only — control, milestone, reset — never one widget's names.
- `probeEntryKind` is the ONE kind dispatch of a manifest entry: the health
  check and the inherited-check replay (`inheritedChecks.ts`) both call it.
  `inheritedChecks.ts` owns which inherited web entries are checks, how one
  host replay is judged (its smoke verdict, never the page's console), the
  block and judgement shapes root acceptance reads, and the `deadSince` /
  `deadReason` marks a web entry carries once a run found its check dead.

## Proof attestation

- `src/contracts/attestation.ts` owns the typed tool observation, the
  attestation record, and the obligation vocabulary. An observation is only
  ever OBSERVED: no model-authored payload may enter that module, and the only
  writer is the runtime seam that saw the raw tool result.
- `pathHeldNoFile` (`toolOutput.ts`) is the one reading of a `read_file` or
  `list_files` ANSWER that found no file (an absent path, a directory;
  2026-10-13, [src/tools](../tools/AGENTS.md)): never attested, never a
  successful tool action, never content to a host reader — what the throw it
  replaced was.
- `requestedInteractions` and `executedInteractions` are SEPARATE fields on
  purpose. Reporting one side is what let `ok: true` with an empty interaction
  log read as proof that clicking worked.
- `renderObservation` is the one line a validator reads. A browser line shows
  the viewport, the bounded JSON-encoded EXECUTED action log, the smoke EXPRESSION and the smoke result: a result keyed
  `controlsVisible: true` does not say it measured `height >= 44`, and
  without the expression a delivery was refused for not verifying exactly
  that (production run 5a5f1e27, 2026-09-26). The expression is child-authored
  and JSON-encoded like an execution's request (head and tail kept), so it
  cannot print lines of its own into a machine-observed block. An action count
  alone cannot distinguish clicks from keyboard use (run ce89c84a); requested
  or filtered actions never enter the executed log, and a cut excerpt says
  nothing about omitted actions. Neither actions nor counts establish that a
  behaviour passed without its outcome. Also,
  `renderObservations` writes a repeated one out ONCE, on its latest
  occurrence — the one a bounded evidence block keeps. Writes are attested by
  path and reply, never content, for ORDER: a read of a path the same branch
  rewrote afterwards renders `[STALE: ...]`, because a cell judged a page on
  its pre-rewrite read (run 74fe5cec). Its obsolete response is omitted from
  decision-context rendering, retained in the log. `supersededFileReads` owns
  this ordering; root acceptance applies it across the accepted attempt's
  phases too. A warning beside the old bytes was insufficient (run bcf35298).
- HTTP, shell, file-read and server-start observations are bounded historical
  evidence in the same attestation log. They do not establish DOM interaction
  or introduce automatic approval, and their scripts/content remain untrusted.
  Shell observations retain an optional raw-result `exitCode` before excerpting; text never supplies it, and legacy absence stays unknown.
  File reads record host-computed `responseTruncated` as true or false;
  absent on older records means unknown. `fileReadsNeedingReadback` combines
  those paths with superseded reads for the shared bounded source reader. A
  literal truncation marker inside a file never supplies this structured fact.
  A latest complete read removes older refresh candidates only when its event
  is visible to the caller's judge; a later write or an omitted read does not.
- A `fetch_url` observation carries a structured `http` `{method, path,
  status}` ONLY when the tool reported `servedBy`: the port belongs to a
  server this tool set started and its process holds it, and the response was
  not redirected. With the seed lineage's host-recorded observations under
  an unchanged code digest (Standing HTTP evidence, below), it is the only input
  the acceptance checklist covers from; a projection, not an obligation.
- The obligation vocabulary is CLOSED and has one member. Adding a second is a
  design review with its own evidence, not a schema edit.
- A `validate_html` PRE-FLIGHT refusal is a statement about the request, not
  an observation of the artefact: no page opened, no document bound. Its
  error strings carry one of TWO prefixes — `SMOKE_PREFLIGHT_REFUSAL_PREFIX`
  for the smoke guards, `PROBE_URL_REFUSAL_PREFIX` for a portless loopback URL
  (2026-09-21: a bound-origin mismatch read as a dead service replayed a run
  into its deadline) — and `isPreflightRefusal` is the one predicate over
  both; the tools write them, the L1 validation ledger reads the predicate.
  Never grep the literals.
- `Witness` declares its OBSERVER. Never relabel a model-declared witness as
  transport-observed, and never fold transport witnesses into the
  recorded-probe rendering — they are references, and they carry no `cmd`.

## Acceptance lists

- `acceptanceChecklist.ts` owns BOTH lists. The drafted parse is lenient (a
  model's bad item is dropped); the user-approved input
  (`approvedChecklistInputSchema`, `acceptanceSpecSchema`) is STRICT, because
  a criterion the user approved and the run lost is the contract's named
  failure. `parseChecklistLines` is the ONE line grammar for console, CLI and
  MCP; it reads a status right after the path (`404`, `→ 404`, `(404)`, with
  or without a space, before punctuation) and REFUSES an http line naming one
  anywhere else, which would be a silent 2xx check, or naming a second status,
  which its one check would never exercise. The whole encoded list is bounded at the door, not at launch. The
  module stays browser-safe: the digest and the env transport live in
  `src/run/acceptanceSpec.ts`, because the client imports this directory.

## Parent-test records

- `parentTests.ts` also owns the shared sufficiency guidance: a child-authored test helper is not an independent oracle, and factory delegation alone cannot prove product behavior. Plans may declare not-yet-implemented interfaces; assertions still follow the requested contract. [Review](../../records/incidents/attica-recipe-evidence-2026-10-20.md).
- `parentTestRecord.ts` is the browser-safe home of the persisted parent-test
  record (`persistedParentTestSchema`, written by `persistedParentTests`), the
  superseded rule core's gates use, and `summarizeParentTests`, the ONE
  projection the viz result view, the receipt card and `atoma_run_review` read
  (decision: [parent-owned tests](../../docs/decisions/parent-owned-tests-2026-10-16.md)).
  Four states: `recorded`; `none` (no field: NOT a pass); `not_recorded` (no
  result); `unavailable`, added by the server for a trace it could not read.
- It follows core's superseded rule unchanged: a pass the host observed later
  (`observedAt`; record order only where a record has no clock, since a
  parallel aggregate lists branches in subtask order), keyed on the suite
  digest alone, across workspaces; a display never disagrees with the gate.
  It never parses `details` or summary prose and carries no suite source. The
  reader schema is derived from the writer's without its maxes: readers slice
  and replace control characters and lone surrogates, never reject.
  `subjectDigest` (2026-10-17) is optional on the worker's reply and kept in
  the record, a malformed one read as absent; no display reads it.
- The suite digest stays in `parentTests.ts` (`node:crypto`), which re-exports
  the record names for the server; client code imports `parentTestRecord.js`
  only (`tests/viz-client-bundle-boundary.test.ts` bundles the consumers).
- `suiteDisputeRecord.ts` (2026-10-17) is the record of a counted suite
  dispute and of that suite's later verifications in the loop, server-side
  only. Strict writer: its builders bound every string first, so a real
  dispute is never refused for its size. Tolerant reader: it keeps what it
  knows and drops an unreadable observation, never the entry around it. It
  lives in the trace's top-level `suiteDisputes` member (64 entries, a
  counted one displacing a later one), never in an event or in `result`,
  which the analyst's events file and later runs read. Counted entries equal
  the run stats' `suiteDisputes`; the report lists a run whose stats count
  more as legacy ([pre-registration](../../benchmark/suite-dispute-2026-10-17/PREREGISTRATION.md)).

## Reading a trace without holding it

- `previousRunResults.ts` owns the bounded text-history environment envelope:
  three entries, 24,000 encoded characters, explicit truncation/unavailability.
  This optional context reader may parse a finished trace below MAX_TRACE_BYTES;
  it never changes the shape-only delivery decision described below. Oversized,
  missing or malformed source traces yield an unavailable context entry.

- `src/contracts/traceFields.ts` owns the ONE projecting reader over a run
  trace: `readTraceTopLevelFields` enumerates the document's DEPTH-1 members in
  bytes and returns only what its caller named — VALUES for members whose
  content is needed, SHAPES for members whose presence and JSON type are. It
  lives here, not in `src/viz`, because `src/viz/server.ts` imports four
  `src/projects` modules and a value edge back would close a subsystem cycle;
  it is allowed here for the same reason `runStats.ts` holds its own parser,
  and keeps coordinator decisions shape-only even when detail readers capture payloads.
- `llmTrace.ts` CITES model-visible context, it does not copy it:
  `citeContext` records a block's source, its true `chars` and a preview
  capped at `CONTEXT_PREVIEW_CHARS`, and the same id is cited on the `llm`
  event. The cap is 2,000 — raised from 160 because the viz `context` step
  exists so a viewer can read what the model was shown, and 160 cut a
  1,167-character recipe mid-sentence (2026-09-21). It stays a CAP: a longer
  block is still truncated with an ellipsis, and one event is recorded per
  distinct block per run, so a trace grows with a run's injects rather than
  with its calls.
- A trace's SIZE is a function of how much work the run did (~19KB per tool
  call, measured). Never bound it with a constant: a 512KB cap recorded
  delivered run `2857a579` as `failed`. Bound the PROJECTION instead — the
  coordinator's spec captures under 400 bytes from a trace of any size.
- `result` and `error` are the members a MODEL wrote, and they are read as
  SHAPES ONLY. `result.output` is typed `unknown` and capped nowhere, so any
  reader that captured it would rebuild the same erasure at a larger threshold.
- The reader is order- and whitespace-agnostic, so archived traces stay
  readable and no caller may depend on member order or indentation. It is
  FAIL-CLOSED: a member is reported absent only after the scan reaches the
  closing brace and then EOF, which is what rules out a head+tail byte window —
  that window cannot tell "the member is not there" from "my window was too
  small", and a missing `error` read as "no error" would publish a failed run.
- Validation is DEPTH-1 ONLY. Inside a skipped container the scan tracks
  strings and nesting but does not check bracket matching or primitive grammar,
  so a document malformed only below depth 1 is accepted where `JSON.parse`
  would refuse. Unreachable from `TraceRecorder`, which emits one
  `JSON.stringify` per persist, and the projected members are still exact.
- `MAX_TRACE_BYTES` (32 MiB) bounds WHOLE-FILE materialization and selected
  projections, never the shape-only coordinator scan. Larger traces use the
  SAME scanner to index top-level members and event byte ranges. Reads and
  streamed HTTP deltas retain one descriptor across atomic recorder persists;
  the range index and materialized selections are bounded independently.
  Viz lists project event accounting fields; MCP projects its requested page
  or detail. An oversized selection remains explicitly unavailable. Sentinel,
  runner-log and optional whole-file consumers retain their bounded refusal.
- No refusal message carries a filesystem path. `project_runs.error` is served
  to tenants, and the row this reader replaced leaked an absolute host path.

## Model selectors and who paid for a run

- `modelSelector.ts` is the ONE grammar for a model choice, everywhere:
  `<api|sub|own>:<vendor>:<model>`, closed mode and vendor vocabularies, the
  third segment verbatim (Ollama tags keep their colons). `parseModelSelector`
  is the only parser, `transportOf` the only mode+vendor → transport mapping,
  and `readTierSelectors` the only reader of the three REQUIRED
  `ATOMA_MODEL_L*` pins — there is no default, and no other module may
  spell, split or default a selector. Stored pins written before this grammar
  (2026-09-07) are not recognised; the store is reset, not migrated.
- `runPayers.ts` is the ONE answer to who paid, and it is PER TIER: three rows,
  `l1`, `l2`, `l3`, each naming the resolved selector, the transport that
  served it (`transportOf`), the payer kind and the chain level it came from.
  There is no `base` row any more because there is no base transport: every
  ordinary tier call carries its full selector. Shared catalog authorship is a
  separate platform operation: its `platform-tissue-author` trace actor names
  host-paid calls independently of the customer's three tier rows
  ([contract](../../docs/decisions/tissue-routing-2026-10-02.md)).
- THE PAYER IS THE SELECTOR'S FIRST SEGMENT (`payerForSelector`): `sub:` is
  `host-subscription`, `own:` is `principal-subscription`, `api:` is `org-key`
  when the organisation brought the vendor's key, else `host-key`, or
  `host-selfhosted` for Ollama. Nothing infers a payer from a transport name.
- Subscription selectors are ADMISSIBLE BY CHAIN LEVEL, not by spelling: the
  coordinator honours `sub:`/`own:` from an account pin after re-asking the
  authority, and refuses them from the org and host levels; both ChatGPT
  families admit all three tiers through Atoma's host-side tool loop.
- Nothing here carries a secret: a payer names a KIND and a transport. This
  detail is journaled beside `project_runs.error`, which is served to tenants.
- Summary helpers distinguish host and requester subscription spend; both use
  the same structured `runPayerDetail` ledger.

## The platform's run limits

- `platformSettings.ts` holds the CLOSED CATALOG of admin-settable run limits
  and derives its schemas from it. The whole contract — the two kinds, the
  refuse-never-clamp rule, why the resolver reads no environment, and every
  enforcement site — is stated once in
  [`src/platform`](../platform/AGENTS.md). Read it before adding an entry.

## Publication receipts

- `workspaceLimits.ts` owns host budgets shared by GitHub import, workspace
  inventory and sync. Repository BASE can retain a second workspace's worth
  of tombstones. These are resource bounds, not a bound on changed files.

- An artifact manifest with `source: workspace` records the complete filtered
  workspace inventory. Absence of this optional field retains the legacy
  explicit-file meaning and its exact hash. Revalidation follows the recorded
  coverage; it never upgrades historical evidence implicitly.

- `baseSha` on a publication is OBSERVED, never a pointer anything decides
  from — the same rule `attestation.ts` states for a tool observation. It
  records the publication parent (the captured run base for PR projects; the live head for forks); the
  authority to publish onto an existing branch is read from GitHub at publish
  time. A required KEY with a nullable VALUE on a `.strict()` object, so a
  writer must state what it built on rather than omitting it.
- `commitShaSchema` is the ONE definition of a 40-hex commit sha, imported by
  both the receipt and the row. It was written twice.

## Trajectory signatures

- `src/contracts/trajectory.ts` owns the signature, key and score shapes AND
  the pure derivation over trace events, for the reason `traceFields.ts` lives
  here: two subsystems read it — the sentinel's rule table and the analyst's
  digest — and neither may import the other. It reads runtime-stamped
  identities only (element names, actor names, skill ids, event and branch
  ids) and never `args`, `result` or prose; its event type is structural so
  every `VizEvent` satisfies it without a `src/viz` import.
- ONE EXECUTION IS ONE `llmEventId`. It is CLOSED by the `llm` event carrying
  that id, which `RecordingLlmClient` records only when the call returns, so
  array order is causal and a signature without it is a prefix. It is CREDITED
  by the next `skill.success` (naming its skill, when it had one) or `trust`
  RESULT for its Molecule in an agreeing lane, before that Molecule's next
  execution — so a remediation retry leaves its first attempt uncredited.
  Lanes NEST (measured 2026-09-09 on the real traces): the Cell injects,
  credits and trusts in its OWN lane and the Molecule executes in a child lane
  the Cell opens, so an event agrees with an execution when their lanes are
  equal or one is an ancestor of the other, and a lane-less event agrees with
  any lane. One credit credits the latest attempt in a lane and closes the
  older ones there, so the trust-RESULT-beside-skill-success pair cannot credit
  a retry's failed first attempt; siblings in other lanes keep waiting.
- A reference holds completed AND credited signatures only, newest
  `TRAJECTORY_REFERENCE_MAX_PER_KEY` per key. Assemble it oldest-first.

## Persisted rows versus request schemas

- A REQUEST schema may ask time-varying authorities — today's model
  catalogue, a principal's inventory. A schema that READS BACK a persisted
  row may not: it validates spelling, and the authority is asked again where
  the value is USED. `modelPins` degrades a retired account pin; a rerun row
  parses through `storedRunTierModelsSchema` and its launch refuses. Reusing
  the request schema on read made one immutable row throw in every reader of
  its project once its model was retired (2026-09-25 review, 1.1).

## Read runs

- `readRuns.ts` is the one home of read runs: the directory (`.atoma-runs`)
  and the copies' place below it (`.atoma-runs/node_modules/<runId>`,
  `readRunCopyPath`), the caps (three runs, 64 MiB, 10,000 files),
  `ATOMA_READ_RUNS`, the launch index, the copies' modes, the `readRuns` task
  input, its guidance, the acceptor's lines (per copy, per compared file),
  `savedPathsNamed` (the saved paths a criterion spells out, at a path
  boundary; never a stem) and three predicates: `namesReadRunCopy` (a path
  INTO a copy, run id required, with at most one component between the
  directory and the id, `node_modules` or a glob, so `.atoma-runs/<run id>` as
  recorded before 2026-10-17 still counts: inheritance and the skills
  refusal), `reachesReadRunCopies` (a command: also a glob where
  `node_modules` or the id would be, or `cd .atoma-runs`; never an exclusion:
  an exclusion option's argument, a `!` glob, a git `:!`/`:(exclude)`
  pathspec, a pruned or negated `find -path`) and `mentionsReadRunCopies` (any
  mention: the parent-suite refusal).
  Browser-safe: the copy, its check and the comparison live in
  `src/run/readRuns.ts`. A stored list is read back by spelling
  (`storedReadRunIdsSchema`). [Decision](../../docs/decisions/read-runs-2026-10-17.md).
- `artifactInventory.ts` holds the manifest shapes below `projects.ts`, which
  re-exports them: `projects.ts` imports `readRuns.ts`, whose index carries
  manifests, and in an import cycle whose two sides use each other at load
  time, one of them reads the other before it is defined.

## Repository sync records

- `repositorySync.ts` owns per-run BASE inventories, immutable sync records and
  typed push observations. Stored separately from strict historical seed/git JSON
  so an older binary can ignore them. Unknown debt must never authorise writes.

## Standing HTTP evidence

- `standingHttpEvidence.ts` + `serverDigest.ts` (owner decision 2026-10-04): an HTTP item
  this attempt did not observe is covered by a `fetch_url` observation the HOST recorded in
  the seed lineage (trace tool events, `servedBy.codeDigest` taken by `start_node_server`
  before spawn), while the digest of the entry file and its relative imports is unchanged.
  Never read from `.atoma-probes.json`, which a model can write. Rendered RECORDED EARLIER.
  Limit: a computed import, a package, a data file or the environment is not in the digest;
  an `import()`/`require()` of a template with a substitution fails closed instead.
  Model-facing texts say "literal relative imports" and never promise more.
  A repository sync that takes remote content stops inheritance across that boundary.

## Executor coexistence

`executor.ts` owns the host-private command shapes, including the remote preview
start input shared with preview's runtime. `executorVersion.ts` owns the numeric
compatibility boundary. Increment it before an incompatible writer, storage,
lease or RPC change; compatible generations share the primary store and commons.
The activator drains on a mismatch, including rollback. Public identity and
membership checks remain in the existing HTTP/MCP project services.

## Runtime measurement contracts

`runtimeTiming.ts` owns observed phase intervals and the interval-union function;
missing observations are unknown. `modelComparison.ts` owns versioned comparison
corpora and imports the existing parent-test suite contract rather than defining
a second scorer. Neither contract changes acceptance or model selection.

## Intentional choices and rejected shortcuts

- A second definition of manifest merge semantics, near a writer that needs
  "just one field": refused. `probeManifest.ts` owns entry identity per shape,
  and the three writers' corrupt-input policies sit side by side there so they
  can be compared rather than discovered.
- Teaching a reported web-probe alias, or widening the on-disk checker to
  accept one: refused. `REPORTED_WEB_PROBE_ALIASES` is READER tolerance for
  recipes distilled before a rename, nothing more — a compiled script
  dispatches on that discriminator, so an accepted alias becomes a real code
  path.
- Naming one widget's controls in the taught smoke shape: refused. Generic
  vocabulary only — control, milestone, reset. A shape that names a widget
  teaches the page instead of the method, and is the vocabulary-frozen
  detector class in another costume.
- Relabelling a model-declared `Witness` as transport-observed, or folding
  transport witnesses into the recorded-probe rendering: refused. Who observed
  a fact is part of the fact; transport witnesses are references and carry no
  `cmd`.
- Upgrading historical evidence implicitly when a contract tightens: refused.
  Revalidation follows the RECORDED coverage. A rule that reaches backwards
  turns old traces into claims nobody made.
- Deciding `baseSha` from anything: refused. It is OBSERVED, the same rule
  `attestation.ts` states for a tool observation; the authority to publish
  onto an existing branch is read from GitHub at publish time.
- Dropping an inherited probe entry on any mention of `.atoma-runs`: refused
  (2026-10-17). It dropped the exclusions the guidance asks for
  (`--ignore-pattern '.atoma-runs/**'`) and a seeded run's lint replay with
  them; only a path into a copy, with its run id, replays nowhere else.
- Copies straight below `.atoma-runs`: moved the same day (2026-10-17).
  ESLint's flat config, Vitest's default include, Jest and Prettier skip
  `node_modules` but walk dot-directories, so one old defect failed a
  whole-tree check and a clean copy counted another run's tests. Rejected
  instead: `node_modules/.atoma-runs` (`npm ci` deletes it), `.git/atoma-runs`
  (a workspace with no repository gets a broken one), and a worker utility
  running scripts in a copy of the workspace (its cache wrote through to the
  live `node_modules`; [decision](../../docs/decisions/read-runs-2026-10-17.md#the-copies-under-node_modules-2026-10-17)).
- Letting the trajectory contract carry `args`, `result` or prose: refused.
  Identities only, and a structural event type so every `VizEvent` satisfies
  it without a `src/viz` import — a shared shape that imports a subsystem is a
  dependency edge nobody asked for.
