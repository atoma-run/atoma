# Round 13 — H13 refuted on the product as shipped: the control is right every time, and atoma costs ten times more to be right as often

Run 2026-10-31, the `tabstat` maintenance family of round 12, byte for byte,
on the CURRENT release (origin/main `4fd83276` plus the registration commits)
launched as an ordinary run launches today — routed tissue, default depth,
root delivery acceptance, inline learning — against one `gpt-5.6-terra` agent.
Both arms on the host ChatGPT subscription through `codex-cli`, costs at
catalogue prices. [Registered before the run](PROTOCOL.md#round-13--pre-registration-2026-10-31-written-before-any-round-13-run),
[amended before any spend](PROTOCOL.md#amendment--2026-10-31-0050-utc-before-any-round-13-run-nothing-spent)
(`gpt-5.6-sol` at L3, the frontier the host subscription serves).

## Verdict: H13 refuted on both conditions

| | control (terra direct) | atoma (current release) |
|---|---|---|
| deliverables at full marks, primary | **6 of 6** | 5 of 6 (one 13/14) |
| held-out task | 9/9 | 9/9 |
| mean cost, primary | **$0.1390** | $1.4497 (**10.4×**) |
| mean wall clock | **63 s** | 1,053 s (16.7×) |
| LLM calls per run | 1 | 39–127 |
| cost trend, first half → second half | — | $1.311 → $1.588, rising |
| zero-token phases | — | 0 in every run (eighth consecutive round) |

H13 required atoma's full-mark rate to be strictly greater than the control's
AND its mean cost no higher. The control cannot be beaten on correctness, since
it was right seven times out of seven including the held-out task; and atoma
cost ten times more. Both conditions fail. This is the **third refutation of
the correctness half** after rounds 10 and 12, now on the current release and
its production models, and the registered consequence applies: on this family
supervision buys no correctness on the current release, and no new gate,
validator or heuristic is added to the pipeline until a task is found on which
supervision measurably does.

## The one failure, inspected before being recorded

**atoma run 2 (`build.prev17`) — 13/14, `manifest-matches-live`: stale `npm run
check; npm run build`.** Both entries are probes the run ADDED to the manifest,
not seeded ones. Replayed by hand: `npm run check` recorded stdout embeds the
workspace path (`/Users/mgtf/.atoma/workspaces/build`) and a vitest timing
(`2ms`), which the archived copy cannot reproduce (`build.prev17`, `1ms`);
`npm run build` replays with the same exit code and output. All eleven seeded
invocations replay identically in every atoma workspace. So the score stands
by the registered instrument, and it measures a real weakness — a manifest
entry whose recorded output can never replay is not a record — rather than a
wrong deliverable. No manifest exceeded the scorer's 16-entry replay bound
(largest: 13 entries).

The `score-round.mjs` mapping caught its own first mistake here: round 14 had
already started when round 13 was scored, so the last run's workspace was no
longer live in `build/` and the first pass read round 14's control workspace
as round 13's held-out atoma run (7/9 for a workspace that scores 9/9). The
flag `--last-archive 23` names where that workspace went; the committed
scores are the corrected pass (anchor `--first-archive 9`).

## Where the money went, and why

Over the seven atoma runs ($9.85 in all):

| | share |
|---|---|
| L3 (`gpt-5.6-sol`) | **53%** |
| L2 (`gpt-5.6-terra`) | 34% |
| L1 (`gpt-5.6-luna`) | 13% |
| role `plan` | **50%** |
| role `execute` (the work itself) | 10% |

The premise of the tiering is that cheap models do the work under supervision.
Measured: the work is a tenth of the bill, and the supervision — planning at
L3, validating plans, re-planning after a refusal — is the rest. The control
arm did the whole job in one terra call at a seventh of atoma's L3 spend alone.

## The mechanism: a scope the goal forbade, taught once and reused five times

The goal says *"Do not rewrite the CLI, do not add features"*. Every atoma
workspace, held-out included, holds `src/`, `dist/`, `tsconfig.json`,
`eslint.config.js`, a test directory, a lockfile and `node_modules`: each run
migrated the three-file JavaScript CLI to strict TypeScript with a build step
and a test suite, writing 28–68 files for a three-clause change. The control
arm edited the three files.

Where it comes from is not model whim. `APPLICATION_TYPESCRIPT_GUIDANCE`
(`src/atoms/taskContext.ts`), the owner's skeleton decision of 2026-10-16,
enters every tool-mode task: *"All JavaScript-runtime applications use
TypeScript with strict: true … For an existing application, migrate"*. The
run reads that as a requirement above the goal's own prohibition, and root
acceptance — which refused runs 3 and 4 once each for other reasons — never
held the delivery to "do not rewrite".

Then the learning loop made it permanent. Run 1 distilled its own migration
into a recipe, `migrate-cli-to-strict-ts`; runs 3–6 matched it (`[prefilter]
decision served from cache (reuse migrate-cli-to-strict-ts)`) and the cell
Protoplast earned 13 successes doing it. This is the first round in which the
skills mechanism demonstrably changed a run's behaviour — and what it
propagated was the deviation. Round 12's finding was a supervision chain that
was correct against its input and wrong against the world; this round's is a
platform rule that overrides the task, then teaches itself.

## What this round does and does not say

- It says the current release, on this family, delivers the same correctness
  as one mid-tier agent for ten times the price and sixteen times the time,
  and that its cost per run RISES across the series as the registry fills.
- It says the held-out run generalised nothing cheaper: $1.16 against $0.16.
- It does not say the control would hold at the scale the product is used for
  (an application repaired over twenty minutes). Threat 6 of the registration
  stands: a result here bounds the claim to this scale.
- It does not rank sol against terra; round 14, registered with this round
  and run the same day, measures the frontier control.

## Threats to validity

1. One family, one difficulty, n=6 per arm, no significance test claimed.
2. The machine was not idle (an editor and its language servers; load ≈3.5).
   Durations carry that caveat; cost does not.
3. Subscription-served models, uncontrolled provider caches. Cost figures are
   catalogue-price equivalents of subscription usage, as in every round.
4. The treatment arm paid tuition from an empty registry on run 1 and routed
   through a tissue it authored. Both are the product as shipped, and the
   steady-state mean excluding run 1 ($1.4566) is no lower.
5. The scorer is round 12's, unchanged; its replay bound was not reached.

Scores per check: [`results-round13-scores.json`](results-round13-scores.json);
rows: [`results-round13.csv`](results-round13.csv); full stdout per run under
`benchmark/logs/`; driver log [`driver-round13.log`](driver-round13.log).

Raw traces and per-run stdout of both rounds (22 runs, 48 MB uncompressed) are
archived off-tree beside the pre-round state, as rounds 9–12 did:
`~/.atoma/archive/pre-round13-2026-10-31/round13-14-traces.tar.gz`. The
committed scores, rows and driver logs are the reproducible record.

---

## Driver output, verbatim

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-terra agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=6: mean $0.1390, median $0.1313
  runs: 0.132, 0.131, 0.124, 0.109, 0.193, 0.145
atoma n=6: mean $1.4497, mean excluding run 1 $1.4566
  runs: 1.415, 0.985, 1.533, 2.387, 1.177, 1.201

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 6 runs: $-7.8642 (positive = atoma cheaper in total)
trend across the atoma series: first half $1.3110 → second half $1.5884

-- held-out task (novel, same family): memorisation control --
  baseline n=1: mean $0.1557
  atoma    n=1: mean $1.1604
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
