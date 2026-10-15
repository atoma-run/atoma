# Run duration plan — measured on the Attica project, 2026-10-15

Status: PLAN ONLY. Nothing below is implemented. Items are worked one at a
time, in the order given; each one is a self-contained brief for a delegated
agent. Tick the checkbox and link the commit or PR when an item lands.

Working language: briefs are in English because the delegated agent edits
English code and tests. Discussion with the owner stays in French.

## Evidence

Three production runs of project `attica-property-flipping`
(`07864f7c-d8f2-4023-9fca-afd8a7a51e52`), read through the MCP
(`atoma_project_runs`, `atoma_run_trace` summary paged to the end, `section=log`):

| Run | Duration | Cost | Outcome |
|---|---|---|---|
| `85cc4e83` "Collecte xe.gr durable" | 61 min | $2.10 | partial, root acceptance refused twice |
| `f74c140a` "Finish durable collection" | 38 min | $1.50 | partial, refused twice |
| `a62780e7` "Fix cancel / Retry-After" | 8 min | $0.16 | cancelled by the owner during remediation |

Where the wall clock went, run `85cc4e83` (61 min):

| Segment | Time |
|---|---|
| Start-up before the first trace event (Haystack preparation, revision without the embedding cache) | 6 min 29 |
| L3 plan (gpt-6-astra) | 1 min |
| Phase 1: 9 L1 executions over 3 molecules (Adrenaline, CarbonDioxide, Methane) then an L2 fallback | 26 min |
| Phase 2: 3 CarbonDioxide executions | 7 min 40 |
| Phase 3: docs (Benzene) | 1 min |
| Root acceptance | 41 s, refused |
| Remediation (Protoplast → Adrenaline, 4 executions + fallback) | 17 min, refused |

Run `f74c140a` (38 min):

| Segment | Time |
|---|---|
| Start-up: cold cache, 1,534 documents recomputed, `pythonInitMs=357370` | 6 min |
| `--depth short` attempt (Idioblast → Adrenaline): 5 executions, 2 failures, 2 skill revisions | 15 min 30, abandoned |
| Deepening: Meristem replan + 3 phases | 8 min 30 |
| Root acceptance | 40 s, refused |
| Remediation, 3 phases | 7 min, refused |

Run `a62780e7`: start-up 39 s (warm cache: `cacheHits=1495 computed=59
pythonInitMs=32362`). The embedding cache from `e664bcd1` works and already
took start-up from 6 min to about 35 s.

Other measurements used below:

- Planning and validation LLM calls on `85cc4e83` total about 11 min; the
  rest of the hour is structure (start-up, retries, re-reads, timeouts).
- Every root refusal, and most L2 refusals, read "excerpts show only
  titles", "truncated excerpt", "test titles/output alone do not establish",
  never a functional defect. The goal of run `a62780e7` even said "each
  below 5000 bytes so final review can see them without truncation": the
  owner is working around a tooling limit by hand.
- `run_shell` / `record_probe` calls that hit 28–30 s: 10 on `85cc4e83`,
  2 on `f74c140a`, 3 on `a62780e7`. The default shell timeout is 30 s.
- `read_file` calls in the first 15 s of an execute (the molecule re-reading
  the workspace it already read): 232 across 18 executions on `85cc4e83`,
  128 across 12 on `f74c140a`.
- Skill revision after an L2 failure runs on gpt-5.6-terra, serially, before
  the retry: 55 s + 60 s on `f74c140a`, 10 s + 34 s + 12 s on `85cc4e83`.
- Phase 1 of `85cc4e83` walked the ladder Adrenaline → CarbonDioxide →
  Methane → L2 fallback. Methane has no browser tool and failed three times
  on "no executed input-method, screen-width, reload matrix".

## Order of work

