# Round 14 — the frontier control: one `gpt-5.6-sol` agent is right seven times out of seven at $0.19, and H14 is refuted

Run 2026-10-31 immediately after round 13, same code, same seed, same goals,
same scorer: six `gpt-5.6-sol` single-agent runs on the primary `tabstat`
task and one on the held-out task, **no treatment runs** — round 13's atoma
rows, measured the same day on the same checkout, are the treatment arm.
[Registered with round 13](PROTOCOL.md#round-14-registered-with-it--the-frontier-control).
Workspace anchor: highest `build.prev` before the round 22, so
`--first-archive 23`; the last run's workspace was still live when scored.

## Verdict: H14 refuted

| | control (sol direct, this round) | atoma (round 13, same day) |
|---|---|---|
| deliverables at full marks | **7 of 7** (6 × 14/14, 9/9) | 6 of 7 |
| mean cost, primary | **$0.1879** | $1.4497 (**7.7×**) |
| held-out | 9/9, $0.1969 | 9/9, $1.1604 |
| mean wall clock | **35 s** | 1,053 s |
| LLM calls per run | 1 | 39–127 |

H14 required atoma's full-mark rate to be at least the frontier control's AND
its mean cost to be lower. Neither holds. This is the claim the README made
before the 2026-08-10 audit ("beats frontier-direct 1.5–4.7×"), carried no
evidence for since August, and now carries evidence against: on this family,
on the current release, one call to the frontier model the host subscription
serves is cheaper than atoma's L3 spend alone (L3 was 53% of atoma's bill in
round 13, $0.74 a run) and at least as correct.

## Read together with round 13

- **terra direct** $0.139, 7/7 — round 13
- **sol direct** $0.188, 7/7 — this round
- **atoma** (luna / terra / sol) $1.450, 6/7 — round 13

The two controls differ by 35% in price and not at all in correctness; the
treatment differs from both by an order of magnitude in price and loses one
deliverable. Nothing in this pair of rounds locates a scale of work where the
supervision pays for itself, and the registered consequence of round 13 holds.

## Threats to validity

The same as round 13's, and one more: this round has no treatment runs of its
own by design, so its comparison rests on round 13's atoma rows being
representative of the same day — they are, by construction (same checkout,
same pins, same login, three hours apart), but a reader comparing this table
with a later atoma series must not.

Scores: [`results-round14-scores.json`](results-round14-scores.json); rows:
[`results-round14.csv`](results-round14.csv); driver log
[`driver-round14.log`](driver-round14.log).

Raw traces and per-run stdout of both rounds (22 runs, 48 MB uncompressed) are
archived off-tree beside the pre-round state, as rounds 9–12 did:
`~/.atoma/archive/pre-round13-2026-10-31/round13-14-traces.tar.gz`. The
committed scores, rows and driver logs are the reproducible record.

---

## Driver output, verbatim

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-sol agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=6: mean $0.1879, median $0.1860
  runs: 0.153, 0.211, 0.171, 0.201, 0.227, 0.165
atoma n=0: mean —, mean excluding run 1 —

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 0 runs: — (positive = atoma cheaper in total)
trend across the atoma series: first half — → second half —

-- held-out task (novel, same family): memorisation control --
  baseline n=1: mean $0.1969
  atoma    n=0: mean —
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
