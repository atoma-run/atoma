# Direct depth by default, learning off by default — owner decision 2026-11-01

Status: decided and implemented on branch `feat/direct-depth`. Shipping to
production waits on the pre-registered check in
[`benchmark/PROTOCOL.md`](../../benchmark/PROTOCOL.md) (round 16). This record
states what changed, what a direct run still owes, and what it gives up.

## The decision

> The single-agent path becomes the product's default depth, and inline
> learning is turned off by default.

That is the consequence round 15 registered for a refuted H15, and the owner
confirmed it on 2026-11-01. The evidence behind it:

| Measurement | Single agent | Atoma, supervised |
|---|---|---|
| Rounds 13 and 14, a three-file CLI maintenance task | 7 of 7 correct (terra and sol) | 6 of 7, about ten times the cost |
| Calibration, four real repository repairs | 12 of 12 correct (terra) | not run: no room to improve |
| Round 15, an HTML detection task one agent fails half the time | 3 of 6 correct | 3 of 6 correct, 6.6 times the cost |

On every task family measured on the current release, supervision bought no
correctness. The rounds are in [`benchmark/ROUND13.md`](../../benchmark/ROUND13.md),
[`ROUND14.md`](../../benchmark/ROUND14.md), [`ROUND15.md`](../../benchmark/ROUND15.md)
and the [calibration](../../benchmark/calibration-2026-10-31/CALIBRATION.md).

## What a direct run is

One executor with the run's tools carries the whole task
([`src/run/direct.ts`](../../src/run/direct.ts)). It is the measured control
arm's tool loop and budget, with what the product owes every executor:

- **Kept from the product.** The acceptance checklist (drafted or the client's
  own), the task context every executor reads (strict TypeScript, verification
  reuse, workspace preparation, project context), the attestation log of every
  tool call, root acceptance by the host, the one remediation pass after a
  refusal, landing as `partial` when the run budget cuts it, the declared
  artifact manifest, preview and publication.
- **Given back what a cell or a planner gave.** A failed execution runs once
  more on the same workspace, as a cell retries a molecule. The executor
  declares on its report's last line whether it delivered files or an
  answer, as a planner declares a root plan's delivery; an attested write or
  edit always makes it files, and with no declaration the host compares the
  workspace with its start. An answer gets the text review.
- **Not given back.** The leaf result gates a cell runs over a molecule. They
  read a molecule's JSON envelope and probe manifest, which a plain-text
  report does not carry; tried, they raised findings no pass could clear and
  refused correct passes, so root acceptance runs the delegated gates, as it
  does over a tissue.
- **Dropped.** Tissue selection, planning, plan and result validators, peers,
  replans, the prefilter, recipes, script dispatch and learning.
- **Identity.** A tier-1 actor named `Direct`, because a molecule is the only
  rank that invokes elements and the root's molecule gates apply to its own
  report. Its model is the organisation's L3 pin: the agent carrying a whole
  task is the frontier agent the rounds measured.

It is not `--baseline`. The baseline is a measurement arm: it self-certifies,
reads only the goal, writes nothing to the store and records no root plan, so
a project run on it could be neither reviewed, previewed nor published.

## What changed

| Surface | Before | After |
|---|---|---|
| Runner default (`DEPTH_CONTRACT.defaultMode`) | `deep` | `direct` |
| `--depth` values | `deep`, `short` | `direct`, `short`, `deep` |
| Inline learning (`resolveSkillLearning`) | on unless `ATOMA_SKILL_LEARN=0` | off unless `ATOMA_SKILL_LEARN=1`; `--no-learn-skills` still vetoes |
| Project runs | learning forced on; no depth stored when none was asked | learning follows the host; the resolved depth is stored on every new row |
| MCP project run `depth` | `short`, `deep` | `direct`, `short`, `deep`; absent means `direct` |
| MCP operator run | no depth; `learnSkills: false` vetoes | `depth` accepted; `learnSkills: true` opts in |
| Recipe assays | ran at the default (`deep`) | pinned to `deep` (`ASSAY_DEPTH`) |

A stored project run without a depth predates this decision and ran deep.
Continuations, reruns, GitHub-access resumes and Compute validation read it as
`deep` (`STORED_DEPTH_WHEN_ABSENT`), never as today's default.

## What it gives up

- **Phase checkpoints.** Pausing, resuming, client questions at a phase
  boundary and continuing a run are built on root phases. A direct run has
  one, so they need `depth: deep`.
- **Learning.** Nothing is distilled, compiled or credited by default. The
  skill catalogue, compilation and dispatch stay in the code, reachable with
  `deep` or `short` and `ATOMA_SKILL_LEARN=1`.
- **The fractal.** Application → L3 → L2 → L1 is no longer the default path.
  It stays the `deep` path, and every invariant of it still holds there.

## Decisions this amends

- [Platform trust, 2026-09-15](platform-trust-2026-09-15.md): a run is still a
  run. Project runs now follow the host's learning setting like every other
  lifecycle default, instead of having learning pinned on.
- [Compile at learn, 2026-09-26](compile-at-learn-2026-09-26.md): unchanged,
  and idle by default, since nothing is learned unless a host opts in.
- [Approved learning, 2026-10-11](approved-learning-2026-10-11.md): unchanged
  for runs that learn.

## Deployment

Rows and traces now carry depth `direct`, which the previous generation's
strict depth enum refuses, so `EXECUTOR_COMPATIBILITY` moves from 4 to 5 and
the release takes the draining path of
[automatic deployment](../automatic-deployment.md): new admissions close, running
work finishes, then the new executor activates.

## How to undo it

Forward, never by redeploying an older release: generation 4 cannot read a
row written with `direct`. Set `DEFAULT_DEPTH_MODE` back to `deep` in
[`src/contracts/depthRouting.ts`](../../src/contracts/depthRouting.ts) and
`resolveSkillLearning` back to default-on. Rows written while `direct` was the
default carry their depth, so they keep meaning what they ran as.
