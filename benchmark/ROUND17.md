# Round 17 — the direct depth after the TypeScript rule was narrowed: cost at parity on both tasks, H17 holds on tabstat and fails on the challenge by one held-out miss

Run 2026-11-02 11:21–11:38 UTC on branch `feat/direct-depth` at `f8436224`
(CI green on that commit), as
[registered the same morning](PROTOCOL.md#round-17--round-16-after-the-typescript-rule-was-narrowed-registered-2026-11-02-before-any-run):
round 16 unchanged except for the narrowed TypeScript rule, `record_probe`'s
omission of run-varying output and the scorers' manifest replay. Control
`--baseline`, treatment the product at its default depth (`direct`), both arms
on `sub:openai:gpt-5.6-sol`, three runs per arm per task, 30-minute budget,
host path. Anchors in [`round17/anchor.txt`](round17/anchor.txt): tabstat
`--first-archive 66 --last-archive 72`, challenge `--first-archive 72` with
its last workspace live.

## Verdict: H17 holds on tabstat, fails part (a) on the challenge; the branch is not pushed

| | tabstat: control | tabstat: direct | challenge: control | challenge: direct |
|---|---|---|---|---|
| full marks | 3 of 3 | 3 of 3 | **3 of 3** | 2 of 3 |
| mean cost | $0.204 | $0.203 (**0.99×**) | $0.331 | $0.314 (**0.95×**) |
| mean wall clock | 49 s | 52 s | 114 s | 105 s |
| LLM calls | 1 | 3 | 1 | 3 |

H17 needed, on each task, (a) at least the control's full marks and (b) at
most 1.5 times its mean cost. Tabstat meets both. The challenge meets (b) and
misses (a) by one run. Under the registered consequence nothing is pushed,
and the cause is reported to the owner. Rows and every case:
[`results-round17-tabstat.csv`](results-round17-tabstat.csv),
[`results-round17-challenge.csv`](results-round17-challenge.csv) and their
`-scores.json`; the driver's reports
[`ROUND17-tabstat.md`](ROUND17-tabstat.md) and
[`ROUND17-challenge.md`](ROUND17-challenge.md).

## The cost gap is gone

Round 16 put the direct default at 3.3 and 1.9 times the control, and traced
it to migrations. With the narrowed rule, no direct run of six migrated
existing JavaScript or scaffolded a skeleton: the three tabstat runs edited
`lib/stats.js`, `tabstat.js`, the README and the manifest in place, and the three challenge runs wrote
only `challenge.ts`, as every control did. What the product adds is a
checklist draft and the root acceptance call (two `luna` calls, about one
cent), and the direct runs spent no more than the control overall.

## What the one miss was

Challenge direct run 2 (`build.prev77`, trace
`2026-11-02T11-35-00-023-b4c0d5c8.json`) scored 7 of 8. It failed
`holdout-challenge`, the case outside the goal's examples: a page headed
"Security check", "Please complete the challenge to continue", a form posting
to `/challenge` with a `captcha-response` field and a "Continue" button. The
delivered `detectChallenge` requires text asking to verify that one is human
(`verify … human`, `human verification`, `not a robot`), which this page does
not carry, so it returns false.

It is the executor's generalisation, not the product's machinery. The run made
one executor call, which tested every example in the goal and the negative
cases it listed; root acceptance approved it on those observed probes, as it
had to: it cannot know an unseen wording. It is the same case, failed the same
way, that cost the single `terra` agent and the supervised product three runs
of six each in [round 15](ROUND15.md). On this task, the `sol` control has now
passed it in six runs of six (rounds 16 and 17) and the direct executor, the
same model, in five of six.

## Recording

No direct run recorded a test-runner report: the tabstat runs kept the eleven
CLI invocations, and the challenge runs recorded `tsc` checks and
`node --experimental-strip-types` or `tsx` evaluations of the function.
`manifest-matches-live` passed in all twelve tabstat workspaces. The scorer
amendment moved no score.

## What the owner has to decide

The registered bar says no push. The difference it reports is one run in
three on one held-out case of one task, the smallest difference three runs
can show; Fisher's exact test on 2 of 3 against 3 of 3 gives p = 1. The cost
part, which round 16 failed, now holds at parity on both tasks. Two ways
forward:

1. **Ship the direct default now**, as an owner decision over the registered
   consequence, with these numbers in the README. The current production
   default, the supervised depth, failed the same held-out case in three runs
   of six in round 15 at 6.6 times a single agent's cost (another day and
   another control model, so context, not a registered comparison).
2. **Register a larger check first**, for example six against six on the
   challenge, with the same bar, and ship only if it holds.

## Threats

Three runs per arm. The challenge's held-out case is the one single agents
fail at some rate whatever wraps them, so a miss there measures the model's
variance as much as the depth. Both arms ran the same day on the same code
path; round 16's numbers are context only.
