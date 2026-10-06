# A compiled script's result is validated — owner decision 2026-10-06

Status: decided and implemented. This record states what production showed,
what changed, and what the change costs. It claims no measured saving.

## What production showed

On 2026-10-06 the owner reported that the one compiled skill had gone back to
an LLM recipe. It had not: `Ammonia/recheck-recorded-command-probes` was still
`kind: script`, with no `demote` event in the ledger. It had simply not been
matched since 2026-10-03, so every recipe the latest runs used was injected
into a model loop. Read through the MCP (`atoma_skills_stats`,
`atoma_skills_show`, `atoma_ledger_tail`, `atoma_project_runs`,
`atoma_run_trace`):

- 175 project runs from 2026-09-26 to 2026-10-06: 27 recipes learned, 41
  compile refusals, 0 promotions, 0 demotions, 0 deterministic phases counted.
  The only promotion was the operator pilot of 2026-10-01.
- 30 task recipes carry a refusal stamp: 21 cite per-task interpretation, 4
  interpretation and a browser, 3 a browser alone, and 2 are a malformed
  compiler reply ("compile response missing promotable=true|false").
- The script's nine matches: three credited, all in the operator pilot; six in
  project runs, none credited.

| Run | The phase asked for | The script did | What followed |
|---|---|---|---|
| cc7ed6f1 | confirm a CSV header and seven rows | replayed the manifest, twice | the second replay was set aside by the anti-redispatch guard; the L1, handed the script, rewrote and re-ran it |
| 822bb4fe | run the README's negative tests, hash evidence | failed: probes pointing at `.atoma-scratch/` copies an earlier phase had deleted | handed back to the L1 as "run it, do not improvise", re-run about seven times until the phase budget ran out; the run landed |
| 947a21a2 | run two verifiers and record fresh evidence | replayed three old probes, recorded nothing | became the final phase result; the run was delivered |
| b2f5a494 | check a SHA-256 and record probes | replayed one probe | the next (model) phase did the work |
| 8738f263 | recompute the optimums and audit the manifest hashes | replayed seventeen probes | became the final phase result; the run was delivered |

The script never reads its subtask: it checks that `argv[2]` parses and
replays `.atoma-probes.json`. Matching alone decides whether that is the job,
and it chose the script at confidence 0.39 to 0.78 for phases that asked for
more. With no validation behind a trusted script, four exits 0 on the wrong
job were accepted, two of them as delivered work. None was counted: the
read-only phases below a tissue withheld credit and, with it, every event and
statistic, so the record read zero deterministic phases.

## What changed

1. **The result is validated.** `L2Atom.validateScriptDispatch` runs
   `validateResult(…, { scriptDispatch: true })`: the result gates, the
   ground-truth probe, proof coverage, Jev, then the model — everything a
   molecule's result faces except the type's trust fast path, whose counter
   the molecule's model earned. The direct `Result` carries
   `executorEvidence` from just before the script was written, so Jev and the
   model read what the transport observed, not only the envelope: the
   script's own write and run, picked by scratch filename because sibling
   dispatches share a lane, while the host's reads and cleanup run on the
   base executor. Its gates read the run's one-shots without spending them.
   Jev approving keeps the phase free of model calls; otherwise it costs one
   validation call. A validation that throws sets the result aside; a
   deadline or budget abort is rethrown.
2. **A script set aside is not run again.** When the script ran in the phase
   and its result was not used, a `set-aside` event names the cause and the
   molecule takes the phase with no active-skill tag: its outcome neither
   credits nor blames the script, and it opens no verification extraction.
   After a contract failure, a tool error or a failed validation, the
   workflow may still be right, so it gets the `_fallback.md` recipe as
   guidance. After the deliverable gate, the anti-redispatch guard or a
   refusal, the script's job is not this phase's, so it gets no recipe; a
   refusal's reason reaches it as coaching. A pre-flight skip, where the
   script never ran, still hands the script to the L1 as before.
3. **An uncredited direct result is visible.** Accepted without credit (a
   read-only phase below a tissue, restored writes, an uncovered obligation),
   it emits `direct` then `credit-withheld` and counts as a deterministic
   phase.

Unchanged: the compiler and its prompt, the static scan, the refusal stamps,
the counter reset at promotion, the demotion streak (contract failures only),
the capability filter, the deliverable gate, the anti-redispatch memo, the
kill switch.

## What it costs, what it gives up

- A direct dispatch is no longer free when Jev does not approve: one
  validation call on the cheapest tier. The pilot's direct phase cost
  $0.0022 for the whole run against $0.0101 through the model loop; one
  validation stays well inside that gap.
- A refused result leaves the phase to the model loop. When the refusal is
  wrong, the phase pays the loop a correct replay would have saved.
- Jev's approval of a script's result is the same question it answers for a
  molecule's. Its accuracy on script results is not measured; the audit
  (`JEV_AUDIT_RATE`) samples these approvals like every other.
- The compile prompt still says "There is NO validator downstream of a
  trusted script". Editing it would re-open every current refusal stamp for
  another compile call, and its instruction — fail loudly — still holds.

## Adversarial review

An independent review of the first implementation, against these incidents
and the earlier ones the skills contract records, found no blocker and six
defects, each reproduced by a test before it was fixed and kept as a
regression (`tests/skill-direct-dispatch.test.ts`):

- the script's validation spent the run's reject-once gate memo, so a
  `required-command-manifest` rejection of the replay let the molecule's
  substituted harness reach a model that approved it;
- the host's deliverable-gate reads and cleanup were attested as the
  script's evidence, so a validator saw the script "read README.md";
- sibling dispatches on one lane read each other's runs as evidence;
- an untagged molecule after a set-aside opened the verification
  extraction, one more L2 call and a likely twin of the script;
- after a content refusal the molecule received the refused method and none
  of the reasons;
- a refusal left no event of its own, and an uncredited `direct` left the
  trajectory reader waiting for a `success`, which then swallowed the next
  genuine one in the lane.

Checked and found sound: budget and deadline aborts during validation,
the ground-truth probe ignoring the deleted scratch file, credit and blame
isolation, the anti-redispatch memo, and the incidents the contract records
(document-cli-from-source, the slugify rehearsal, epoch-5's six identical
dispatches, the round 6/7 capability filter). The operator pilots keep zero
L1 plan/execute calls. Two siblings matching the SAME script still share
one scratch filename, a race older than this change, left as it was.

## Measuring it

From the `set-aside` events (their cause), and the `jev` and
`validate-result` events beside each `direct` event: how many direct results
each path approved or refused, and, for refusals, whether the model loop that
followed delivered the phase. Alongside it, `deterministicPhases` per run,
which now counts uncredited direct phases too.
