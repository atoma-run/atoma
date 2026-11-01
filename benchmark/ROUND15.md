# Round 15 — on the one task where one agent fails, supervision fails the same way: 3 of 6 against 3 of 6, at 6.6× the cost, and H15 is refuted

Run 2026-11-01 05:48–07:13 UTC on the `atoma-bench` worktree at `734abd0c`
(= `main`), the configuration and launch command
[registered the day before](PROTOCOL.md#round-15--amendment-after-the-calibration-2026-10-31-1930-utc-before-any-round-15-run),
after the [calibration](calibration-2026-10-31/CALIBRATION.md) had dropped all
four Attica repository repairs (one `gpt-5.6-terra` agent at 3/3 on each) and
retained one task, `attica-challenge-v1`: implement a pure
`detectChallenge(html): boolean` in a one-file seed, judged by the corpus's
eight-case suite, two of which the seed fails. Terra was 2/3 on it in the
container. Both arms ran through the `benchmark` driver on the host, 6 control
runs (one terra agent, plain tool loop, self-certifying, 1 LLM call) then 6
treatment runs (atoma as shipped, L1 luna, L2 terra, L3 sol, inline learning
retained as `treatmentProtocol: current` demands), 30-minute budget for both.
Workspace anchor: highest `build.prev` before the round 41
([`round15/anchor.txt`](round15/anchor.txt)), so `--first-archive 42`; run
mapping verified by mtime; the last treatment workspace was live when scored.

## Verdict: H15 refuted

H15 required atoma's full-mark count out of 6 to be STRICTLY GREATER than the
control's. They are equal.

| | control (terra direct) | atoma (luna / terra / sol) |
|---|---|---|
| deliverables at full marks (8/8) | **3 of 6** | **3 of 6** |
| scores | 8, 8, 8, 6, 6, 7 | 8, 8, 7, 7, 7, 8 |
| mean cost | **$0.1414** (median $0.1378) | $0.9277 (**6.6×**) |
| cost range | $0.096–0.184 | $0.543–1.492 |
| mean wall clock | **102 s** | 750 s (7.4×) |
| LLM calls per run | 1 | 25–102 (mean 51) |
| learned / injected recipes | — | 1 learned in run 1, injected in runs 2–6 |

Rows: [`results-round15.csv`](results-round15.csv); scores with every case:
[`results-round15-scores.json`](results-round15-scores.json); the driver's
own cost report is appended below unchanged.

The three container controls from the calibration stay beside, never pooled:
terra 2/3 (8/8, 6/8, 8/8, $0.12–0.19), sol 3/3 ($0.26–0.27).

## What both arms got wrong

Every miss is the same case, and no run broke a case the seed already passed:

| case | control misses | atoma misses |
|---|---|---|
| T1 `development-active-challenge` (the goal's own example: `<h1>Verify you are human</h1>` over a `/challenge` form) | runs 4, 5 | none |
| T6 `holdout-challenge` (`<h1>Security check</h1><p>Please complete the challenge to continue</p>` over the same form) | runs 4, 5, 6 | runs 3, 4, 5 |

The held-out case is where the goal's one example stops: the two control
runs that fail it and the three atoma runs that fail it all key the decision
on *verify you are human* vocabulary (`/verify\s+you\s+are\s+human/i` and its
variants — read the six `challenge.ts` of the archives), and "Security check /
complete the challenge" does not match. The runs that pass it either widened
the vocabulary (`security check`, `challenge`, `captcha`) or decided from the
form itself (a `captcha-response` input under a `/challenge` action). The
goal said "document structure and context, not a bare keyword" to both arms;
supervision did not make an executor read that sentence more often than one
agent did. Summed over cases — a metric NOT registered, reported for the
record — the control is 43/48 and atoma 45/48: atoma never missed the goal's
own example, which the self-certifying control missed twice. That is the
whole difference six validators and a root acceptor bought here, and it did
not reach the held-out case.

Atoma's deliveries are complete strict-TypeScript projects (package.json,
eslint, vite/vitest, `dist/`, an install, a test file), per the TypeScript
rule of 2026-10-16; the control's are the one file. Three atoma runs added an
HTML parser (`linkedom`, `node-html-parser`); the goal did not forbid it and
purity is unaffected. The round's secondary, `npm run check` on each delivery,
does not apply: the seed has no package.json, so there is no project check
to run on the control's deliveries and the treatment's would be checking
scaffolding of its own making.

## What inline learning did

Run 1's L2 learned `detect-blocking-html-challenges` (compile refused:
"requires task-specific semantic code reasoning"; an LLM recipe, injected,
never dispatched). Runs 2–6 matched and injected it on every implementation
phase and credited it in runs 2, 3, 4 and 5. With it injected, runs 3, 4 and 5
still failed the held-out case: the recipe carries the task's shape, not the
knowledge that was missing. Cost rose across the series — first half $0.72,
second half $1.14 — because runs 5 and 6 also matched the round-13 recipes:
run 5 set aside the `verify-node-quality-gates` script on contract and
re-planned 18 times (102 calls, $1.49); run 6 injected `migrate-cli-to-strict-ts`,
had its credit withheld ("the run did not follow the recipe") and ended on a
fallback plan and executor (3 escalations, $1.38). Planning is the cost: the
`plan` role is 50–60% of every atoma run's bill ($0.34–0.79), execution
$0.02–0.23.

