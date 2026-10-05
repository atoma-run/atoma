# Invoice USD proof and a further currency evidence gap

Run `2faac5cb-9e5a-485f-93c4-ef1015d19c0c` uses short supervision and seeds
`66bf4b67-4892-4ae6-8e81-058dbf090187`. Its criteria and model defaults remain
unchanged. This bounded proof repair is not a performance comparison.

The CLI SHA-256 is unchanged from the repaired version. The suite adds full USD
invoice assertions for 10.01 at 825 basis points (tax 0.83, total 10.84) and a
0.05 subtotal at 1000 basis points (HALF UP tax 0.01, total 0.06).
A root refusal then prompted explicit code-unit ID ordering assertions.

The final focused review still refuses c2: the older JPY and KWD examples assert
totals, without separate subtotal/tax assertions. The run remains partial and
unpublished. Those omissions existed during earlier approvals; this is another
late evidence finding, not a newly introduced arithmetic bug.

All 64 original independent checks and six exploratory checks still pass on the
exact four-file artifact, verified against all four manifest hashes. The
artifact's own subprocess suite passes locally. Complete traces (78 events),
metadata, status, source snapshots and execution results are preserved.

A subsequent proof-only request provides literal full-field expectations for all
four currencies, per-line rounding and JPY/KWD tax ties. Neither acceptance nor
the external scorer is weakened.
