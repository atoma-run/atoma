---
name: jev-calibration-2026-10-10
description: "Jev reading of the Oct 1–9 window (1190 decisions, $0.19) — verdicts on threshold changes, the 42 % unparsed cause (run actors) fixed in ee0ed038, what is still open"
metadata:
  node_type: memory
  type: project
  originSessionId: 7f8e1401-022c-4c27-80f8-737bb447be7a
  modified: 2026-10-10T13:57:52.273Z
---

Reading of 2026-10-10 with `atoma_jev_calibrate` (includeJevRuns, 191 traces, 6 orgs, 563 asked, $0.188; resultIds a5755cda…, 9bfb5a1e…, eee73ec8…, 76852dbb… reusable for free with `resultIds` + `sweep`).

**Facts to keep straight** (I got them wrong first):
- With `includeJevRuns` the replayed sample is Jev's own DEFERRAL band, not its live behaviour. Live Oct 1–7: Jev approved 108/211 plans, 16/112 results (docs/jev-calibration-2026-10-07.md). A sweep is still the right counterfactual for a threshold change.
- Result audit is 100 % since 2026-10-07 (`JEV_RESULT_AUDIT_RATE = 1`); "0 audited" = no Jev result approval in the window.
- Live Jev sees recipe `opening_steps` (jevQuestions.ts); the calibration replay cannot, so recipe agree/disagree from traces is not evidence. `recipeOffer` 0.5 was measured on 116 credited matches (2026-10-06).
- Benzene and Ammonia are near-twin L1 file scribes (Benzene = + search_project_docs); their mass-splitting is the likely cause of low `confidence` deferrals on agent picks.

**Verdicts**: plans stay at `requirementCovered` 0.8 (1 false approval appears at 0.7, the 0.61+0.17-drift margin); results stay at 0.7 (2–3 false approvals at 0.6 — the margin below 0.7 is gone, new vs Sept); agent picks 0.7/0.5 is a NEW operating point (33 agree / 5 disagree vs 10/5 on the deferred band) worth a written-up measurement, not applied; recipes untouched.

**Shipped 2026-10-10** (all in prod): ee0ed038 readers leave every run actor out (502/1190 "unparsed" were `run-criteria`/`run-text-reference`/`run-router`; re-read gave 2 unparsed of 690); cf1e611a the deferring `jev` event records recipe `details` (opening steps) and the calibration pairs them by actor, `recipesWithoutDetail` counts bare replays; 73d8fbe4 `buildChoice` folds twin agents (tools ⊇, prose prefix) into ONE option dispatched as the NARROWEST (owner decision: Ammonia over Benzene). Numbers in docs/jev-decisions-2026-09-28.md "twin agents — 2026-10-10".

**Registry reconciliation (same day, owner decisions)**: cooling-off leftover removed from src/registry/AGENTS.md (8792d1c5); docs/registry-reconciliation-2026-10-10.md names four clone mechanisms (union of tools, template revision = clone generation, lexical label filter, tissues cascade 11 tools). Shipped 312cffb7: `createOrRefresh` (family = tier+tool names+params+template header, streak KEPT), `scopeTools` (seed names narrow; schema keeps names), labels by signature. Owner delegated the winners to me (2026-10-10): Water←Glucose,Sucrose,Serotonin; CarbonDioxide←Ethanol,Methanol,Acetone,Caffeine,Dopamine,DNA; Methane←Hemoglobin; Adrenaline←Insulin,Chlorophyll (relabel canonical); Protoplast←Trichome (relabel canonical). Benzene/Ammonia: NO fusion (decided, reasons in the record). Tooling shipped: `registry merge` CLI + `atoma_registry_merge` MCP (platform, dryRun, archive under <store>/archives/registry-merge-*). EXECUTED 2026-10-10 05:53 UTC via MCP (92322880 deployed): tier 1 now Water, Methane, Ammonia, CarbonDioxide, Benzene, Adrenaline; archives under /home/atoma/state/archives/registry-merge-*; ledger check ok. Winners' streaks reset — watch them re-earn trust. `registry dedupe` groups by NAME and is useless for signature clones.

**Campaign 2026-10-10 (12 runs, $4.45, docs/incidents/production-runs-2026-10-10.md)**: merges caused two defects, fixed same day — name reissue (e100bdb1 tombstone; Glucose and Trichome are REISSUED names, new identities) and UNIQUE version collision on winners' second patch (af607480, self-healing). Narrowing seeds proven (cell Guard, 4 tools). Jev window: 0 unparsed, 0 bare recipes, no agent disagreement, fold worked; **result audit 3 refused of 10** — first sample, Jev result fast path not trustworthy alone. Typing studio refused twice for unobserved reload/keyboard checks ($2) — analyst candidate. Deliverables left unaccepted/unpublished.

**Afternoon 2026-10-10**: c2b41f88 `validate_html` `{type:'reload'}` + selectorless `type` at focus; F5/Ctrl+R refused (F5 via Puppeteer never reloads — run 779d854c's "reload" proof was false, its delivery must not be accepted as is). 8acd1a6d: pre-tombstone merged names stay taken (Sucrose was reissued at 09:06). 491a8e4e: validators keep latest 8 browser lines + latest PASSING run of each other check (unchanged doc, ⅓ budget). c8dc2f47: subsystem AGENTS.md budget 600→700 (owner). Typing studio rerun e957af55: c1 reload now MET; remaining refusals are criterion wording (native <select> needs arrows, not Tab+Enter) — don't rerun as is. Deploys wait for live runs: check `gh run list` before starting a run.

**Late afternoon**: 082014f4 selectorless `type` refuses a focused control that takes no text (a space presses a button). b890c978 keyboard guidance: a focus check + same-key-prefix activation check on the same document = one journey (smoke runs once, after all interactions). Typing studio 0940fe3e and transit favourites 50be47bf DELIVERED (all criteria met, reload real). Lesson: a continuation goal must ask to re-prove every criterion in THIS run — "already proved" makes the molecule skip them and the root (attempt-scoped) refuses.

**Open**: verify the fold on the next window (expect the 4 Benzene/Ammonia disagreements gone and fewer `confidence` deferrals); recipe agree/disagree becomes meaningful only on traces after cf1e611a; agent 0.7/0.5 still a candidate, not applied.

**Why:** owner asked whether my threshold recommendations held; the contract says a threshold moves with a written-up measurement, never by feel.
**How to apply:** before recommending a Jev threshold change, re-read docs/jev-decisions-2026-09-28.md "The switch" table and the 10-07 review; quote live take rates, not deferral-band ones. See [[jev-decisions-state]].
