# Skills — AGENTS.md

`src/skills/` owns persistent task patterns: learn, match, inject, earn credit,
compile, dispatch — and the operator lifecycle actions over them.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
This file is the whole skills contract.

Neighbours:

- [`src/atoms`](../atoms/AGENTS.md) — dispatch and credit in the supervision loop
- [`src/contracts`](../contracts/AGENTS.md) — manifest merge identity
- [`src/cli`](../cli/AGENTS.md) — the operator commands

## Lifecycle

Skills follow learn → compile → match → deterministic dispatch or inject →
credit. Compilation happens AT LEARN TIME and dispatch needs no earned runs,
by owner decision on 2026-09-26
([compile-at-learn record](../../docs/compile-at-learn-2026-09-26.md)).

- ONE catalog, ONE trust, for every run on the platform — a run is a run
  ([platform trust record](../../docs/platform-trust-2026-09-15.md)). BODIES
  live in the platform `ATOMA_SKILLS_DIR`, under stable atom-id namespaces
  (`skills/<atom-id>/`); TRUST (counters, stamps, matches, provenance) is one
  row per recipe in the product store, `skill_meta`, since 2026-09-18 (W4,
  `metaStore.ts`). Every mutation is ONE `.immediate()` transaction that
  writes the row and inserts its lifecycle event on the same handle; the
  increment is computed by SQLite, never read-then-written. `_namespace.json`
  publishes the molecule label and tool names (schema in
  `contracts/skillCatalog.ts`) so a reader resolves a namespace without the
  registry. `SkillRegistry` takes a root and, optionally, the store handle:
  the runner passes its `openDb` handle, the viz its primary store, the CLIs
  their `--db`; handle-less readers resolve the ledger's store and never
  create one. Rows are keyed by namespace and skill id — one store pairs with
  one catalog; a legacy per-project tree is read `sidecarsOnly`.
  `reconcilePlatformSkills` (coordinator startup, runner before a run) first
  imports every legacy `_meta.json` that has no row and retires it as
  `_meta.imported.json` (bytes untouched, never a source again), then folds
  the earlier partitions in, each idempotent and each setting aside what it
  displaces beside the catalog: `.trust/<project>/<sha>/` sidecars are added
  into the recipe's row; recipes under an atom identity the registry fold
  absorbed (`atom_id_merges`) move under the kept identity WITH their rows
  re-keyed, duplicates summed and journaled as a `skill-merge` naming the
  absorbed entity and the counters moved. `migratePlatformSkills` imports the
  2026-09-09 per-project trees once, counters added, originals and a backup
  kept; conflicting bodies at one identity refuse migration. All signed-in
  users can browse the catalog. Operator and MCP arguments go through
  `resolveMoleculeRef` (name or id → `{ atomId, name }`). A legacy sidecar
  that will not parse is never imported: every mutation refuses, writes
  nothing and journals nothing. Never turn corruption into valid zero counters.
- FILE + ROW PAIRS have no transaction across them, so each states its crash
  order at the call site, and the shared rule is: body first, row second, and
  a body that outlives its row never inherits trust. `save` zeroes the row
  when it CREATES a body (`skill-save` with `created: true`, which the
  projection zeroes on); `drop`, `merge` and `dropNamespace` remove the folder
  before the row, as the sidecar era did — the reverse was reviewed and
  rejected because a body that outlives its row reads below the ledger, the
  IMPOSSIBLE direction; `promoteToScript` writes the fallback, then the zeroed
  row with its `promote` event, then SKILL.md as the commit point.
  `projectCounters` zeroes an entity on `skill-drop` and the absorbed entity on
  `skill-merge`, so a re-created id never reads IMPOSSIBLE. Mutations refuse
  to run inside a caller's transaction, where `.immediate()` would silently
  become a savepoint.
- EVERY skill event NAMES ITS OWNER. `l1Name`/`l1AtomId` on a `SkillEventInfo`
  are the namespace the body and the counters live under — the pair a reader
  addresses `/api/skills/:ns/:id` with — and the molecule that RAN the recipe
  goes in `executorName`/`executorAtomId`, present only when the two differ.
  A donor match is ordinary under the shared catalog, so this is not an edge:
  until 2026-09-24 `inject` and `quarantine` wrote the EXECUTOR into the owner
  pair, which handed the viz a link into a namespace holding no such recipe
  (404 on every donor match) and filed the trajectory's pending skill under a
  molecule that ran nothing. Never widen the owner pair to mean "the molecule
  this event is about": two facts, two fields.
- Match against reusable `when_to_use` capability language, not task theme or
  hidden workspace state the prefilter cannot inspect.
- The skill prefilter runs only when candidates exist. Injection is guidance;
  it never guarantees adherence or credit.
