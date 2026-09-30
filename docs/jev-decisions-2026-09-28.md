# Jev takes the bounded decisions — owner decision 2026-09-28

The owner's words: "trust Jev, and we will see". TypeSafe's Jev — a typed
decision model that answers Choice and yes/no (Noul) questions over a state,
far faster and cheaper than a model call — TAKES the bounded decisions of a
run wherever it can. It may be wrong; that is accepted. This record states
where it decides, what it cannot do, the rules it deliberately overrides, what
leaves the platform, how to operate it, and how to read the result.

## What was measured before deciding

Over the 39 production runs of 2026-09-26 to 2026-09-28 (27,428 s of wall time,
median run 554 s), the share of wall time during which a call of each role was
in flight:

| role | share | calls |
|---|---|---|
| execute | 85.4 % | 73 |
| plan | 4.0 % | 93 |
| validate-result | 2.8 % | 76 |
| prefilter | 2.3 % | 100 (median 5.8 s, p95 10.4 s per call) |
| validate-plan | 1.2 % | 39 |
| skill | 0.5 % | 21 |
| draft-checklist | 0.2 % | 5 |

The decisions Jev can take are at most about 6 % of a run's wall time. One
execution lasts about 320 s on average, so a wrong pick that costs an
execution costs some 60 prefilter decisions' worth of savings. The owner took
the decision with these numbers in hand.

## Where Jev decides

- **The prefilter** (`prefilterStrategy`): the L2 child catalog, the L3
  catalog (a routing hint to the strategy call there) and the skill catalog.
  After a cache miss, Jev picks a candidate — taken as a high-confidence reuse,
  with a `decomposable` flag from a second question on the agent catalog — or
  `none_of_these`, taken as an escalate. No model call then. Since the switch
  of 2026-09-29 (below) a pick Jev is unsure of — a lukewarm Choice, or a pick
  whose own `fits` question does not say yes — is the model's; at L3 it is no
  hint rather than a model call. When the model decides a skill pick, it is
  not offered the recipes Jev read as contradicting the task on files (below,
  2026-09-30). The mechanical
  guards the callers apply afterwards still apply: the L2 browser redirect,
  exclusions of children that already failed the task. Jev decisions are never
  cached: the cache holds model decisions only, and a cached model decision is
  still served before Jev is asked — save one made on a catalog Jev narrowed,
  which is looked up after Jev withholds the same recipes again.
- **The approval half of plan and result validation** (L2 and L3,
  `jevApproval`). Jev is asked only where a fast path is already admissible:
  after the mechanical gates, with no gate finding, no uncovered proof
  obligation, and a ground-truth probe that requires no review — the trust fast
  path's eligibility without its earned counter. A yes approves with no model
  call. A no, or no answer, runs the model validator exactly as before, and it
  is the model that writes the remediation a refusal needs. Since the switch
  Jev reads the model validator's own evidence lines — transport-observed
  only, never the child's declared probes — and a yes means every requirement
  shown (or, for a plan, covered) and no flag raised.

- **The twin guard at learn time** (`SkillLifecycle.jevTwinOf`): before a
  distilled recipe is saved, Jev is asked whether it duplicates one it would
  compete with — the visible catalog for a task recipe, the molecule's recovery
  recipes for an event one — since the switch, one pairwise Score per existing
  recipe. A twin is not saved. This is the one Jev decision
  whose error is cheap by construction: a wrong "twin" costs a lesson, a
  missed twin costs what the catalog already pays today. The production
  catalog held three recovery twins on Glucose on 2026-09-28, and the lexical
  similarity of `skills stats --sim` still cannot tell twins from look-alikes
  (the lowest twin pair scored 0.21, a pair of different recipes 0.27).

## Where it does not

- **Root delivery acceptance.** Its contract forces a semantic review (a user
  list is always read, a profile without a floor is always reviewed), and a
  delivery is published to the customer's repository automatically. It stays
  the model's, and it is the net under every Jev approval below it.
