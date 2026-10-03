# Repairing the published mission inventory — 2026-10-03

The generated dossier's inventory defect is repaired in published commit
[`7ea13916145f83ad54319ac8428e38a316333d79`](https://github.com/mgtf/atoma-parallel-mission-20261003/tree/7ea13916145f83ad54319ac8428e38a316333d79).
Independent checks accept a clean package and a package with local runtime
state, reject eight corruptions, and confirm the 17 analysis files and dossier
remain byte-identical to the original. The fix is in the generated deliverable,
through two Atoma follow-up runs; no platform source or publication filter was
changed.

The starting defect and independent results are recorded in
[the parallel mission experiment](parallel-mission-2026-10-03.md). The original
`manifest.json` included `.atoma-probes.json`, which publication correctly
excluded. The old `verify_all.py` did not check the inventory at all. A
filename-based platform rule for arbitrary `manifest.json` files would not
establish their intended semantics; this repair targets the explicitly requested
SHA-256 inventory in this dossier.

## Two production attempts

Both runs used project `e5431908-38f6-4d1e-b30a-ea2122c052cd`, the deployed Atoma
revision `dc63bd080b761132b1a55b0eec57b6a14b6f47f4`, and the existing Periderm
tissue. Pins remained `sub:openai:gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol`
at L1/L2/L3 respectively. Each started from its predecessor's actual workspace.
The first analyst lease was allowed to finish before launching the second run.
Both MCP start calls timed out after 300 seconds; the same run IDs were followed
to completion without duplicate starts.

| Attempt | Run | Published commit | Elapsed project time | LLM calls | Subscription accounting |
| --- | --- | --- | ---: | ---: | ---: |
| Manifest checks and regression tests | `bcf35298-b65e-4380-8994-a17431e9c564` | `9928280dec39e9804ed9be1b8d416cced93ade7f` | 1,093.666s | 10 | $0.3979 |
| Runtime exclusions | `afb236ab-ac87-495a-b8ea-f03f92da8e70` | `7ea13916145f83ad54319ac8428e38a316333d79` | 554.956s | 8 | $0.2586 |

These are one repair trajectory, not a comparative benchmark. Subscription
accounting is not a separately billed API invoice.

The first attempt removed the internal journal from the inventory, added
SHA-256/coverage validation, disposable mutation tests, and explicit README
commands for regeneration and verification. Its published manifest was correct:
21 delivered files, 20 manifest entries, 20 matching hashes. However, its new
verifier rejected a real Git checkout with `unexpected ordinary file: .git/HEAD`.
The independent runtime fixture also failed on `.atoma/cache`. All eight
negative cases already failed as intended. The repair was incomplete, even
though the run was marked delivered.

The second attempt added a shared exclusion predicate to the generated
verifier's inventory and entry validation, together with a positive runtime-state
fixture. Excluded workspace files are ignored; naming an excluded path in the
manifest is rejected. Ordinary missing, altered, omitted, duplicate, escaping,
and unexpected-file failures remain failures. Verification uses bytes and paths,
not commands supplied by the manifest.

## Independent verification of the published bytes

The three publications were cloned separately with `core.autocrlf=false`, their
exact HEADs checked, and all generated Python inspected before execution. The
final checks ran on the actual published commit, not on Atoma's workspace or an
agent's delivery assertion.

| Independent case | Expected | Final outcome |
| --- | --- | --- |
| Clean publication copy, no internal journal | Accept | Exit 0 |
| Copy with dummy Git, Atoma, dependency and Python-cache files | Accept | Exit 0 |
| Manifest names internal journal | Reject | Exit 1 |
| Delivered README missing | Reject | Exit 1 |
| Delivered README bytes changed | Reject | Exit 1 |
| README hash changed | Reject | Exit 1 |
| README entry omitted | Reject | Exit 1 |
| Duplicate entry | Reject | Exit 1 |
| Path escapes package | Reject | Exit 1 |
| Unexpected ordinary file | Reject | Exit 1 |

The independent harness invokes the full verifier in each disposable copy and
checks integrity diagnostics for rejections. It compares the analysis files and
dossier to the original publication, and all original tracked file bytes before and
after verification. Separately, the full verifier passes directly in a real Git
checkout, the Git-tracked file set matches the manifest exactly, and the earlier
independent mathematical/data-quality oracle still passes. These finite tests
establish the observed repair; they are not proof for every possible package or
host filesystem.

## Recovered errors and remaining platform observations

- Both attempts recovered malformed edit arguments. The second also corrected
  double-escaped newlines and an intermediate duplicate conditional. The trace
  preserves these errors rather than counting only the final green probes.
- The first attempt initially recorded an old verifier run under a note naming
  new package tests. Later fresh output actually included the new checks. A
  probe's label is not proof of what it exercised.
- First-run root acceptance incorrectly rejected the README instructions after
  they had been added. Event `83c756e7-869f-46bb-9866-67ab92da8d60` cites the old
  read-back, whose prompt explicitly marks it stale after an edit. The run spent
  one remediation, reread the README, clarified the journal wording, regenerated
  hashes and passed. This is a separate validation-evidence defect, not repaired
  by changing the generated dossier.
- The generated input-data declarativity limitations from the initial experiment
  remain outside this repair's scope. The four analysis trees were intentionally
  preserved.

## Evidence and replay

All evidence is under [evidence-parallel-mission-repair-2026-10-03](evidence-parallel-mission-repair-2026-10-03/):

- [First request](evidence-parallel-mission-repair-2026-10-03/request.json),
  [complete first trace: 92 events](evidence-parallel-mission-repair-2026-10-03/run.json),
  [first terminal receipt](evidence-parallel-mission-repair-2026-10-03/status.json).
- [Second request](evidence-parallel-mission-repair-2026-10-03/request-runtime-exclusions.json),
  [complete second trace: 59 events](evidence-parallel-mission-repair-2026-10-03/run-runtime-exclusions.json),
  [second terminal receipt](evidence-parallel-mission-repair-2026-10-03/status-runtime-exclusions.json).
- [Original false-acceptance reproduction](evidence-parallel-mission-repair-2026-10-03/baseline-check.json),
  [first published checks](evidence-parallel-mission-repair-2026-10-03/checks-first-repair.json),
  [first repair's full regression matrix](evidence-parallel-mission-repair-2026-10-03/first-repair-regressions.json).
- [Final checks and all independent outputs](evidence-parallel-mission-repair-2026-10-03/checks-final.json),
  [independent regression harness](evidence-parallel-mission-repair-2026-10-03/check-repair.py).

After checking out the original `e928a44ad9dac3fbd9fbbdd7fae5bbacd45df98a` and
final `7ea13916145f83ad54319ac8428e38a316333d79` commits separately, with Git
newline conversion disabled:

```text
python docs/incidents/evidence-parallel-mission-repair-2026-10-03/check-repair.py <original-checkout> <final-checkout>
python docs/incidents/evidence-parallel-mission-2026-10-03/check-package.py <final-checkout>
python docs/incidents/evidence-parallel-mission-2026-10-03/check-results.py <final-checkout>
```

All exit zero on the final publication. The regression harness exits nonzero on
the first repair because valid runtime state is rejected, and on the original
because corrupted manifests are accepted. Its earlier captured baseline output
predates the expanded matrix and aggregate diagnostics; it is retained verbatim.