- Two things no recipe step changes (`RECIPE_STEP_LIMITS`, in the llm and the
  event blocks; never in a script block, which runs verbatim):
  - A file that exists is changed with edit_file where a step says write_file,
    unless the subtask says to discard it or put an earlier version back.
  - A "do not rerun" step never covers a new example.

  Distilled recipes keep the tools their traces showed: run 0b51e494 rewrote
  a page whole, byte for byte, by such a step, and dadeea78 left a README
  example's output worked out. The adherence check shows the validator the
  same lines with the recipe, so obeying them never costs the recipe its
  credit.
- Credit is usage-conditioned. Atom-type counters move with child outcomes;
  skill counters move only when the skill demonstrably drove the attempt.
- Where a root acceptance judges the run (depth routing), distillation and its
  compile wait in `ctx.deferredLearning` for that pass's verdict: approval runs
  them under the finalization signal, any other end drops them and counts
  `discardedLessons` (owner decision 2026-10-09: run fc2a68cf learned from a
  phase the root refused). Credit is unchanged; other runs learn at once.
- Updates after failure are opportunistic. Invalid skill JSON must not fail an
  otherwise valid run, and an unchanged body is not a revision.
- Auto-created/revised skill bodies must stay within the owner's toolset and
  generalize beyond the triggering task. No task-specific literals.
- An approved L1 run that actually persisted a command `record_probe` gets one
  independent verification extraction if primary distillation omitted a usable
  sibling. The transport witness includes expected nonzero exits and survives
  the bounded tool-call list; model prose cannot supply it. Reused LLM build
  recipes take only this extraction path. Learning, approval and read-only
  phase gates still apply, as do toolset, exact-id and Jev twin guards. No probe
  means no extra call; extraction failure preserves the primary and a later
  approved build may retry. This is one L2 call, not a free Jev evaluation.
- A recipe that CAN be compiled IS compiled, the moment it is learned:
  `learnSkillFromRun` saves every draft, then runs `tryPromoteSkill` on each,
  with the run it was distilled from as the compile example. The promote
  threshold (`ATOMA_PROMOTE_THRESHOLD`) defaults to ZERO; an uncompiled
  recipe (learned while promotion was off, or under a raised threshold)
  is reconsidered at its next credited success. Historical `failures` do NOT
  veto compilation (owner decision 2026-10-01): Jev assesses the current recipe
  against the complete compile request and runtime contract. A confident
  obstacle postpones this attempt only; it writes no refusal stamp and is
  rechecked at the next learning/credit opportunity, without a cooldown or
  earned-success streak. No answer or uncertainty lets the compiler decide.
  The owner authorised deployment then live MCP calibration on 2026-10-01; see the
  [decision record](../../docs/jev-decisions-2026-09-28.md#compilation-eligibility-owner-decision-2026-10-01).
  Compiler/scan refusals retain their generation-scoped stamps. Every
  `demoteToLlm` stamps the generation that produced the failed script, for
  both supervised and deterministic failures; a body/compiler change or an
  operator reset permits another attempt. Jev never authorizes execution.
- Promotion is ON by default for every run, seeded or from scratch. Only
  `ATOMA_SKILL_PROMOTE=1` counts as an explicit opt-in; any other explicit
  value disables it, and `--no-promote-skills` is the final veto over the env.
  MCP `promoteSkills:true` maps to the explicit env opt-in. Direct library use
  stays opt-in (the hook reads `=== '1'`), like learning.
- Promotion resets the counters: the script's record is its own. A script is
  trusted for deterministic dispatch from its FIRST match when it has no
  recorded failure AND a non-empty `_fallback.md` (`shouldTrustSkill` reads no
  threshold). Every preflight gate still applies. An untrusted script runs
  through the normal L1 tool loop.
- A dispatched script's result is VALIDATED like a molecule's — result gates,
  ground-truth probe, Jev, then the model — less the type's trust fast path,
  whose counter the molecule's model earned (`validateScriptDispatch`, owner
  decision 2026-10-06, [record](../../docs/script-dispatch-validation-2026-10-06.md)).
  Jev approving keeps the dispatch free of model calls; otherwise one
  validation call is paid. Its evidence is the script's own attested write and
  run, picked by scratch filename, which is the dispatch's own
  (`_skill_<id>.<namespace>.<dispatch>`: the lane and workspace are shared
  with siblings, whose cleanup must not delete it); the
  host's snapshot, gate reads and cleanup run on the base executor. Its gates
  read the run's one-shots but never spend them. A refused result is set aside
  like an upstream content rejection: no counter moves, and the run's
  anti-redispatch memo keeps it from being validated twice. A script that RAN
  in a phase and was set aside is never handed back to the L1 to run again; a
  `set-aside` event names the cause (`ScriptSetAsideCause`). The molecule runs
  with no active-skill tag, so it neither credits nor blames the script, and
  opens no verification extraction. After a contract failure, a tool error or
  a failed validation it gets the `_fallback.md` recipe as guidance; after the
  deliverable gate, the anti-redispatch guard or a refusal — each saying the
  script's job is not this phase's — it gets no recipe, and a refusal's reason
  as coaching. A pre-flight skip still injects the script, as for an untrusted
  one. A result accepted without credit (a read-only phase below a tissue,
  restored writes, an uncovered obligation) emits `direct` then
  `credit-withheld`, and counts as a deterministic phase.