## The instrument, corrected during scoring and disclosed

`verify-challenge.mjs` as registered (commit `734abd0c`) scored five of the
six atoma deliveries 0/1: it copied each workspace WITHOUT its install, so a
delivery that is a project rather than a file could not load — its own
`vite.config.ts` imports `vite` from the missing install, its own
`vitest.config.ts` `include`s only its own test file, and `node-html-parser`
or `linkedom` resolve nowhere. The product's `atoma-verify` snapshots the
install and runs the suite under `config: false` with a fixed `include`; the
host scorer now does the same (the archive's `node_modules` is linked into the
scratch copy, one explicit config, Vite's cache pointed away from the
archive). Fixed in this commit, before any score was read as a result;
rescored from the same archives; the six control scores are byte-identical
before and after the fix (they are single files), so the fix changed nothing
the registration compared. The rule it enforces was already registered —
scorers judge behaviour, never language or layout — and the first version
violated it.

## Consequence, as registered

The registration said: "H15 refuted (any retained task where atoma is not
strictly better): the README states that the supervision thesis is refuted on
the whole range tested [...]; the single-agent path becomes the product's
default depth, and inline learning is turned off by default."

**Applied in this commit:** the README's measurements section states the
refutation across the whole range measured on the current release — a
60-second maintenance task (rounds 13 and 14), four real repository repairs
where one agent never failed (the calibration), and one small detection task
where one agent fails half the time and supervision fails the same half.

**Owed to an owner decision, not applied here:** the two product defaults.
Not because the result is in doubt, but because neither is a flag flip. The
"single-agent path" is the `--baseline` comparison arm: a self-certifying tool
loop with no root acceptance, no deliverable manifest, no acceptance
checklist, no preview and no publication, and the hosted product's run
surface is built on those. Making it the default is a product-shape decision
with three standing owner decisions in its way (platform trust 2026-09-15,
compile-at-learn 2026-09-26, approved deferred learning 2026-10-11), and the
hosted coordinator sets learning on explicitly for every project run. The
measurement that would inform that decision is now complete and consistent
across fifteen rounds: on the current release, supervision has not bought
correctness on any task family tested, and costs 6–10× the one call that
matches it.

## Threats to validity

1. Six against six on one task: 3/6 vs 3/6 cannot distinguish two 50% rates
   from a 40% and a 60% one. It can say H15's "strictly greater" did not
   happen, which is what was registered.
2. The task is small (one function, eight cases). The calibration found no
   larger task on which one agent fails; the thesis is untested where no such
   task has been found, not refuted there.
3. The treatment arm learned across its six runs and the control could not;
   that is the registered protocol (`current`), and the learning raised cost
   without changing correctness, so it did not help the treatment's case.
4. The instrument was corrected after the runs. The correction is disclosed
   above, mechanical, applied identically to both arms, and leaves the control
   rows unchanged; the archives it was rerun on are untouched evidence.

## The driver's cost report, unchanged

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-terra agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=6: mean $0.1414, median $0.1378
  runs: 0.137, 0.096, 0.131, 0.138, 0.161, 0.184
atoma n=6: mean $0.9277, mean excluding run 1 $0.9486
  runs: 0.823, 0.763, 0.568, 0.543, 1.492, 1.376

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 6 runs: $-4.7180 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.7182 → second half $1.1373

-- held-out task (novel, same family): memorisation control --
  baseline n=6: mean $0.1414
  atoma    n=6: mean $0.9277
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```

(The driver's "held-out" block repeats the primary rows: round 15 registered
no held-out pair, `heldOut` names the same task with 0 runs, and the driver
reports the primary means under both headings.)
