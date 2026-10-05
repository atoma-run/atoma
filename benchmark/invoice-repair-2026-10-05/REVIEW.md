# Invoice repair and remaining proof gap, 2026-10-05

Run `66bf4b67-4892-4ae6-8e81-058dbf090187` seeded the original partial run
`6a8b44c7-0d75-481a-ba08-d7d1db8d8f8c`, with the same ten criteria and default
models. This is an informed repair, not another blind prospective evaluation.
Production revision: `b6770f36e1ba8011e2b9062e92bb28b0dcbfc247`.

## Verified repair

The only CLI change adds `typeof x.currency !== 'string'` to all three currency
checks before property membership. Tests now reject arrays containing EUR,
objects, null, booleans and numbers across invoice, credit and payment records,
with nonzero status, diagnostic stderr and unchanged input/output bytes.

The first added array fixture was empty and already refused, so the initial
pre-repair npm test unexpectedly passed. Atoma corrected the fixture to
`['EUR']`; the suite then failed on the defective implementation. After the
three type checks were fixed, it passed. Both observations are preserved in the
trace rather than substituting an invented red/green narrative.

New assertions establish the exact partial balance/status, repeated allocations
within one payment, unapplied remainder, nonzero duplicate credits/payments,
exact duplicate counts, and byte-identical repeat output with input preservation.
The subsequent remediation adds invalid decimal, currency, quantity and tax
cases. No original passing assertion was removed.

All **64 original independent cases** and **six exploratory cases** pass on the
exact final artifact. The artifact's own subprocess suite also passes locally.
Four SHA-256 values match the production manifest; original scorer hashes are
unchanged. Source snapshots remain inert files for replay. `artifact/README.md.txt.gz`
is compressed to preserve its original trailing blank line byte-for-byte;
decompress it before restoring README.md.

## Acceptance and limits

The run still ends **partial, unpublished**. Its first focused review refused
missing strict-schema test coverage. After that was added, the second focused
review refused an untested nonzero USD tax case. The large USD example uses
zero tax; EUR, JPY and KWD cover nonzero tax. This is a real gap in the artifact's
tests, although the external four-currency test already confirms the USD
10.01 subtotal, 0.83 tax and 10.84 total.

The USD test gap existed before the final review. Previously approved criteria
can still reveal existing evidence omissions on a later pass. The acceptance
bar is not weakened here, and the independent passing results do not replace
missing assertions in the delivered suite.

The analyst grades the trajectory sound and records only the honest refusal.
Its statement that no product change is supported does not establish consistent
first-pass review: that requires replaying the collected approval/refusal pairs.
The full verdict is in `analyst.json`.

Duration: 571.425 seconds; 27 calls; $0.32087176 subscription-equivalent,
not a cash invoice. All 173 events and metadata are archived. There were no
tool-error events; the deliberate pre-repair test failure remains visible in
its command result. A separate bounded proof-only run follows this one to add
the missing nonzero USD assertions.
