# The three tiers stay, the cost premise is retired — owner decision 2026-11-10

Status: decided. Nothing changes in the code or in production: the three-tier
split was the default before this decision and remains it. This record states
what was decided, which registered consequence it sets aside, and what atoma
is offered for from here.

## The decision

> Stay with the three-tier split, and do not change production, which runs
> the task split even though the benchmarks were catastrophic. The initial
> premise does not, on the evidence so far, work financially, but the split is
> useful for auditing runs.

## What the premise was, and what was measured

The premise was about cost. A frontier model plans, a mid-tier model
supervises, and cheap models do the work. Earned trust skips reviews, and
learned recipes compile into scripts. The overhead of the first runs is
recovered by the later ones, until atoma costs less than one frontier agent on
the same goal ([H1](../../benchmark/PROTOCOL.md#hypothesis)). From round 10
the question became whether supervision at least buys correctness.

On the current release:

| Measurement | One agent | atoma, three tiers |
|---|---|---|
| Rounds 13 and 14, maintenance of a three-file CLI | 7 of 7 correct (terra and sol) | 6 of 7 correct, at 10.4 and 7.7 times the cost |
| Calibration, four repairs in a real repository | 12 of 12 correct (terra) | not run: nothing was left to improve |
| Round 15, an HTML detection function one agent fails half the time | 3 of 6 correct | 3 of 6 correct, at 6.6 times the cost |

In round 13 planning was 50% of what the atoma runs spent and execution 10%.
The cost per run rose across both atoma series, and in round 13 no phase ran
without a model call. The reports are
[`ROUND13.md`](../../benchmark/ROUND13.md),
[`ROUND14.md`](../../benchmark/ROUND14.md),
[`ROUND15.md`](../../benchmark/ROUND15.md) and the
[calibration](../../benchmark/calibration-2026-10-31/CALIBRATION.md).

## The consequence this sets aside

Round 15's registration bound two consequences to a refuted H15.

1. The README states that the supervision thesis is refuted on the whole range
   tested. Applied on 2026-11-01, and it stands.
2. "The single-agent path becomes the product's default depth, and inline
   learning is turned off by default." **Declined by this decision.**

The second was built before it was declined. The
[`feat/direct-depth`](https://github.com/atoma-run/atoma/tree/feat/direct-depth)
branch (head `9bb4f6cf`) makes a `direct` depth the default: one executor
carries the whole task and keeps the acceptance checklist, the tool
attestations and root acceptance, with inline learning off unless a host opts
in. Rounds 16 and 17, on that branch only, measure it against the bare agent
it wraps. The last one put it at the bare agent's cost, and one held-out run
short of it on one of two tasks. The branch is not merged. It is kept as the
record of that work, and its rounds are not rounds of the protocol on `main`.

Declining a registered consequence after the result is known is a deviation
from the registration. [`PROTOCOL.md`](../../benchmark/PROTOCOL.md) discloses
it as one. The verdicts of rounds 13 to 15 are unchanged.

## What atoma is offered for

Auditing how agent work was produced and checked. Every hand-off between
tiers follows one protocol (a plan, a verdict on the plan, the work, a verdict
on the work), and each step is stored with the agent and model behind it, its
tokens and its cost. Verdicts rest on evidence the run produced, the
acceptance criteria are fixed before planning starts, a finished run can be
rerun on other models against the same goal and criteria, and the analyst
writes a cited post-mortem. The single agent of the rounds is one tool loop
that certifies its own result.

## What this does not claim

- That the record pays for itself. No round has asked whether it lets a
  reviewer catch a wrong delivery that a single agent certifies. A claim that
  it does needs its own registration.
- That supervision buys correctness. On every task family measured it did
  not.

## What stays in force

- Round 13's consequence: no new gate, validator or heuristic enters the
  pipeline until a task is found on which supervision measurably buys
  correctness.
- The cost rules of the engineering contract (the cheapest model that can
  answer, the prefilter, trust fast paths, prompt caching). They bound the
  overhead. They are no longer a claim that the product saves money.
- Inline learning as shipped: on for project runs. The decisions on
  [platform trust](platform-trust-2026-09-15.md) and
  [compile at learn](compile-at-learn-2026-09-26.md) are untouched.

## How to revisit

If the default is reconsidered, the path is to bring `feat/direct-depth`
forward onto `main`. Its own record, `docs/decisions/direct-depth-2026-11-01.md`
on that branch, lists what a direct run keeps, what it gives up, and why that
release drains running work before it activates.
