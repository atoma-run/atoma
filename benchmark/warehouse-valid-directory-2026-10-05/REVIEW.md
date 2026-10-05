# Closing the safe-directory regression — 2026-10-05

## Final verified result

Run `3eea5c57-9370-4189-8275-a93933330b37` completed **delivered**, on revision `5182794e568f6bb9650cdc499abd56afaad03723`, seeded from `a239be59-4a72-4592-a634-f3fe3161aff9`. It retained the original seven criteria and added one explicit positive/negative directory-identity criterion. The narrow goal corrected the unrequested parent-directory ban and the test that had encoded it.

The generated change removes only the two parent-directory comparisons from the CLI guard. It replaces the incorrect symlink refusal fixture with successful same-directory and symlinked-directory cases, plus actual input-file identity collisions. Existing byte-preservation, publication, CSV and transition assertions remain.

Publication is on `mgtf/atoma-stock-reconcile-20261005`, main, exact commit **37e5c8109d941778a948f98d8288cf3213c04af3**. A fresh clone checked out that commit. All seven published files matched the production manifest SHA-256; `summary.json` records those hashes. Source and tests are retained as inert snapshots in `artifact/`.

## Executed independent checks

All **14/14** independent cases pass:

- Five original counterexamples: exhausted reservation-ID reuse, cross-SKU reservation-ID reuse, zero-padded zero quantity, quoted final CSV column followed by another row, and separate reservation/event namespaces.
- Four baseline controls: exact fixed-example stock with both output files byte-identical across repeat execution, late excess-return preservation, late conflicting-duplicate preservation, and opening-only zero-stock output.
- Three I/O/CSV regressions: correct CRLF error row, actual input overwrite prevented through an output-directory alias, and existing files preserved when the second output destination is a directory.
- Two positive controls: valid non-colliding outputs in the input directory, directly and through a directory symlink.

Results: `independent-checks.jsonl`, `io-checks.jsonl`, `valid-directory-checks.jsonl`. The published suite's own **11/11 tests** also pass locally (`local-suite.log`). No assertion was removed from the independent scripts to obtain these passes.

To reproduce against a reviewed checkout of the exact publication, run the three committed scripts with its absolute path:

```sh
node benchmark/criteria-review-2026-10-05/verify-artifact.mjs /path/to/checkout
node benchmark/warehouse-proof-2026-10-05/check-io.mjs /path/to/checkout
node benchmark/warehouse-proof-2026-10-05/check-valid-directory.mjs /path/to/checkout
```

## Product-path evidence

The run used 10 calls and took 219.435 seconds, at $0.1032 subscription-equivalent usage. Its four focused reviews took 53,254 ms and $0.01655324 equivalent. These are one run's trace components, not controlled comparisons or cash invoices.

All eight criterion judgments were returned and persisted after global approval. All four focused prompts contain complete selected source readback, with no cut markers, including the 14,557-character test file. One refused double-escaped edit was recovered; no failed final test or publication is concealed. `live-evidence.json.gz` contains all 52 events plus complete metadata, summary and final publication status; every detail page was read through the end with snapshot checks.

The two Atoma changes were already CI-verified and deployed before this run: authoritative focused criterion reviews (`738cf801`) and shared bounded file readback (`5182794e`). This archive adds production evidence only.

## Scope of the conclusion

The identified regressions and positive controls are closed on the exact published bytes. This is not a proof over every CSV input, filesystem failure or adversarial prompt. The preceding run shows that semantic reviewers and the analyst can agree while missing an unrequested restriction; independent positive controls exposed it. Keep that failure and its counterexamples alongside the successful result.