- **Anything that writes text**: plans, execution, recipes, the acceptance
  checklist, remediation. Jev generates none.

## Rules this overrides, on purpose

- src/atoms: "never introduce fuzzy matching without first adding validation
  above the prefilter fast path". A Jev reuse at L2 synthesises the same
  one-subtask plan as a model reuse, and that plan skips plan validation.
- src/atoms: "atom trust fast paths require the configured consecutive
  approved-result threshold". The Jev fast path requires no earned counter.
- A Jev approval is an ordinary approval: it credits atom trust, and a skill
  that drove the run, exactly like the trust fast path — which has no
  adherence signal either. A wrong approval therefore also inflates trust,
  which can later open the counter-based trust fast path. That compounding is
  part of what "we will see" watches.
- ONE consequence is withheld (`PositiveVerdict.viaJev`): a run only Jev
  approved does not distil a NEW recipe. Compile-at-learn makes a learned
  script dispatchable from its first match, platform-wide and with no
  validator, so without this a single wrong Jev yes on a first run would have
  become a validator-free script in every organisation's runs. Recovery recipes
  are learned only after a model validator's refusal, so they keep one. This
  is a line drawn beside the owner's decision, not inside it: removing the
  condition in `L2Atom`'s `onApproved` restores learning.

## Failure behaviour

- A decision waits at most `JEV_DECISION_TIMEOUT_MS` (2 s) for Jev, then the
  model takes it. A 408, 429 or 5xx is retried once when the wait the service
  asks for (`retry-after-ms`, `retry-after`) still fits that budget, as
  TypeSafe's API reference asks for 429 and 529; a request retried into an
  answer is not a failure. After three failed calls in a run — counted over the whole
  run, never reset by a success, so neither parallel lanes nor a flapping
  service escape it — the run stops asking and records `skipped`. The worst
  case is three timeouts per run. A slow service that still answers under 2 s
  costs up to 2 s per decision, and on a Jev "no" that wait precedes the model
  call.
- A cancelled run sends nothing. A recorder or a decider that throws leaves
  the decision to the model.

## What is recorded

One `jev` trace event per decision asked, answered or not: the role
(`prefilter`, `validate-plan`, `validate-result`, `learn-skill`,
`learn-event-skill`), the candidates, Jev's choice
with its distribution, its yes-probabilities by question (an approval's
`acceptable` is its weakest requirement or flag) and a twin check's pairwise
scores, the OUTCOME (`picked <t>`, `picked none_of_these`, `approved`,
`model decides (<why>)`, `no hint (<why>)` at L3, `deferred to the model
(<why>)`, `not saved: twin of <id>`, `saved: new recipe`, `saved as before`),
a `failure` when there was no usable answer, TypeSafe's `x-typesafe-request-id`
(what its support asks for), duration, usage and cost. A
prefilter outcome is what Jev PICKED, not the route: the L2 browser redirect
may still change the child, and at L3 a pick is only a hint — the route taken
is the child whose `plan` llm event follows in the same lane. The field is
`failure`, never `error`: the analyst's digest reads any event `error` as a run
error. Cost is `estimateCostUsd` on `JEV_PRICES` (0.042 USD per million input
tokens, output free: TypeSafe's models page read 2026-09-29, which the
Cloudflare Workers AI listing of 2026-09-28 matches), recorded on the event and
kept out of the run's LLM totals. Requests name the versioned model
`jev-1.13.0`, never the `jev-latest` alias: the alias moves when TypeSafe ships
a release, and its models page says to pin the version once thresholds are
tuned against it. `servedModel` on each event is what answered.