1. [x] A. Acceptance evidence: stop refusing on invisible assertions (landed 2026-10-15, see the item's outcome)
2. [x] B. Shell and probe timeout: 30 s kills real test suites (landed 2026-10-15, see the item's outcome)
3. [x] C. Retrieval preparation off the critical path (landed 2026-10-15, see the item's outcome)
4. [ ] D. Depth choice: a five-finding goal is not `short`
5. [ ] E. Ladder: never descend to a molecule whose tools cannot produce the proof
6. [ ] F. Skill revision after failure: off the critical path or bounded
7. [ ] G. Execute retries: keep what the molecule already read
8. [ ] H. Minor: validate-plan always deferred; Adrenaline never trusted

Estimated gain, honestly rough: A+B+C+E ≈ 35 of the 61 min on `85cc4e83`;
A+C+D ≈ 28 of the 38 min on `f74c140a`. A also changes run OUTCOMES, not
only durations: four refusals out of four were evidence-presentation refusals.

Rules that apply to every item (from `AGENTS.md`):

- Read the subsystem `AGENTS.md` before editing (`src/atoms`, `src/tools`,
  `src/run`, `src/projects`). Each has an intentional-choices section; an
  item below that contradicts one must be discussed, not pushed.
- A new gate, heuristic or validator rule goes through an adversarial review
  against the incidents collected so far before it lands.
- Tests under `tests/`, mocked LLMs, no paid call. A regression test must
  cross the same boundary the bug crossed.
- `npm run check` green, both tsconfigs, `git diff --check` clean.
- Measure before and after on a real run when the item claims a duration;
  record the run ids in this file under the item.

---

## A. Acceptance evidence: stop refusing on invisible assertions

Goal: the root acceptor and the L2 validator must see the assertions of the
test files a criterion names, and the executed test names a probe produced,
so that "titles only, assertion truncated" stops being a refusal reason.

Why it is first: it is the one item that turns refused runs into delivered
ones. Each root refusal costs a full remediation pass (7–17 min measured),
and the L2 version of the same refusal cost the 26-minute phase 1.

Where the limits are today:

- `src/atoms/fileEvidence.ts`: `CRITERIA_SOURCE_CHARS = 24_000` (phase
  judge), `ROOT_CRITERIA_SOURCE_CHARS = 48_000` (root), split by water-fill
  across up to `CRITERIA_FILES_MAX = 16` named files (line ~189 onward).
  Files a test script references get `REFERENCED_FILE_CHARS = 3_000` each,
  `REFERENCED_TOTAL_CHARS = 6_000` in all. `namedFileExcerpt` keeps a file
  whole only when it fits its allowance; otherwise head + keyword blocks of
  at most `CRITERIA_BLOCK_LINES = 25` lines.
- `src/atoms/rootAcceptance.ts` imports `criteriaFilesBlock` and
  `ROOT_CRITERIA_SOURCE_CHARS`; `src/atoms/groundTruth.ts` imports
  `criteriaFilesBlock` for the phase judge, and its own file probes show
  `FILE_PROBE_EXCERPT_CHARS = 400`.
- The Attica test files were 7,861 / 9,925 / 11,716 bytes. With ~10 named
  files sharing 24,000 characters, each got ~2,400 and lost its bodies.
- `records/incidents/first-refusals-2026-10-10.md` already classified "cut
  evidence" refusals; read it first.

Steps:

1. Reproduce offline. Write a test in `tests/` that builds a criteria block
   with `criteriaFilesBlock` over a fixture workspace shaped like Attica:
   four test files of 8–12 KB, five criteria each naming two of them, plus
   `.atoma-probes.json`. Assert what the acceptor currently receives: print
   the block, count how many `assert.` lines of each file survive. This is
   the baseline; keep it as the regression test after the change.
2. Add a "test file in full" rule to `namedFileExcerpt` / the water-fill:
   a file matched by the existing `TEST_SCRIPT` regex and under 16,000
   characters is included whole, charged to the budget before other files
   are water-filled. Raise `ROOT_CRITERIA_SOURCE_CHARS` only if the fixture
   above shows the budget cannot hold four such files; document the new
   number with the measurement, in the constant's comment.
3. Add executed test names as evidence. The probe manifest entry of a
   `node --test` command holds its stdout; extract the TAP lines
   (`ok N - name`, `not ok`, `# pass`, `# fail`) and put them in the
   acceptor's prompt next to the file block, labelled as executed results.
   Find where the manifest reaches the acceptor (grep
   `PROBE_MANIFEST_FILENAME` in `src/atoms/rootAcceptance.ts` and
   `groundTruth.ts`) and add the extraction there; no new store.
4. Make the phase judge and the root acceptor share the same view. Today
   `groundTruth.ts` and `rootAcceptance.ts` call `criteriaFilesBlock` with
   different budgets; a phase accepted at L2 was then refused at root for
   the same missing assertion on `85cc4e83` (phase 2 accepted 02:52:09,
   root refused 02:54:04 on c2). Make the root budget the one both use, or
   have the root pass reuse the phase block verbatim when the files did not
   change. Record the choice in `src/atoms/AGENTS.md`.
5. Add a sentence to the acceptor prompt, next to the existing "Do NOT
   reject merely because an excerpt is truncated here" line in
   `groundTruth.ts` (~line 946): when the file block shows a test's
   assertions and the probe manifest shows that test name as `ok`, the
   criterion is proven; ask for a specific missing assertion, not for
   "visible evidence".
6. Adversarial review before landing: list the ways this lets a false
   delivery through (a test that asserts nothing but prints `ok`; a test
   file under 16 KB that is a stub). Keep the review notes under the item.
7. Replay. Use `memory/validator-prompt-replay.md` to replay the root
   verdicts of `85cc4e83` and `f74c140a` offline with the new block; both
   should flip to approved or to a refusal naming a concrete defect. Record
   the before/after verdict texts here.

Done when: the regression test from step 1 asserts the full test bodies
and the TAP names are present; the two replays are recorded; `npm run check`
is green.

### Outcome, 2026-10-15

What the recorded prompts showed. The last root acceptance of `f74c140a`
(criteria batch event `b1ddf508`, paged to the end) read sixteen files and
omitted seven. `tests/attica-durability.test.js`, the whole proof of c2, was
not among them: no criterion named it, and the attempt had neither rewritten it
nor read it truncated, so it was never a read-back candidate. The acceptor saw
its executed test names in the `record_probe` output and never its
assertions. `tests/attica-hosted-ui.test.js` was cut at 1,638 of 13,192
characters because the attempt read docs and sources first and its test
files late.

What changed:

- Root acceptance also reads the test scripts its attempt's shell commands
  name (`commandTestScripts` in `src/atoms/fileEvidence.ts`): command lines
  only, never a `record_probe` note, no globs, at most eight.
- The sixteen reads take, in order: the criteria's own names, those scripts,
  refreshed test scripts, then other refreshed files.
- `ROOT_CRITERIA_SOURCE_CHARS` went from 48,000 to 96,000. Measured on the
  Attica shape (five executed suites, 41,953 characters), it is the first
  budget that shows all five whole:

| Root budget | Command-named tests | Whole suites of 5 |
|---|---|---|
| 48,000 | no | 3, durability never read |
| 48,000 | yes | 3 |
| 72,000 | yes | 4 |
| 96,000 | yes | 5, other files keep their share |

Cost: up to 48,000 more prompt characters (about 12k tokens) on each
root-acceptance call that has that much to show, on gpt-5.6-luna.

Plan steps not taken, and why:

- Step 3 (TAP lines as evidence) already existed: transport observations
  show every `record_probe` stdout, test names included.
- Step 4 (one view for phase and root judges): the measured refusals came
  from the root view alone; the phase judge keeps 24,000.
- Step 5 (prompt sentence): the criteria system prompt already says to read
  the test body and to call missing evidence unverified. The defect was the
  missing body, not the instruction.
- Step 7 (offline replay of the two root verdicts): NOT DONE. The replay
  needs the recorded 110,000-character prompt and the run's workspace files
  on disk; the Atoma MCP authenticates through Claude Code's OAuth, so no
  script could fetch them. Do it on the next Attica run instead: check that
  the acceptor's FILES block lists `tests/attica-durability.test.js` whole and
  that no refusal reason says "titles only".
- One c3 refusal ("only one new detail, so 1-second spacing between two new
  details is unproven") is a real test gap, not truncation; this change does
  not and should not flip it.

Regression tests: `tests/phase-file-evidence.test.ts` (the Attica shape
through `acceptRootResult`; fails on the previous code), and
`tests/readback-blocks.test.ts` (extraction, the half-cap bound, ordering).

## B. Shell and probe timeout: 30 s kills real test suites

Goal: a `record_probe` or `run_shell` that runs a legitimate test suite is
not killed at 30 s, while a hung command still cannot stall a run.

Where it is: `src/tools/builtin.ts` `runShellTool`, line ~972:
`const timeoutMs = opts.shellTimeoutMs ?? 30_000;` `recordProbeTool`
(line ~3748) wraps `runShellTool` and inherits it. No caller sets
`shellTimeoutMs` (grep confirms). `fetch_url` already accepts a bounded
`timeoutMs` argument (line ~1403), use the same shape.

Measured: 15 calls at 28–30 s over the three runs. The Attica suites pace
10 s per page and restart a child process, so 30 s is below their honest
run time; the molecule then split the suite into smaller runs and lost the
combined probe the acceptor wanted.

Steps:

1. Read `src/tools/AGENTS.md`, in particular what it says about long
   processes and cleanup on every exit path. The process-group kill on
   timeout must stay.
2. Add an optional `timeoutMs` argument to `run_shell` and `record_probe`
   in the tool declaration, bounded: default stays 30,000 for `run_shell`,
   120,000 for `record_probe`, hard cap 300,000. Reject values above the
   cap with an error naming the cap (same style as the other argument
   errors in that file).
3. Make the timeout error message say that `timeoutMs` exists and what the
   cap is, so the model learns the fix from the error (the file already
   coaches argument shapes this way; follow that style).
4. Regression test in `tests/`: a `record_probe` of `node -e "setTimeout(()=>console.log('late'),35000)"`
   with `timeoutMs: 40000` succeeds and records exit 0; the same without
   `timeoutMs` times out and kills the process group (assert no orphan).
5. Check the worker/container path runs the same code: tools execute in
   the worker (`src/tools/worker*.ts`); if the timeout is applied on the
   host side of the boundary too, align both.
6. Measure on the next Attica run: count `record_probe` events with
   `durationMs >= 28000` in the trace summary; expect zero that are
   timeouts.

Done when: the test passes, the next real run shows the long suites
recorded with exit codes, and `src/tools/AGENTS.md` mentions the argument.

### Outcome, 2026-10-15

- `run_shell` and `record_probe` accept `timeoutMs` (integer, 1 to 300,000).
  Defaults: 30,000 for `run_shell`, unchanged, and 120,000 for
  `record_probe`. Out-of-range values are refused before anything runs.
- The timeout error now says that `timeoutMs` exists and where its cap is.
  The process-group SIGKILL is unchanged.
- No host layer cuts a long call first: the worker protocol passes arguments
  through, and the Codex app-server loop pauses its silence clock while a host
  tool runs. The Claude CLI loop keeps its clock running (default 10 minutes),
  so only an admin `llm.callTimeoutMs` ceiling under 300 s could end such a
  call; that was already true of any quiet stretch.
- Step 5 checked: the worker and in-process paths run the same
  `runShellTool`, and `src/contracts/workerProtocol.ts` passes `args` as an
  open record, so `timeoutMs` crosses the container boundary.
- To measure on the next Attica run: count `record_probe` and `run_shell`
  events with `durationMs` between 28,000 and 30,500; expect none that are
  timeouts.

Regression tests: `tests/record-probe.test.ts`, describe "a command may ask
for the time a finite suite needs" (per-call override beats a short default,
group kill at the given limit, refusals, declared defaults).

## C. Retrieval preparation off the critical path

Goal: the first LLM call of a run does not wait for the Haystack
preparation; only the first `search_project_docs` call does.

Where it is: `src/run/runner.ts` lines ~1496–1507:

```ts
if (prepareRetrieval) { ... await prepareRetrieval({ signal, deadlineAt }); ... }
retrievalPrepared = true;
const result = await handle(task, ctx);
```

The backend is composed at line ~1126 (`withProjectRetrievalBackend`);
preparation lives in `src/projects/retrievalHaystack.ts` (`prepare`,
`pythonInitMs`, `cacheExportMs`) and `retrievalHaystackLaunch.ts`.

Measured: 389 s and 361 s before the first event on the two long runs,
39 s on the third (warm cache). Only Benzene called `search_project_docs`,
in the docs phase, 6 calls on `f74c140a`, 2 on `85cc4e83`. Even warm,
`pythonInitMs` is 32 s.

Steps:

1. Read `src/run/AGENTS.md` and `src/projects/AGENTS.md`; check the
   intentional-choices sections for why preparation is awaited up front
   (the comment says progress readers show "preparing"; keep that signal).
2. Start `prepareRetrieval` without awaiting it: keep the promise, keep the
   `[atoma retrieval] preparation started/ready` log lines, and call
   `handle(task, ctx)` immediately.
3. In the `search_project_docs` tool backend (grep `search_project_docs`
   in `src/run/toolBackend.ts`), await that promise before the first query.
   A query that arrives while preparation is still running waits, with a
   log line saying so; a preparation failure surfaces as the tool error it
   is today, not as a run failure at start-up.
4. Cancellation and deadline: the preparation already takes `signal` and
   `deadlineAt`; make sure a run that ends before preparation finishes
   aborts it (no orphan Python), and that `retrievalPrepared` is still
   reported correctly to whatever reads it (grep its uses).
5. Regression test crossing the real boundary: a run whose fake
   preparation takes 2 s must emit its first `llm-start` before
   `preparation ready`; a `search_project_docs` call must wait for it.
6. Separately, note in this file (do not do it in this item) the 32 s
   warm `pythonInitMs`: a persistent Haystack process on the host would
   remove it. That is a different change with a different owner decision.
7. Measure: on the next run, start-up to first event should be under 10 s.

Done when: the test passes and a real run's first event is within seconds
of `startedAt` while `[atoma retrieval] preparation ready` appears later.

### Outcome, 2026-10-15

- The runner starts `prepareRetrieval` without awaiting it; the first model
  call no longer waits for the corpus.
- The retrieval service gained an optional `ready()`. `search_project_docs`
  awaits it, bounded by the run's signal and deadline, BEFORE arming its own
  10 s deadline. Without that, a search during a cold preparation would have
  answered `unavailable`. An invalid request is still refused at once.
- Owner decision, 2026-10-15: a runtime preparation failure no longer stops
  the run. Stopping was free when preparation preceded all spend; beside the
  run it would discard paid work, for a tool one molecule calls a few times.
  Launch-time refusals (configuration, receipt) are unchanged and still come
  before any spend. The failure is logged, and every later search answers
  `unavailable`. Recorded as an amendment in
  `docs/project-retrieval-haystack-only-2026-09-09.md`.
- Step 6 of the brief (persistent Haystack process for the 32 s warm
  `pythonInitMs`) stays out of scope, as planned.
- To measure on the next Attica run: the first trace event should follow
  `startedAt` by seconds, and `[atoma retrieval] preparation ready` should
  appear in the log after it.

Regression tests: `tests/project-retrieval-runner.test.ts` (`slow-init`: the
model starts before preparation is ready and the search waits for it;
`broken-haystack`: the run delivers and search answers `unavailable`), and
`tests/project-retrieval-host.test.ts` (wait outside the search deadline,
rejection, invalid request, run deadline, cancellation).

## D. Depth choice: a five-finding goal is not `short`

Goal: a goal that lists several review findings or several criteria starts
at `deep`, and a `short` entry that fails deepens after the first L2
failure instead of after two failures and two skill revisions.

Where it is: depth is a request field (`src/mcp/tasks.ts` line ~359,
`depth: z.enum(['short','deep'])`), stored on the run, and passed as
`--depth` by `src/projects/coordinator.ts` (~line 1895). The attempt loop
and `DeepeningSignal` are in `src/run/depth.ts` (`runDepthTask`, line ~229;
the signal is thrown when the entry cell "exhausted supervision").

Measured: `f74c140a` ran `--depth short` for 15 min 30 (5 executions,
2 `recordFailure`, 2 skill revisions) before deepening and replanning from
scratch. Its goal had five numbered findings.

Steps:

1. Read `docs/decisions/seed-inheritance-2026-09-25.md` (the deepening restart) and
   `src/run/AGENTS.md`. Find who chooses `short` for project runs today:
   the MCP client passes it; check whether the `atoma_goal` prompt or the
   coordinator ever defaults to it.
2. Proposal 1 (cheap, no new heuristic): in the MCP tool description of
   `depth`, say that `short` is for one named defect with one criterion,
   and that a goal with numbered findings or several criteria must be
   `deep`. This changes the guidance text only.
3. Proposal 2 (a gate, so adversarial review applies): in `runDepthTask`,
   deepen after the FIRST `recordFailure` of the entry cell when the goal
   carries more than N acceptance criteria. Measure N from the local
   corpus before choosing it (count criteria of short runs that
   delivered). Write the review notes under this item.
4. Regression test for proposal 2: a short run with a three-criteria
   checklist whose entry cell fails once must emit a `topology` event with
   `at: 'deepening'` on the next attempt.
5. Measure on the next `short` project run that fails.

Done when: the description text is live (proposal 1) and, if the owner
accepts proposal 2 after the review, its test passes.

## E. Ladder: never descend to a molecule whose tools cannot produce the proof

Goal: when an L2 retries a subtask with another molecule, it skips
candidates whose toolbox lacks a tool the task's evidence requires.

Where it is: `src/atoms/L2Atom.ts` prefilter and reuse path (grep
`prefilter picked`, `carryTaskCoaching`, `fromType(childType)` ~line 1827
and 1873 for the branched retry); `src/core/phaseBudget.ts` `ladderSpent`;
`src/atoms/L3Atom.ts` ~line 935 hands a spent ladder to root acceptance.
Tool declarations per molecule come from the registry (`toolNames()` on
the child is used at ~line 1796 for `undeclaredToolMentions`).

Measured: phase 1 of `85cc4e83`, 02:37 → 02:44, Methane (HTTP server
builder, no `validate_html`) tried three times a task whose validator
asked for executed browser width and reload checks, then the L2 fell back
to self-execution. About 7 min.

Steps:

1. Read `src/atoms/AGENTS.md` on the prefilter and the ladder; check the
   intentional-choices section for a rejected "capability match" shortcut
   before designing this.
2. Define "required tools" mechanically, no model call: the tools named in
   the validator's refusal text and in the acceptance checklist items
   (`validate_html`, `record_probe`, `start_node_server` are the ones that
   matter here). `undeclaredToolMentions` already parses tool names from
   text; reuse it.
3. When choosing the next candidate on the ladder, drop a molecule missing
   one of those tools and log why (`[L2] skipped Methane: lacks
   validate_html required by the refusal`). If every candidate is dropped,
   go straight to the fallback the code takes today.
4. Regression test: an L2 whose first child is refused for a missing
   `validate_html` check must not pick a candidate without that tool.
5. Adversarial review: can this starve a task of every candidate on a
   wrongly parsed tool name? Bound it: only tools the current child
   declares count as "required".

Done when: the test passes and the log line above appears in a real run
where it applies.

## F. Skill revision after failure: off the critical path or bounded

Goal: the gpt-5.6-terra skill revision that follows an L2 failure does not
add a minute to each retry.

Where it is: `src/atoms/L2Atom.ts` ~lines 1760–1835: after a failure the
cell asks the skill model for a revised body, saves it with
`mechanism: 'revised'`, records `op: 'update'`, then builds the fresh child
with the new body injected. It is awaited before the retry.

Measured: 55 s and 60 s on `f74c140a`, 10 + 34 + 12 s on `85cc4e83`, all
serial. The run stats then reported `discardedLessons` 15 and 9.

Steps:

1. Read `src/skills/AGENTS.md` (learn, credit, revision) before touching
   this; the revision is part of the skill lifecycle contract.
2. Option 1: run the revision concurrently with the child's re-plan
   (`plan` is 6–8 s, so the win is partial) and inject the revised body
   only if it is ready when execute starts; otherwise retry with the old
   body and keep the revision for the next attempt. Option 2: cap the
   revision call (output tokens and wall time) so it cannot exceed ~15 s.
   Option 3: do it on gpt-5.6-luna. Pick after measuring the revision's
   value: compare, on the local skills store, how often a revised body was
   followed by a credited success. Record the numbers here.
3. Whatever option: the `op: 'update'` trace event keeps its meaning.
4. Regression test: with a mocked skill model that takes 5 s, the retry's
   `llm-start execute` must not wait for it (option 1) or the call must be
   aborted at the cap (option 2).

Done when: the measured numbers are in this file and the chosen option's
test passes.

## G. Execute retries: keep what the molecule already read

Goal: a retried execute does not spend its first seconds re-reading the
files the previous attempt read, and does not re-send them as fresh input
tokens.

Where it is: `src/atoms/L2Atom.ts` builds a fresh child per attempt
(`carryTaskCoaching(child, L1Atom.fromType(childType))`, lines ~1638, 1827,
1873); the trace shows a `context` event per attempt. The L1 prompt and
its tool loop are in `src/atoms/L1Atom.ts`.

Measured: 232 `read_file` in the first 15 s of 18 executions on
`85cc4e83`, 128 on 12 for `f74c140a`; 3.1 M input tokens on `85cc4e83`.

Steps:

1. Read `src/atoms/AGENTS.md` and `src/core/AGENTS.md` on context carry
   and cache breakpoints; the cost rules there are load-bearing.
2. Smallest change: carry a "files read last attempt" digest into the
   fresh child's injected context: path, size, hash, and the first lines
   of each, capped (say 8 files, 2 KB each). The molecule still may re-read;
   it just no longer needs to for orientation. `injectContext` exists.
3. Larger change, only with an owner decision: continue the same execute
   session on retry, appending the validator's refusal as the next user
   turn. This changes cache behaviour and trust accounting; write the
   proposal under this item and stop.
4. Regression test for the small change: a second attempt's context block
   lists the files the first attempt read.
5. Measure: `read_file` count in the first 15 s per execute, before and
   after, on one real run.

Done when: the digest is injected, the test passes, the measurement is here.

## H. Minor: validate-plan always deferred; Adrenaline never trusted

Two observations, each a one-hour look, no change until measured:

1. `validate-plan` Jev outcome was "deferred to the model" on every call
   of `85cc4e83` (12 calls, 77 s) and on most of `f74c140a`. Read
   `memory/jev-calibration-2026-10-10.md` and the Jev thresholds; report
   whether the plan-time features ever reach the decision threshold on
   this corpus. If they never do, propose dropping the Jev pass at plan
   time (it costs ~0.4 s each) or recalibrating; do not change thresholds
   in this item.
2. The trust fast-path fired for CarbonDioxide (93 ✓ / 25 ✗, "13
   consecutive successes") and Benzene, never for Adrenaline (99 ✓ / 25 ✗).
   `consecutive_successes` lives in `src/registry/db.ts`; the fast-path
   decision is in `src/atoms/L2Atom.ts` ~line 2601 onward. Report
   Adrenaline's consecutive count in the production registry
   (`atoma_registry_show`) and whether its failures on these runs were
   evidence refusals (item A) that reset a counter a delivered result
   would not have.

Done when: both reports are appended here with numbers and a recommendation.

## Not in this plan

- Persistent Haystack process to remove the 32 s warm `pythonInitMs`
  (noted under C; separate decision).
- Model choice for the L3 replan (45–56 s on gpt-6-astra, twice per run);
  small and not on the owner's cost rules to change lightly.
