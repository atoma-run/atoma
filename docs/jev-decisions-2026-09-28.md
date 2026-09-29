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
  `none_of_these`, taken as an escalate. No model call then. The mechanical
  guards the callers apply afterwards still apply: the L2 browser redirect,
  exclusions of children that already failed the task. Jev decisions are never
  cached: the cache holds model decisions only, and a cached model decision is
  still served before Jev is asked.
- **The approval half of plan and result validation** (L2 and L3,
  `jevApproval`). Jev is asked only where a fast path is already admissible:
  after the mechanical gates, with no gate finding, no uncovered proof
  obligation, and a ground-truth probe that requires no review — the trust fast
  path's eligibility without its earned counter. A yes approves with no model
  call. A no, or no answer, runs the model validator exactly as before, and it
  is the model that writes the remediation a refusal needs.

- **The twin guard at learn time** (`SkillLifecycle.jevTwinOf`): before a
  distilled recipe is saved, Jev is asked whether it duplicates one it would
  compete with — the visible catalog for a task recipe, the molecule's recovery
  recipes for an event one. A twin is not saved. This is the one Jev decision
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
  model takes it. After three failed calls in a run — counted over the whole
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
with its distribution or its yes-probabilities, the OUTCOME (`picked <t>`,
`picked none_of_these`, `approved`, `model decides`, `deferred to the model`,
`not saved: twin of <id>`, `saved: new recipe`, `saved as before`),
a `failure` when there was no usable answer, duration, usage and cost. A
prefilter outcome is what Jev PICKED, not the route: the L2 browser redirect
may still change the child, and at L3 a pick is only a hint — the route taken
is the child whose `plan` llm event follows in the same lane. The field is
`failure`, never `error`: the analyst's digest reads any event `error` as a run
error. Cost is `estimateCostUsd` on `JEV_PRICES` (0.042 USD per million input
tokens, the Cloudflare Workers AI listing read 2026-09-28; the direct API's
price is ASSUMED equal until the TypeSafe console says otherwise), recorded on
the event and kept out of the run's LLM totals.

## Who lets Jev decide, and what leaves the platform

- A PROJECT run lets Jev decide only when the host environment names its
  organisation in `ATOMA_JEV_ORGS`. The coordinator then forwards
  `TYPESAFE_API_KEY` and the child switch `ATOMA_JEV=1`, and nothing otherwise;
  a host-level switch never reaches a tenant run by itself. An OPERATOR run
  lets it decide when its own environment sets `ATOMA_JEV=1` beside the key.
- Each question sends TypeSafe the decision's state: the task text and
  constraints; for the prefilter, the candidates' descriptions, which come
  from the platform commons (capability descriptions, and the ids, descriptions
  and "when to use" lines of recipes distilled from ANY organisation's runs);
  for a validation, the plan or the result (summary and output capped
  separately), its recorded evidence (newest observations kept first, as the
  model validator budgets them) and the ground-truth block (head and tail).
  On 2026-09-28 every run that fed the commons was the owner's; NOTHING
  enforces that, and the first run of another organisation that creates an
  agent type or learns a recipe puts its text in what admitted runs send.
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
ATOMA_JEV_ORGS=<org id>,<org id>
```

It takes effect when the service next starts, which a deployment does after
its preflight. Removing `ATOMA_JEV_ORGS` (or the key) and restarting hands
every NEW decision back to the model without a code change. It does not undo
what Jev's decisions already earned: trust counters credited on Jev approvals
are platform-wide — they open the trust fast path in every organisation's
runs, admitted or not — and carry no provenance. Reverting them means
reconstructing them from the traces (a `jev` event with outcome `approved`
followed by that child's `recordSuccess`) and correcting the counters by hand.
The server says at boot whether Jev decides (`describeJevAdmission`: "jev:
deciding in project runs of N organisation(s)", or why it is off, naming any
entry that is not an organisation id), and every run that lets Jev decide
writes `[atoma runner] jev: deciding` to its log — readable through
`atoma_run_trace` with `section: log`. The first run after a deployment must
also hold `jev` events. The service reads `atoma.env` only when it starts: a
line added after the last start waits for the next deployment or a restart.

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

## Reading "we will see"

After two weeks, or sooner if runs degrade, from the `jev` events and what
followed them in the same traces:

1. **Prefilter picks later refused**: a reuse whose child's plan or result the
   supervisor then rejected, escalated, or deepened — against the same rate on
   the model's picks before the change.
2. **Jev approvals refused above**: an L2 approval whose phase root acceptance
   then refused, and an approval followed by a run that did not deliver.
3. **Wall time and spend** per run against the 2026-09-26/28 baseline above,
   and Jev's own latency and failures from the host.
4. **Trust inflation**: atom types whose consecutive-success counter was
   earned on Jev approvals.

If (1) or (2) rises past what the saved seconds pay for, remove `ATOMA_JEV_ORGS`.
If it is ever worth making Jev a first-class evaluator, it enters
`modelCatalog.json` through a typed evaluation operation first.