In the run view each event is a near-white `Jev · <role>` card with its own
`JEV` filter chip, shown only on a run that holds one (2026-09-29; until then
the card fell to the generic branch: title `jev`, no body, a bare clock). The
body is the outcome and any failure; the badge is read FROM the outcome
strings above (`→ <pick>`, `✓ approved`, `↑ model decides` for any deferral,
`↑ escalate` for `none_of_these` and `no hint`, `✕ duplicate recipe`,
`✓ new recipe`; none for `saved as before`), reading a deferral by its prefix,
so rewording one in `src/core/jevQuestions.ts` fails
`tests/jev-decisions.test.ts`, which renders cards from the real decider
through the real recorder.

## Who lets Jev decide, and what leaves the platform

- EVERY run lets Jev decide — every organisation's project runs, existing or
  new, operator runs, local runs, benchmark attempts — whenever its
  environment holds `TYPESAFE_API_KEY`, unless the PLATFORM switch
  `ATOMA_JEV=0` is set on the host (owner decision of 2026-09-30, below). The
  coordinator forwards the key and `ATOMA_JEV=1` into every project run, or
  `ATOMA_JEV=0` when the platform switch is off; operator runs inherit the
  host's environment, switch included. Until 2026-09-30 only the organisations
  the host named in `ATOMA_JEV_ORGS` did, and an operator run needed
  `ATOMA_JEV=1` by hand.