- Output intent is STRUCTURED first: plans declare `outputs` on every
  file-mutating subtask (threaded onto the child Task) and compilers declare
  `writes` in the promotion envelope, cross-checked once against the static
  resolver and persisted on the recipe's trust row. The lexical grammar in
  `scriptTargets.ts` is the FALLBACK for legacy plans/scripts — never grow it
  a new clause for a phrasing the declared field would have carried.
  Without output paths, the skill prefilter supplies semantic `fileEffect`:
  Jev reuses its existing decisive `task_changes_files` answer; model fallback
  supplies the same shared contract. Capability filtering waits for this answer
  before applying lexical intent, and direct dispatch uses the same resolved
  Task. Declared output paths always win. Semantic intent never sets the host's
  `readOnly` restoration policy; uncertainty or omission keeps the old fallback.
- Script stdout ends with exactly one JSON envelope containing non-null `output`
  and string `summary`. Malformed envelopes and `FAILED`/`ERROR` summary prefixes
  fall back to the validated LLM path; do not invent a separate `ok` field.
- Compiled verification consumes `.atoma-probes.json`; if the manifest exists,
  it is the authority over prose. Preserve each entry's recorded semantics.
- Scratch Node scripts use `.mjs`. The workspace may define incompatible `.js`
  semantics and is fenced from the repository module system.
- Static scanning and compile/refusal stamps are generation-aware. Compare via
  `refusalStampIsCurrent`, never raw constants; fail closed on invalid config.
- Manifest entry shapes are bucket-specific. Shell commands are bare commands,
  not decorated exit-code wrappers. HTTP manifests are ordered sequences.
- `when_to_use` matches subtask text alone. State-on-disk requirements belong
  in the body/preflight, not the match trigger.
- Prefer a sibling compilable skill over overwriting a useful LLM recipe.
- The distiller SEES the visible namespaces' skill ids and `when_to_use` lines
  and is told not to re-learn them. The only mechanical guard is exact-id
  equality, so a SEMANTIC TWIN under a fresh name is the failure mode to
  design against: each twin pays its own compile call, and both then compete
  for every match, splitting the credit and failure evidence of one pattern.
  Measured 2026-08-21: one 6-task batch learned 11 skills, 6 of them three
  twin pairs.
- THE TWIN GUARD: when `ctx.jev` is present, Jev compares each draft with the
  recipes it would compete with — the visible catalog for a task recipe, the
  namespace's recovery recipes for an event one — and a draft it names a twin
  is NOT saved ([owner decision](../../docs/jev-decisions-2026-09-28.md)). No
  answer saves as before: a wrong "twin" costs one lesson, never a recipe.
  Measured 2026-09-28 on the production catalog: three recovery twins on
  Glucose, never matched, and lexical overlap separates twins from
  look-alikes no better than in August.
- `validateProbeManifest` gates malformed machine input before dispatch.
- Anti-redispatch state is run-scoped and keyed on a digest of the output AND
  summary: a new output under an old summary is new work, validated as such. A
  repeated deterministic output rejected for content must not earn credit or be
  dispatched again in a later phase.
- Deterministic failure streaks demote brittle scripts, but environment/executor
  failures are not evidence against the recipe.
- A deterministic dispatch must prove the deliverable, not merely that named
  files already exist. Mutating work needs relevant before/after change or
  equivalent evidence; pure verification may remain read-only.
- A script without `_fallback.md` is undemotable and is refused before
  dispatch: `shouldTrustSkill` requires the fallback, so a hand-authored script
  always runs through the validated loop. Enforced since 2026-09-26; before,
  only the earned-run wait kept such a script from running unwatched. Never
  manufacture a fallback after trust was already lost.
- Event-recovery skills match failure classes mid-run and carry zero LLM cost.
  Their triggers describe reusable failure classes, never task themes; they
  are excluded from compilation and its curriculum targets.
