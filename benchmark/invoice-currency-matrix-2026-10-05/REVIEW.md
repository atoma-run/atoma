# Published invoice repair and limits of its evidence

## Delivered artifact

Run `2c502876-d636-415e-b0a5-f304befe8073` delivered and published commit
`6402d37b5c1b8d817d142ae726a03f9f55098e9b` to
[mgtf/atoma-invoice-reconcile-20261005](https://github.com/mgtf/atoma-invoice-reconcile-20261005).
A fresh clone's HEAD equals that receipt. All four published files match the
production manifest's SHA-256 and byte counts.

The published artifact passes **64/64 original independent checks**, **6/6
exploratory checks**, and its own complete subprocess suite. The external
scorers are unchanged. Compared with the first artifact, invalid array currencies
are now refused with input/output bytes preserved. The generated suite also
covers primitive types, partial balances, repeated allocations, repeat output,
explicit currency arithmetic, strict-schema boundaries and file identities.

The CLI itself is unchanged since the first repair: its hash is
`7420b012454a9c817315770cfa3d87ab0f1864258f23cdeaf919e5e121fa661e`.
This run added tests and documentation. It uses short supervision with unchanged
model defaults and the same ten criteria. It is an informed proof repair, not a
controlled performance comparison or a new blind benchmark.

## What the successive runs establish

- `../invoice-reconcile-2026-10-05`: original prospective run; 64/64 initial
  checks, but two additional currency-array failures; partial, unpublished.
- `../invoice-repair-2026-10-05`: fixes the three currency type checks and several
  proof gaps; 70/70 external checks; still partial for missing nonzero USD tax proof.
- `../invoice-final-proof-2026-10-05`: adds USD tax and explicit ID ordering;
  70/70 external checks; partial for separate JPY/KWD subtotal/tax assertions.
- This run: literal full-field four-currency output, per-line rounding and tax
  ties, then a further credit/payment example; delivered and published.

The earlier gaps existed when previous reviews approved the same criteria.
Preserving all refusals is essential: the final success does not establish that
the reviewer reliably collects all missing evidence in its first pass.

## A remaining reviewer weakness, established by mutation

The first acceptance pass refused c3 because no test made credit-before-payment
ordering observable. The generated remediation adds an invoice of 10.00 with a
credit of 6.00 and a payment of 4.00, asserting a settled invoice with those exact
amounts. The next review approves it.

That added example does **not** distinguish operation order. In a temporary copy
of the exact published artifact, `check-order-proof.py` moves the complete payment
loop before the credit loop and changes nothing else. The **entire final suite
still exits zero** (`order-mutation.json`). The original artifact is never edited.
The retained mutation is reproducible from the published source snapshot.

The resident analyst also calls the recovery sound and says the new assertion
makes the order observable (`analyst.json`). The surviving mutation contradicts
that particular evidence claim. Its observation-only verdict does not trigger
a mender repair for this weakness.

The implementation actually applies credits first, visible in source. This is
not a newly demonstrated bug in the published arithmetic. With nonnegative
credits/payments and the stated final-output contract, many valid outcomes are
commutative; an observable order claim needs a distinguishing observation, while
an implementation-order requirement may be established by source inspection.
The reviewer first demanded such an executable distinction and then accepted a
non-distinguishing example. Neither the test name nor its success proves that
stronger claim. Do not present the green suite as universal proof quality.

## Evidence and reproduction

`live-evidence.json.gz` contains every complete event and metadata page;
`status.json` contains the manifest and publication receipt; `artifact/` contains
inert snapshots from the fresh published clone. `summary.json` records exact
runtime/call/accounting totals. Dollar values are subscription equivalents, not
cash invoices. The artifact suite emits a success banner rather than an
enumerated test count.

Using pinned Node 24.20.0 and an unchanged checkout of the published commit:

```sh
node benchmark/invoice-reconcile-2026-10-05/verify-artifact.mjs /absolute/checkout
python3 benchmark/invoice-reconcile-2026-10-05/exploratory-checks.py /absolute/checkout /absolute/node
npm --prefix /absolute/checkout test
python3 benchmark/invoice-currency-matrix-2026-10-05/check-order-proof.py /absolute/checkout /absolute/node
```

The first two commands report 64 and six passing checks. The last reports
`mutationSurvived: true`, documenting the evidence limitation above.

The next product change should be evaluated against the archived reviewer
inputs: consistent first-pass requirements and a distinction between an
assertion's label and its discriminatory power. Do not add open-ended retries
or relax correctness simply to obtain a delivery banner.