- Each question sends TypeSafe the decision's state: the task text and
  constraints; for the prefilter, the candidates' descriptions, which come
  from the platform commons (capability descriptions, and the ids, descriptions
  and "when to use" lines of recipes distilled from ANY organisation's runs);
  for a validation, the plan or the result (summary and output capped
  separately), its recorded evidence (newest observations kept first, as the
  model validator budgets them) and the ground-truth block (head and tail).
  Since 2026-09-30 that is every organisation's run content, not only the
  operator's, and the service terms (`docs/platform-commons-terms.md`) say so.
- TypeSafe's legal page (docs.typesafe.ai/legal) offers zero data retention to
  enterprise customers on request, commits not to train on customer data
  without consent, and reserves the right to process telemetry, classifications
  included. A direct-API account must be assumed to have its requests retained.
- The key never reaches what a model can run: tool subprocesses get the
  allowlisted sandbox environment, Codex transports an allowlisted snapshot,
  containers explicit variables. A Claude Code subscription child inherits the
  run's environment minus `ANTHROPIC_*`, so it holds the key, with no tools.

## Operating it

On the host, in `/home/atoma/config/atoma.env`:

```dotenv
TYPESAFE_API_KEY=<key>
# ATOMA_JEV=0   # the platform switch: uncomment to turn Jev off for every run
```

`ATOMA_JEV_ORGS` is no longer read; the boot line says so while it is still
there. A change takes effect when the service next starts, which a deployment
does after its preflight. `ATOMA_JEV=0` (or removing the key) and a restart
hand every NEW decision back to the model without a code change. It does not
undo what Jev's decisions already earned: trust counters credited on Jev
approvals are platform-wide and carry no provenance. Reverting them means
reconstructing them from the traces (a `jev` event with outcome `approved`
followed by that child's `recordSuccess`) and correcting the counters by hand.
The server says at boot whether Jev decides (`describeJevAdmission`: "jev:
deciding in every run", or why it is off), and every run writes to its log
either `[atoma runner] jev: deciding` or why not (`ATOMA_JEV=0`, or the key
absent) — readable through `atoma_run_trace` with `section: log`. The service
reads `atoma.env` only when it starts: a line added after the last start waits
for the next deployment or a restart.

## First production runs, 2026-09-29

- `455a4f43` (revision `e461fb6`): no `jev` event. The host line had been
  added after the service's last start, and nothing said so — hence the boot
  and run-log lines above.
- `a5e5f2a1` (short, notes API, `a4265d0`): Jev took both prefilter decisions,
  Methane at 0.81 in 433 ms and `build-in-memory-json-api` at 0.64 in 263 ms,
  where the model had taken 4.7 s and 6.0 s on the previous run of the same
  project. 4 model calls, delivered. Methane is trusted, so no approval was
  Jev's.
- `3e4aaed1` (deep, static page, new project): eight Jev decisions, 214–433 ms
  each — the L3 hint, two child and two recipe picks, one plan and two result
  approvals (p = 0.73 and 0.87) — then root acceptance approved the delivery.
  7 model calls. Tracheid's third consecutive success came from a Jev
  approval, so its next result took the trust fast path: the compounding
  named above, observed on the first deep run. One literal pick: the README
  phase went to Benzene (0.92, "project documentation" in its description)
  over Ammonia (0.04); it did the work, with one needless documentation search.
- `45d27925` / `235a1935` (CLI, new project): Ammonia picked, no recipe fit
  (`none_of_these`), the twin guard judged the distilled recipe new, and the
  next run of the project had Jev pick that recipe at 0.86 — learn, check,
  reuse, end to end.
- `46d8e11e` (deep, full-stack guestbook): thirteen Jev decisions, seven of
  them approvals; Protoplast became trusted on Jev approvals alone. The
  README phase went to Benzene again, the second time in two, so the agent
  question now asks for the candidate with the FEWEST capabilities the task
  does not use. The child pick was Ethanol, an untrusted clone whose
  description is identical to CarbonDioxide's: Jev cannot tell them apart any
  more than the model could — the open catalogue question of 2026-09-16.
- `dbfaf275` (deep, guestbook DELETE): the child pick had a raw confidence of
  0.15 — four full-stack clones at 0.19–0.23 — and "decomposable" at 0.6 bought
  a full Terra cell plan per phase (16 s and 23 s), the prefilter's savings
  spent again. Two fixes: a pick is now read over IDENTICAL descriptions (mass
  summed per description, the group's first candidate in catalog order, the
  canonical type, is taken), and the decomposition question carries the model
  prefilter's own criterion — genuinely orthogonal only — with a conservative
  0.8 threshold.
- `e9a60a26` (deep, guestbook PUT, after both fixes): "picked CarbonDioxide
  (first of 4 identical)", no decomposition, the trusted canonical's fast
  path — 506 s and 7 model calls where the same shape took 855 s and 9.
- `fd64b07e` (deep, pomodoro break mode): the page-changing phase got the
  verify-only `serve-and-validate-static-page` at 0.54 over
  `build-self-contained-static-page` at 0.40 — the build-versus-verify
  confusion the skills contract names — so the recipe question now asks first
  whether the task must change files. The README went to Benzene a third
  time, 0.75 over Ammonia at 0.24 (0.92 against 0.04 before the
  fewest-capabilities wording): the wording moves Jev, not past the line.
  Benzene is trusted now and does the work; left as it is.

## TypeSafe's documentation, read in full — 2026-09-29

The questions above were written from the API reference alone. The whole
documentation (docs.typesafe.ai, `llms-full.txt`: primitives, patterns,
cookbooks, the models page and the agent guide) prescribes otherwise on four
points, and says why:

- **Atomic questions, composed in code.** One broad Noul judging a whole plan
  or result is the shape its guidance warns against; a checklist of narrow
  questions, one per condition, is the shape it teaches.
- **A Choice settles WHICH, a Noul per option settles WHETHER.** A Choice's
  probabilities always sum to 1, so its winner says nothing about whether
  anything fits (the skill-suggestion cookbook, jaggedness note 8).
- **Verification flags are framed so TRUE means something is wrong, and ANY
  of them escalates** (the SDE-cascade cookbook, gated at 0.7; its holistic
  judge is shown but never gated on). The self-consistency cookbook measured
  one Noul moving 0.43→0.53 over fifteen identical calls: a 0.5 threshold, the
  approval's since 2026-09-28, acts on noise; the documented band 0.30–0.70
  goes to review.
- **Pairwise Scores for alignment** (three levels in the entity-alignment
  cookbook): a Choice among existing recipes always crowns the closest one,
  duplicate or not.

It also asks callers to pin the versioned model once thresholds are tuned
(done: `jev-1.13.0`), to retry 429 and 529 with backoff (done, once, inside the
decision's budget), and gives the price: 0.042 USD per million input tokens,
output free.

The documented design is in `src/core/jevQuestions.ts`: one Choice per task
requirement (a result's `shown_done` / `shown_broken` / `not_shown`, the
citation cookbook's three outcomes; a plan's `covered` / `omitted` /
`contradicted`), narrow flags (`reports_incomplete`, `addresses_reviewer`;
`defers_or_refuses`, `vague`, `parallel_dependency`), a `fits` Noul per
prefilter option, the build-versus-verify split asked as two literal questions
compared in code, and one pairwise Score per existing recipe. It decided
nothing until two measurements had set its questions and thresholds.

**How it is measured.** `atoma_jev_calibrate` (platform tier, on the host,
with the host's key) reads the model's prefilter and validation decisions out
of the runs of the organisations Jev decides for — on 2026-09-29 the two
`ATOMA_JEV_ORGS` named, since 2026-09-30 all of them — rebuilds from each prompt the request the
decider would send, asks TypeSafe both designs, and reports each against the
model's decision: false approvals (Jev yes where the model refused, the error
that compounds trust), the share of the model's approvals each design takes,
what blocked the rest, prefilter agreement per catalog and tier, and a sweep of
neighbouring thresholds; twin cases labelled by a person go with it. Runs in
which Jev already decided are left out: there the model judged only what Jev
handed it. The corpus is therefore the admitted organisations' runs of
2026-09-26 to 2026-09-29, before Jev decided.

**First measurement, 2026-09-29** (50 traces, 9 left out because Jev decided
in them; 170 model decisions and 6 labelled twin cases; 0.034 USD; median
262 ms, p95 564 ms; no failed request). The model decision is the reference:

| | documented questions | questions of 2026-09-28 |
|---|---|---|
| plan approvals, 40 (3 refused by the model) | 1 false approval, 84 % of the model's approvals taken | 2 false approvals, 78 % |
| result approvals, 28 (5 refused) | 0 false approvals, 17 % taken | 0 false approvals, 87 % taken |
| agent picks at L2, 48 | 23 agree, 4 disagree, 21 to the model | 33 agree, 15 disagree |
| recipe picks at L2, 49 | 25 agree, 7 disagree, 17 to the model | 36 agree, 13 disagree |
| twin cases, 6 | 6 right at every threshold from 1.0 to 1.75 | 5 right |

It changed the questions before they decide anything:

- The 2026-09-28 plan question does not discriminate: it put two of the three
  plans the model refused at 0.81, above most it approved (0.33–0.85). The
  documented plan questions' one false approval was a plan that stopped and
  restarted a server with no stop tool declared, every requirement covered at
  0.99 or above: a molecule's plan was also asked `needs_undeclared_tool`, the
  check the old question named and the documented set had lost.
- Its result question took 87 % of the approvals with none false, but on a
  thin line: the model's refusals read 0.12–0.47 and nine of its approvals
  0.48–0.59, inside the drift the self-consistency cookbook measured on
  identical calls.
- The documented result flag `contradicted_by_evidence` carried no signal —
  0.06–0.87 on results the model approved, 0.16–0.63 on those it refused —
  and blocked 18 of the 23 approvals. It was removed; what evidence
  contradicts is asked per requirement as `shown_broken`.
- Six recipe decisions the model reused escalated because every recipe's
  `fits` read under 0.3 (best 0.20–0.27): `noFit` became 0.2, which hands them
  to the model and leaves 2 of 49 recipe decisions in disagreement.

**Second measurement, 2026-09-29**, the same 170 decisions asked again with
those changes (0.034 USD). The 472 answers asked twice drifted by 0.00 at the
median and 0.17 at most, always in the middle band; one prefilter pick of 102
flipped, a near tie (0.34 against 0.32). The 2026-09-28 result question,
asked again, took 18 of the model's approvals where it had taken 20: its
boundary at 0.5 is where the drift is.

- `needs_undeclared_tool` does not work: it read 0.48 on the plan it was meant
  to catch and 0.75–0.92 on thirteen plans the model approved — Jev sees tool
  NAMES, not what they do. It is not asked; the one false plan approval stays,
  and the 2026-09-28 question makes it too.
- Without `contradicted_by_evidence` the result questions took 35 % of the
  model's approvals at a 0.8 bar and 48 % at 0.7, with no false approval at
  any bar from 0.6 to 0.9: the refused results read 0.19 or less on their
  weakest requirement, and the one that did not (0.83) reported itself
  incomplete (`reports_incomplete` 0.74).

**The switch, 2026-09-29.** The decider now asks the documented questions:

| threshold | value | why |
|---|---|---|
| `requirementShown` (result) | 0.7 | the documented band's edge; refusals at 0.19 or less, plus 0.17 of drift, stay far below |
| `requirementCovered` (plan) | 0.8 | a refused plan read 0.61 (then 0.58); 0.61 + 0.17 stays under 0.8 |
| `flag` | 0.3 | the band's lower edge: a false approval compounds trust, a deferral costs one model call |
| `pickConfidence`, `fit` | 0.5, 0.7 | agent picks: 21 agree, 4 disagree, 23 to the model; `fit` 0.5 takes ten more, three of them against the model |
| `noFit` | 0.2 | above |
| `twin` | 1.5 | right on all six cases from 1.0 to 1.75 |

What it trades, on these decisions: Jev takes about half the prefilter picks
it took (the rest go to the model, about 6 s each) and disagrees with the
model on 16 % of the agent picks it takes instead of 33 %; it approves 84 % of
the plans the model approves (78 % before) with one false approval instead of
two, and about half the results (87 % before, on the thin line above) with
none. The reading below restarts from this switch: the runs before it
measured another design.

## Every organisation, every run — owner decision 2026-09-30

The owner's words: "toutes les orgs, existantes ou nouvelles, et tous les runs
doivent utiliser Jev, ce n'est pas optionnel (on peut prévoir un flag au niveau
plateforme pour éventuellement désactiver Jev mais par défaut Jev doit être
activé)". Asked first whether organisations that are not the operator's should
be included — their decision states then reach TypeSafe, a processor they had
not been told about — the owner chose every organisation, knowing the service
terms must name TypeSafe.

- `ATOMA_JEV_ORGS` is no longer read. A host holding `TYPESAFE_API_KEY` lets
  Jev decide in every run it launches; `ATOMA_JEV=0` on the host is the one
  platform switch, and it reaches every run (`jevEnabled`, `jevDeciderFromEnv`).
- Benchmark attempts are runs too, so their atoma arms now decide with Jev.
  Rounds registered before 2026-09-30 ran without it; a round after it is a
  different system, and its write-up says so.
- The calibration reads every organisation's model decisions, each foreign
  organisation's read journaled as before.
- `docs/platform-commons-terms.md` states what reaches TypeSafe, dated the same
  day. The operator's privacy notice, which lives outside this repository,
  must name TypeSafe as a recipient too.

## The audit sample, 2026-09-30

Once Jev decides, the model judges only what Jev hands it, so nothing in a
trace says whether a Jev APPROVAL was right: TypeSafe's guidance is to test
thresholds against your own data, and after the switch there was none for
Jev's yes. So a share of Jev's approvals, `JEV_AUDIT_RATE` (10 %), is also
judged by the model validator — the very verdict each call site runs without
Jev — in the background, and recorded as a `jev-audit` llm event.

- It decides nothing. Jev's approval stands whatever the model says; a model
  refusal is counted as a Jev false approval, measured against the model.
- Its own role keeps it out of every reader that counts validations (friction,
  the run report, the calibration corpus), and tells the analyst what it is.
- It costs one model validation per audited approval, on the run's bill, and
  no wall time: the run waits for the audits still in flight only when it has
  finished, at most `JEV_AUDIT_SETTLE_MS` (60 s), before closing its trace.
- `atoma_jev_calibrate` reports the sample for any window — per subject, how
  many audited, how many the model refused, and which — and `auditsOnly: true`
  reads just that, without the key and without sending anything to TypeSafe.

## What the model is offered after a deferral, 2026-09-30

Jev refuses its own recipe pick when the recipe and the task read decisively
opposite on files: `task_changes_files` at or above `changesFiles` (0.7) and
the recipe's `changes_files` below `keepsFiles` (0.3), or the reverse. It then
handed the pick to the model with the whole catalog, and the model, never told
why, could take the very recipe Jev had refused.

Measured on every recipe deferral recorded since the files question was first
asked: 14 runs from 2026-09-29 to 2026-09-30, read from their `jev` events.
Three recipe picks went to the model; two had a contradicting recipe, both
times the verify-only `serve-and-validate-static-page` that Jev itself ranked
first (`changes_files` 0.16 and 0.17 against a task at 0.97). The model
injected it in 0a989a58, into a phase that had to change the page, and it
earned that phase's success credit; in 8606cf38 it chose the build recipe.
Every other recipe offered read between 0.92 and 0.96, so the same decisions
follow from any threshold pair across that gap. (Run fd64b07e of 2026-09-29
predates the question: Jev picked that recipe itself.)

The same reading now withholds every such recipe from the model's catalog
whenever the model decides a skill pick (`JevChoiceDeferral`): on those three
deferrals it changes the one wrong pick and nothing else. The trace outcome
names them (`…; not offered: <ids>`) and the `jev` event carries them as
`withheld`. Nothing changes when Jev picks, at L3, for agent catalogs, or for a
recipe or task read in the middle band. When nothing left fits — every
remaining recipe below `noFit`, or none remaining — Jev escalates itself,
`picked none_of_these (…; nothing else fits)`, badged as an escalation: the
worker runs unguided, which the prefilter prompt calls safe, rather than the
model being handed a catalog Jev reads as fitting nothing. A wrong withhold
therefore costs the model a narrower choice or the phase its guidance; a
wrong injection misleads the worker and credits the recipe for a run it did
not drive.

Known limit: a model decision cached for the whole catalog (up to seven days,
`src/atoms/prefilterCache.ts`) is still served before Jev is asked, so a
byte-identical subtask can still be handed a recipe Jev would withhold. The
runs that showed the rest: [production runs, 2026-09-30](incidents/production-runs-2026-09-30.md).

## Reading "we will see"

Two weeks after the switch of 2026-09-29 (so around 2026-10-13), or sooner if
runs degrade, from the `jev` events and what followed them in the same traces;
the runs before the switch measured the 2026-09-28 questions. After it, the
model decides only what Jev hands it, so `atoma_jev_calibrate` with
`includeJevRuns` measures that sample — the deferrals — never Jev's own yes:

1. **Prefilter picks later refused**: a reuse whose child's plan or result the
   supervisor then rejected, escalated, or deepened — against the same rate on
   the model's picks before the change.
2. **Jev approvals refused above**: an L2 approval whose phase root acceptance
   then refused, and an approval followed by a run that did not deliver — and,
   directly, the audit sample: the share of audited approvals the model
   refused (`atoma_jev_calibrate` with `auditsOnly: true`).
3. **Wall time and spend** per run against the 2026-09-26/28 baseline above,
   and Jev's own latency and failures from the host.
4. **Trust inflation**: atom types whose consecutive-success counter was
   earned on Jev approvals.

If (1) or (2) rises past what the saved seconds pay for, set the platform
switch `ATOMA_JEV=0` on the host and restart.
If it is ever worth making Jev a first-class evaluator, it enters
`modelCatalog.json` through a typed evaluation operation first.