- `skills drop`, `merge`, `reset`, `forgive`, and review are operator-only
  lifecycle actions. Preserve provenance and emit ledger events. `forgive`
  retracts MISATTRIBUTED increments surgically (negative integer deltas,
  mandatory reason, floor at zero). Its event and its row write are ONE
  transaction, and the event is appended STRICTLY (fail-closed): for a
  negative delta the safe-loss direction inverts — a counter that moved
  without its event would sit BELOW the ledger, the direction `check`
  reports as IMPOSSIBLE — so a ledger that refuses the row rolls the counter
  back with it, while positive bumps stay fail-open (a lost positive event
  leaves the store ABOVE the ledger, which `check` tolerates). `projectCounters`
  folds the `skill-counter-compensation` event clamped at zero; refusal stamps
  stay untouched — clearing them remains `reset`'s job. Measured 2026-08-21:
  an environment failure is not evidence against a recipe, yet erasing 2
  budget-kill failures via all-or-nothing `reset` cost 7 earned successes. `registry remove` and
  `registry dedupe --apply` drop the deleted atom's skill namespace
  (`skills/<atom-id>/`); `mergeInto` itself does not touch the skill store.
  `registry merge` (2026-10-10) MOVES the loser's namespace under the winner
  (`moveNamespace`): a moved recipe keeps its row and gets a
  `skill-counter-compensation` on its new entity carrying its counters, an
  id the winner holds is absorbed as `merge` absorbs.
- Compilation's measured value is maintenance verification, not from-scratch
  builds. Compiling everywhere at learn time is an owner policy, not a
  measured saving; do not report it as one, and do not spend new rounds
  tuning the compiler unless task decomposition changes.

Checkpointed runs journal a recovery barrier before metadata or body mutations.
This does not disable learning or matching; it refuses replay of a phase that
already changed the commons. See [checkpoints](../../docs/run-checkpoints-2026-10-08.md).

## Intentional choices and rejected shortcuts

- Skill distillation, revision and compilation use a dedicated author role through
  the host request builder, preserving actor/context citations without inheriting
  the L2 delegation schema. The role participates in the compiler generation so
  old schema-conflict refusals may be reassessed (freight run d9bf3716).

- Do not report compilation as the source of build-task savings. Eight rounds
  support tiering, earned trust, and recipe reuse; compilation dispatched mainly
  on maintenance and did not pay on from-scratch decomposition.
- Do NOT restore the earned-run gates as a "safety" fix without the owner. The
  3-success promote threshold, the from-scratch freeze and the 3 clean runs
  before dispatch were removed deliberately on 2026-09-26. What guards a fresh
  script is its mechanical contract — envelope, deliverable gate,
  anti-redispatch, demotion streak to the compiled script's fallback — and,
  since 2026-10-06, the validation of each result it returns: the owner's
  remedy for the gap this paragraph named, after a replay that ignored its
  phase was delivered twice. A defect found in what remains is a finding to
  report, and the remedy is the owner's call.
- Do NOT count a refused validation toward the demotion streak. All six
  project matches of the one production script (2026-10-01 → 10-03) were
  routing mismatches, not a brittle script; demoting on them would punish the
  script for the matcher. The streak counts contract failures only.
- Do NOT edit the compile prompt's "NO validator downstream" line only to make
  it true again. It is part of `COMPILE_PROMPT_GENERATION`, so any edit
  re-opens every current refusal stamp for one more compile call, and the
  instruction it carries — fail loudly, exit non-zero — is still the right one.
- Do NOT lower the `skills stats --sim` default to catch semantic twins.
  Measured 2026-08-21 against three known pairs: they score 0.41, 0.39 and
  0.26 while a build-vs-probe FALSE positive scores 0.31, so no threshold on
  matching-surface overlap separates them and the 0.5 default surfaces none of
  the three. The lexical metric cannot tell "build a Node http service" from
  "probe a Node http service" — same vocabulary. Prevention belongs at learn
  time, where the distiller judges each recipe's claim.
- Do NOT force compilation past a compiler refusal (owner decision
  2026-10-03). Compilation already happens at learn time, and the success
  count never changed a verdict. Each result a script returns is validated
  since 2026-10-06, but a validation judges one result, never whether the
  script can do its class of job, and a refused result only stops its
  re-dispatch within the run, so the refusal is still the step that judges
  the script itself. On that date production held one script
  among 30 task recipes, and the 24 refusals cited task interpretation or
  browser tooling ([record](../../docs/compiled-script-limits-2026-10-03.md)).
- Do NOT give compiled scripts a browser (same decision). Only a
  `validate_html` call through the attesting executor is browser evidence, so
  what a script's own browser reports proves nothing. Recorded web checks go
  stale and need the root's start baseline. In the six phases
  `serve-and-validate-static-page` served, none re-checked an unchanged page,
  and the browser took about 2% of the time.
