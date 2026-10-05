# Seeded warehouse repair and evidence visibility — 2026-10-05

## Observed run

Run `2c03a3f6-1300-407c-a3b0-7fc21dddb0c1` ran on deployed revision `738cf801cefe23d0e61c4b2ffc06c82fd38616b3`, seeded from `22af997d-1440-49b1-8b65-01c41f6ef7ad`, with the original seven user criteria. It ended **partial**, unpublished, after one root remediation: 447.179 seconds, 12 calls, $0.2285 subscription-equivalent cost (not a paid API invoice).

`live-evidence.json.gz` contains the final status, complete summary, metadata and all 122 events. Every detail page was read through its terminal offset with snapshot checks. The MCP start call timed out at 300 seconds; status reads followed the same still-running run, without another start.

Both holistic reviews refused. Therefore the focused review added **zero calls in this run**; this production attempt does not measure its marginal latency or demonstrate a positive production decision. The separate archived 18-call helper replay and hermetic root tests establish that path's regression behavior.

The first refusal correctly found missing conflicting-duplicate and audit-repeat assertions. Remediation added the audit comparison and transition tests, but the conflicting-duplicate case only checked absence of newly created outputs, not preservation of existing ones. Opening-only still checked exit status alone. The final refusal was appropriate, though several reasons reflected evidence truncation rather than absent implementation.

Recovered errors remain in the archive: five refused ambiguous/stale edit spans were followed by successful edits; one provider-error during optional skill extraction had no usage reported. The later extraction call succeeded. No learned skill or publication is reported for this run. Neither error is hidden as a clean execution.

## Independent artifact check

All seven files were reconstructed from complete read events or byte-identical original repository files and matched the final artifact manifest SHA-256. The changed CLI, tests and README are retained under `artifact/` as inert text snapshots. No new commit was published by Atoma.

The previously committed independent verifier ran against those exact files. `independent-checks.jsonl` records **9/9 passes**, including the five previously failing counterexamples, exact fixed-example stock, repeated stock and audit bytes, late conflicting-duplicate/excess-return preservation, and opening-only zero-stock output. This is a bounded check, not proof of every input or I/O failure. It distinguishes repaired behavior from missing tests in the delivered suite.

## Evidence-reader defect and correction

The final test file is 7,147 characters and the CLI 7,597. The previous reader cut each file above 6,000 even when the four-file allowance had ample unused space. The final global prompt consequently lost actual audit-repeat and transition assertions.

The reader now preserves all selected files when their total fits the existing **24,000 source-character allowance**, across at most four reads. If the batch exceeds that allowance it retains the previous policy: complete files up to 6,000 and explicitly incomplete excerpts for larger files. This redistributes the existing maximum allowance; it adds no read, no model call and no acceptance heuristic.

Adversarial review: actual archived >6 KB source/test bytes must reach both the global and focused production paths; a 26 KB batch must still be excerpted; oversized README keyword excerpts retain their previous behavior; unavailable files and cancellation retain unknown markers. The four-read/path traversal boundaries are unchanged. A batch above the bound may still lack sufficient evidence and must remain unverified. The correction does not claim unlimited context or turn the presence of source into proof of execution.

`tests/criteria-review.test.ts` exercises both sides of the shared budget via real root acceptance. `tests/starting-workspace.test.ts` retains the oversized-file case above the total allowance. The focused, depth-routing and starting-workspace tests pass together (97 tests).

Source verification: `npm run check` passed (both TypeScript configurations, docs, lint, 5,372 tests passed / 19 conditional skips, 409 files passed / one skipped); `npm run release:check:static` passed. Ten additional container-dependent cases were skipped on this execution because the worker image availability probe did not admit them; no container code changed. The reconstructed artifact's own nine tests also passed locally (`local-suite.log`).
