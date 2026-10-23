# Renewed Attica session, 2026-10-22

The owner delegated ordinary offline Attica runs, analysis, demonstrated Atoma repairs and production deployment from 02:03:39 to 07:03:39 UTC. No new 90-minute run was admitted after the remaining window could no longer include its unchanged limit and a review reserve.

## Terminal results

- `40fd0b7c-ed1d-4b21-a302-5429239f6ac1`: cancelled at the owner's request, 03:36:47 UTC. Its 1,872 events, 36 negative reviews, 133 failed tools and 207 recorded probes were reviewed. No saved delivery. Host trace SHA-256: `7ab18f597292689f71298b45f71eaf31a205ef6f6c160758e9599d1dcd8a593a`.
- `f837ec7a-6353-4449-981c-ed91bc0d65e2`: failed at 04:28:34 UTC after exhausting its tool budget while recovering its scratch HTTP harness. Its 1,220 events, 10 negative reviews, 44 failed tools and 92 recorded probes were reviewed. No manifest or eligible checkpoint. Host trace SHA-256: `104ee3edab148b4115bcaf95885dffcf962e4fdbef58fcb68d3747193ca26d8b`.
- `b920faf6-7bd7-4e89-87f8-7176c1c97f92`: admitted at 04:38:06 UTC on owner revision `f488de32`, failed at 06:08:45 UTC. The trace ended at 06:08:34. It recorded 191 model calls, 11 escalations and $9.6775 subscription-equivalent cost. This is a model-price equivalent, not an API invoice. The final result names unfinished matrix/build/preservation work and exhausted landing budget. The coordinator confirms workload stop without a cancellation request. No manifest; canonical ProjectService reports checkpoint unavailable, 0/0, and no client answer pending.

The complete b920 metadata sequence through event 1,628, all 36 negative review reasons, all 69 failed-tool diagnostic records and all 34 recorded-probe inventory entries were reviewed through bounded readers. Its host trace SHA-256 is `8469f574b34a09688d5bbd8e2b44b98ea5e5942936bb3ef54dfcd0ac3445116a`. No raw trace was exported. The direct HTTP/browser tools addressed localhost only (49 calls); five fallback executions used the existing `gpt-5.6-luna` execution model.

## What passed, and what did not

b920 executed historical fresh/saved compiled HTTP matrices reporting 17 passing cases, and later an 11-test focused classifier suite and a separate normal-header/body matrix variant. Internal parent checks eventually reported 18 classifier cases and four HTTP guard cases passing. These concern their respective snapshots, not a final accepted delivery.

The last implementation changed source after the ordinary clean-copy checks. Its subsequent full TypeScript command failed on duplicate declarations caused by copied source trees, and a focused lint command failed on an unsafe call. Final ordinary clean-copy `npm ci`, `npm run check`, `npm run build`, identical fresh/saved matrix execution and preservation evidence were not completed for that final source. The original 17-case matrix also duplicated one required challenge case; a scratch variant proved that envelope separately without replacing the retained matrix.

Because the failed run saved no artifact manifest or eligible checkpoint, no final delivery was available to independently hash or execute. Earlier checks of the authentic baseline's 233 files, 48 historical data/evidence files and two original JS entrypoints do not establish preservation by an absent final delivery. Do not resume or seed from an invented b920 checkpoint.

A Configuration tab browser probe failed because `aria-selected` remained false. A later probe removed that assertion. That is a separate Attica UI defect, not a successful repair or an Atoma engine defect.

The final log also reports incomplete retrieval-backend cleanup. Workload stop is confirmed; this message alone does not establish a new engine defect or justify a service restart.

## Demonstrated Atoma defect and deployment

Review `79ae0ba8-e508-4dbc-8c3b-d68c021afeaa` said the only observed HTTP matrix command failed, although successful matrix executions existed in the same execution. The bounded selector retained the short failed invocation and omitted longer successful ones. This was reproduced through the actual L1 execution/attestation/result-validator path, independently of the model's other mistakes.

