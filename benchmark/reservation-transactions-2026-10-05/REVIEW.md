# Durable reservation experiment: interrupted runs, useful draft counterexamples

## Outcome

Neither run delivered or published anything. Both ran the frozen contract on
production 628826cf with empty seeds, deep supervision and the same model pins.
The first failed before any write; the second wrote a draft, then failed before
executing tests or reaching result acceptance. Consequently this experiment
**does not evaluate the new acceptance reviewer on a completed run**.

Run 4b7cc920: 234.239 seconds, five LLM calls, 24 events, one list_files call.
Run 8c9ae6f3: 337.144 seconds, six LLM calls, 33 events, one list_files and six
successful write_file calls. Both ended `codex call failed [provider-error]`.
The failed execution calls lasted 121172 ms and 226100 ms respectively. Neither
duration establishes a timeout. Full paged MCP events, metadata and logs are in
first-attempt.json.gz and second-attempt.json.gz; all 57 events are retained.

Combined run accounting is 11 LLM calls and $0.23040748 subscription-equivalent
usage, not a cash bill. Analyst sessions are separate and their transport does
not report a dollar equivalent; do not call this the total experiment cost.

## What was tested independently

The second run's last successful writes reconstruct exactly four draft files.
No edit or shell mutation followed those writes. Their hashes are in
draft-hashes.json and inert snapshots in draft/. These are **trace-reconstructed
draft bytes**, not a published commit or a manifest-verified delivery. The code
was reviewed before executing it locally with temporary databases, loopback HTTP
and a minimal environment. No generated implementation was repaired locally.

The draft's own npm test exits zero. This execution happened locally AFTER the
run; Atoma's production trace contains no such execution and gets no credit for it.

The frozen external scorer reports **43/44 passing scenarios**. Its sole failure
is an oracle defect: a mixed-sequence reserve had both a used hold ID and
insufficient stock, and the scorer demanded hold_exists. The contract explicitly
allows either applicable error. The draft correctly refused with insufficient_stock
and preserved domain state. The frozen script, original result and hashes remain
unchanged. verify-reviewed.mjs is a separate documented correction: only a fresh
reserve refusal may choose an actually applicable error; state, status, receipt
bytes and future replay remain exact checks. That scorer reports **44/44**.

The cases include real paired HTTP contenders, original receipt replay after
domain changes, cached business refusal after stock release, multi-item rollback,
exact expiration boundaries, opposite confirm/advance orders and a fixed-seed
100-command sequence with six SIGKILL restarts. They do not prove all concurrency
interleavings, physical power-loss durability or arbitrary crash positions.

## Two additional defects, demonstrated after source inspection

exploratory.mjs is explicitly outside the frozen score. It reports two passes
and two failures, with full observed and expected outputs retained.

1. **Array-valued command type bypasses schema validation.**
   `{key:"k",type:["advance"],to:1}` returns HTTP200/revision1 instead of 400/invalid,
   changes the clock and claims k. A subsequent valid string-valued advance with
   k then returns idempotency_conflict. The source indexes an ordinary object by
   c.type before requiring it to be a string; an array coerces to "advance", while
   later strict equality skips the advance schema check. Ordinary string advance
   and numeric-type refusal controls pass. This resembles the earlier invoice
   currency-array coercion but is a defect in this unaccepted generated draft,
   not proof that the product acceptance gate approved it.
2. **SQL ordering is not JavaScript code-unit ordering.**
   With U+10000 and U+E000 identifiers, JS requires U+10000 first; SQLite's default
   text ordering puts U+E000 first. The observed order is wrong for items, holds
   and hold lines. Source uses ORDER BY instead of the declared JS comparator for
   those projections. The original ASCII ordering checks did not distinguish this.

## Analyst and transport evidence

Both resident analyst verdicts are preserved. They correctly say there was no
executed functional proof or delivery, and neither credits the draft as validated.
Their `sound` grade describes honest run failure under that rubric, not a correct
service. The second proposes a medium-confidence recovery mechanism candidate,
without a cited proposedFix, rather than an implementation defect. Its scope is
that one run, not the combined recurrence or our later external tests.

No specific provider cause is exposed by the complete MCP records. Local source
confirms that provider diagnostics are deliberately reduced before persistence.
Read-only SSH access to the configured deployment account was refused with
`Permission denied (publickey,password)`; no host logs were obtained. Do not
attribute the failure to quota, networking, timeout, model quality or an Atoma
transport bug without further evidence. No third live attempt was spent.

The next product investigation is a privacy-preserving transport diagnostic:
retain a bounded safe error category/phase sufficient to distinguish the failure,
without retaining provider prose or blindly replaying commands after side effects.
Then resume the experiment with the same contract and record any further attempt
separately. The two draft defects need correction before a future delivery, but
changing only this local draft would not solve the interrupted Atoma runs.

## Reproduction

Reconstruct the last successful writes from second-attempt.json.gz, verify against
draft-hashes.json, and use pinned Node 24.20.0:

```sh
node benchmark/reservation-transactions-2026-10-05/verify-artifact.mjs /absolute/draft
node benchmark/reservation-transactions-2026-10-05/verify-reviewed.mjs /absolute/draft
node benchmark/reservation-transactions-2026-10-05/exploratory.mjs /absolute/draft
npm --prefix /absolute/draft test
```

Expected exit codes: 1 (documented oracle error), 0, 1 (two real defects), 0.
The generated suite has a success banner, not an enumerated test count. Root
repository tests were not rerun for this evidence-only addition; the scorers were
executed, linted, and the frozen request/case/scorer/protocol hashes rechecked.
