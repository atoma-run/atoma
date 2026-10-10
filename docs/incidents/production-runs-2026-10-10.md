# Production runs after the registry reconciliation — 2026-10-10

Twelve runs on `atoma.run`, 06:26–09:20 UTC, launched through the MCP by the
platform admin, to see the day's changes on real work: the Jev readers and
the twin-agent fold, template families, narrowing seeds, labels by
signature, and the five identity merges of the morning
([the clone engine](../registry-reconciliation-2026-10-10.md)). Two new
projects, ten continuations of delivered workspaces; every deliverable left
unaccepted and unpublished. Models `gpt-5.6-luna/terra/sol` on the host's
ChatGPT subscription.

## The runs

| # | Project | Kind | Outcome | Duration | Cost |
|---|---|---|---|---|---|
| 1 | Typing studio | web, continuation | partial — reload and keyboard journey never observed | 71 min | $1.49 |
| 2 | NDJSON redactor | CLI, continuation | delivered, one recipe learned | 5.6 min | $0.25 |
| 3 | Pantry Ledger (new) | HTTP API | delivered | 6.2 min | $0.27 |
| 4 | Recipe scaling | documentation | delivered, one recipe learned | 4.6 min | $0.18 |
| 5 | Transit explorer | web, continuation | FAILED — `UNIQUE constraint failed: atom_type_versions` | 4.8 min | $0.15 |
| 6 | Transit explorer | same goal, after the fix | delivered, reload observed with F5 | 9.8 min | $0.31 |
| 7 | Tidewatch (new) | static web | delivered | 4.4 min | $0.18 |
| 8 | Pantry Ledger | full-stack, continuation | delivered | 10.3 min | $0.32 |
| 9 | Markdown link auditor | CLI, continuation | delivered, recipe and event recipe learned | 5.9 min | $0.19 |
| 10 | Canopy Accord | text, sensitivity note | partial — one variation left indeterminate, refused | 7.2 min | $0.46 |
| 11 | Duplicate file finder | CLI, continuation | delivered, one recipe learned | 4.0 min | $0.15 |
| 12 | Typing studio | retry seeded from run 1 | partial — the same two gaps | 21 min | $0.50 |

Eight delivered, three partial, one failed; $4.45 in all, of which $2 on the
two typing-studio attempts.

## Two defects the merges caused, both fixed the same morning

- **A merged loser's name was reissued.** `mergeInto` deleted the loser's
  version rows after transplanting them; the allocator reads live rows ∪
  history, so the ordinal was free. Run 1's escalation branch of Water
  (the template-born variant of the web signature, which the family rule
  cannot find under a canonical whose prompt is not a template) came out
  named **Glucose** at 06:35, and the first cell a tissue created at 07:05
  came out **Trichome** — both dead names, inherited in every earlier trace.
  `e100bdb1`: the merge leaves a `[merged into <winner>]` tombstone, as
  `remove` leaves `[removed]`. The two reissued names stay; a name is a
  display label, the identities are new.
- **A merged winner died on its second patch.** The transplanted history
  sat at synthetic versions above the winner's live version, which the
  merge never lifted; the second patch archived the live content at a
  taken number and run 5 failed on the UNIQUE constraint, on Water.
  `af607480`: the merge lifts the live version, and `patch`/`rollback`
  archive at max(live, highest archived + 1), so the five winners repaired
  themselves on their next patch. Run 6 proved it on the same goal.

## What the day's mechanisms did

- **Narrowing seeds work.** The first created cell of the afternoon is
  `Guard` (07:41): four tools — `read_file`, `list_files`, `run_shell`,
  `record_probe` — under an eleven-tool tissue, where every cell created
  before carried its parent's whole set. Its label is the planner's
  ("Clean-checkout verification orchestrator…"), a novel signature as the
  rule allows.
- **Template families hold.** Tier 1 ended the day with seven molecules
  (six winners plus Glucose, the web template variant); no further
  molecule was created in eleven runs.
- **Trust re-earned.** CarbonDioxide, Methane and Protoplast were trusted
  again within the window; Water sits at a streak of 1, Adrenaline at 0.
- **Tissue routing still writes a tissue per domain**: `Endodermis` for
  run 10's sensitivity note, the eleventh tissue. By design, and the
  clone pattern one tier up ([record](../registry-reconciliation-2026-10-10.md)).

## The Jev reading on the window

`atoma_jev_calibrate` since 06:00 UTC, 12 traces, 80 decisions, $0.03:

- **0 unparsed** (502 of 1,190 in the earlier window), **0 recipes replayed
  without their opening steps** — both readers fixes measured.
- Agent picks: 21, every one deferred at the documented thresholds, **no
  disagreement at any threshold** of the sweep except three at 0.3/0.5;
  the Benzene/Ammonia pair never appears. The fold did what it was
  measured to do; 0.7/0.5 would decide 4 of the 21, all agreeing.
- Plans: 2 decisions; results: 24, one approved, none false at 0.7, one
  false at 0.6. Unchanged.
- **The result audit finally has a sample: 10 Jev result approvals judged
  by the model, 3 refused** (children Glucose, Guard, Trichome — runs 7, 4
  and 1). Three of ten is the first measured false-approval share on
  results, after an empty census on October 1–7. Small, but it is the
  number the 100 % audit exists to produce, and it says Jev's result fast
  path is not yet trustworthy on its own.
- Costs over the 12 runs: prefilter avoided 44 of 93 model calls at
  break-even; plan validation avoided 40 of 42 for $0.01 of Jev plus $0.015
  of audit; result validation avoided 10 of 34 and the model fallbacks cost
  $0.28, the audit $0.04. Effort: 59 readings, all undecided (29 approved,
  30 refused executions).

## A repeated incident: the typing studio

Twice (runs 1 and 12, $2.00, 92 minutes) the web molecule proved
completion, best-preservation, clearing, timer and reset, and twice it never
produced the two observations the criteria named: a reload with the best
still shown, and a passage selected and a test completed with Tab and Enter
only. Run 6 on another page did observe an F5 reload. The second attempt
was seeded from the first and told exactly which observations were missing;
it still reported them in prose. Not a defect in the day's changes — a
molecule that does not perform the check it is asked for, and a validator
that correctly refuses prose — but the same gap at $1 a time is a
candidate for the analyst: what the molecule's prompt says about reloads
and keyboard journeys, against what `validate_html` can replay.