Commit `00546c625d4bc2da3be77da3b1f26e2da8f41555` retains bounded latest command receipts before spending the remainder on their payloads, explicitly marks partial observations and preserves an observed exit status before excerpting. The 24,000-character cap is unchanged. It adds no model call, automatic approval, gate or fresh-proof credit. See [the mechanism and adversarial review](https://github.com/atoma-run/atoma/blob/00546c625d4bc2da3be77da3b1f26e2da8f41555/records/incidents/attica-command-evidence-2026-10-22.md).

Verification: 53 focused tests passed; `npm ci` and `release:check:static` passed, including both TypeScript configurations, lint, docs, audit, build and compiled smokes. The local full suite had 7,859 passes, 36 skips and one previously reproduced Mac Docker workspace-replacement failure. The exact-SHA Linux branch and main full suites, worker isolation, desktop builds on Windows/macOS Intel/macOS ARM, and CodeQL passed without weakening that test.

Exact-SHA workflows:

- [Main CI, 39731496887](https://github.com/atoma-run/atoma/actions/runs/39731496887): success.
- [Compute desktop, 39731496860](https://github.com/atoma-run/atoma/actions/runs/39731496860): success, including release job.
- [CodeQL, 39731496814](https://github.com/atoma-run/atoma/actions/runs/39731496814): success.
- [Deployment, 39732677442](https://github.com/atoma-run/atoma/actions/runs/39732677442): success.

At 06:15:50 UTC, `/home/atoma/current` and the active executor socket both resolved to exact revision `00546c625d4bc2da3be77da3b1f26e2da8f41555`. Device retrieval mapping, unmatched-device fallback, models, payer and run profile remained unchanged. The isolated checkout was clean and exactly equal to fetched `origin/main`.

## Evidence-budget evaluation

The owner's additional request was evaluated in a completed 67-context projection audit and 120 tool-free validations, separately under [the pre-registered protocol](../../../benchmark/tool-evidence-budget-2026-10-22/protocol.json). Projection retention, model decisions, direct cost, cache sensitivity and subsequent work are separate measurements. No measurement so far establishes an optimal global 24,000-character budget or causal end-to-end savings.

The first model series retains its immutable requests and responses. A separately registered follow-up addresses a common missing seed/precondition input and increases identical synthetic pressure so 48k and 96k actually differ; this amendment was recorded before any follow-up model call. Neither changing tests nor combining the two series can be used to manufacture a green result.

The complete pilot, source-context control, cache-normalised cost sensitivity, retry-window metadata and limitations are documented in [the study note](../../../benchmark/tool-evidence-budget-2026-10-22/README.md). All 120 calls completed without transport/parse errors; 96 oracle-incorrect judgments refused. Total direct cost was $0.39010304 subscription-equivalent. A final data verifier checked hashes, model identity, registrations, distinct follow-up inputs and canonical costs. The interactive report and its main controls were verified in the local browser.


## Session closure and separately requested follow-up

The five-hour heartbeat was paused at 07:03:51 UTC on 2026-10-22. The three
original product runs ended cancelled/failed; no final CAPTCHA/lint delivery
is claimed. The last canonical active-admission read at 06:54:35 UTC was empty.
No new admission was made afterward; the owner asked at 07:00 to wait for MCP
reconnection, so no later SSH investigation or cancellation was attempted.

The owner separately requested adopting 48,000 transport-evidence characters
and launching one run after deployment. That isolated five-file change passed
`npm ci` and `npm run release:check`: both TypeScript configurations, lint,
documentation, audit, build, compiled smokes, and 7,878 tests (36 skipped).
Its stronger production-path test failed at 24,000 and passes at 48,000.
It remains staged, uncommitted and undeployed while awaiting the requested
MCP reconnection. The follow-up request key is
`attica-captcha-lint-20261022-evidence48k1`; it has not been admitted.
