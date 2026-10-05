# Invoice reconciliation: prospective production experiment, 2026-10-05

## Outcome

One new, unseeded production run (`6a8b44c7-0d75-481a-ba08-d7d1db8d8f8c`) on
`9cddbaf7e8d0333c7f1f37fc09daaea34a83a560` ended **partial, not published**.
It took 547.977 seconds, 23 model calls and $0.25636668 in subscription-equivalent
accounting, not a cash API invoice. The arithmetic and tax rules are synthetic
requirements, not a claim of compliance with any jurisdiction.

- Frozen independent checks: **64/64 passed**, comprising 16 positive controls
  and 48 expected refusals. All positive cases also compare bytes across two
  executions. Every case verifies input preservation; refusals verify existing
  output preservation, including file identity collisions and an output directory.
- Additional checks motivated by source inspection: **4/6 passed**. Two invalid
  currency-array cases were accepted, exposing one schema-validation defect in
  both invoice and payment records. These six checks were written after seeing
  the implementation and are reported separately from the prospective score.
- The artifact's own subprocess suite also exits zero locally; it emits a
  success banner, not an enumerated test count.
- All four reconstructed artifact files match the production manifest SHA-256.
  The 121 full events and complete metadata are archived without detail truncation.

## What was fixed before observing the outcome

`request.json`, `cases.json`, and `verify-artifact.mjs` were frozen and hashed in
`protocol.json` at 03:12:40 UTC, before the run started at 03:13:02 UTC. Only the
request was sent to Atoma. The local independent cases and scorer were withheld.
Their hashes were rechecked after scoring. Handwritten positive arithmetic
expectations were cross-checked using Python Decimal, independent of the
JavaScript implementation.

The corpus covers line rounding before summation, tax ties, four currency
precisions, values above Number.MAX_SAFE_INTEGER, credit/payment ordering,
repeated allocations, unapplied money, duplicate key-order equivalence after
settlement, conflicting duplicates, schema errors, independent ID namespaces,
prototype-like keys, same-directory success and symlink/hardlink refusal.

This is one prospective run, not a controlled comparison or an estimate of
universal correctness. The missed currency type case demonstrates a limitation
of our own initial corpus as well as of the model review.

## Acceptance versus independent evidence

Both holistic root reviews approved all ten criteria. The focused reviews
overrode those approvals:

1. First review refused c4: preservation had not been demonstrated for currency
   mismatch, excess credit and excessive allocations. Atoma added six subprocess
   refusal tests with nonzero status, stderr and exact prior-output comparison.
2. Second review approved c4 but refused c3 and c7: no assertion established a
   partial invoice balance/status or byte-identical repeated execution. Those
   omissions are real in the complete test source. The independent scorer does
   exercise both behaviors successfully; that does not retroactively create
   evidence in Atoma's suite.

The c3/c7 omissions were already present in the first review, which approved
those criteria. This is review inconsistency, not an implementation regression
introduced by the repair. All source readbacks fit the shared allowance; missing
excerpts do not explain these judgments. Ten focused calls cost 113.791 seconds
and $0.03243512 subscription-equivalent across both passes.

Both focused passes approved c6 (strict schema validation). That judgment is
incorrect: `Object.hasOwn(C, x.currency)` coerces a non-string property key.
An invoice with `currency: ["EUR"]`, and a payment with the same value and no
allocations, both exit zero and publish a JSON array in the currency field.
The pre-existing output is replaced despite invalid input. See the exact input
construction and observed outputs in `exploratory-checks.py` and
`exploratory-results.jsonl`. The source lacks a `typeof currency === 'string'`
check. Final-newline decimal probes were also investigated and correctly
refused; the positive canonical-decimal control succeeds.

## Analyst comparison and recovery evidence

The resident analyst grades the run `sound` with observations only, accurately
recognizing honest partial delivery and the final evidence gaps. It does not
identify the currency type defect or the c3/c7 review inconsistency. Its verdict
is about the run's trajectory and must not be treated as independent artifact
correctness certification. No mender-eligible defect is present in that verdict.

Preserved intermediate failures include three failed npm probes (precision,
scaling/excess credit, tax rounding), followed by code corrections and passing
probes. The expected EUR tax stayed 0.60; it was not weakened to accept 0.61.
A nonexistent test/test.js read was recovered by listing the directory. One
post-success skill extraction failed at the provider with zero recorded usage;
subsequent root validation still ran. The trace does not provide a deeper
provider error reason.

## Reproduction

Restore the inert snapshots under `artifact/` to a temporary directory, removing
only their final `.txt` suffix and preserving the `test/` subdirectory. Compare
SHA-256 and byte counts with `status.json` before executing them. Use the pinned
Node 24.20.0 runtime.

```sh
node benchmark/invoice-reconcile-2026-10-05/verify-artifact.mjs /absolute/restored-directory
python3 benchmark/invoice-reconcile-2026-10-05/exploratory-checks.py /absolute/restored-directory /absolute/path/to/node
npm --prefix /absolute/restored-directory test
```

The exploratory command intentionally exits nonzero for this original artifact.
The artifact is preserved unchanged; no local repair was substituted for the
production result. `live-evidence.json.gz`, `analyst.json`, `summary.json`, the
manifest, and both result files form the evidence record.

## Next bounded work

Repair the generated currency type checks and add the missing partial-status
and repeat-byte assertions, retaining this original artifact as the failing arm.
For the product, replay these exact reviewer inputs before changing review
policy: require evidence that distinguishes type validation from coercive key
membership, and measure whether all existing evidence gaps are found on the
first pass. Do not lower acceptance or add unbounded retries to turn this run green.
