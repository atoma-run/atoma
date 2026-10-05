# Focused acceptance review — 2026-10-05

## Incident and correction

The warehouse delivery had missing conflicting-duplicate and audit-determinism assertions. A holistic verdict still approved them after complete test readback and assertion guidance. The preserved incident and earlier experiments are in `../stock-reconcile-2026-10-05/`. Source before this correction: fcacc36939d13e3e1fa6d06a32dcbd4c3f37d75f.

Completed file deliveries with user-approved criteria now require focused reviews of at most two criteria per call, after preliminary holistic approval. These judgments replace the holistic criterion judgments. They are not votes: the global approval cannot override a focused refusal. The review receives original requirements and host evidence, without the candidate success report or previous verdict. Model tier, tool permissions and proof credit are unchanged.

## Adversarial mechanism review

- **Blanket rejection:** Three positive synthetic controls cover CLI behavior, HTTP behavior and documentation. All pass. Prose needs content evidence, not an invented execution requirement.
- **Approval laundering:** A mock global approval followed by `approved:true` with an unmet focused criterion refuses delivery. Root persists focused reasons. No majority vote or global tie-breaker exists.
- **Partial verdicts:** Invalid JSON, absent verdict envelope, missing/duplicate/unknown IDs, absent or whitespace-only reasons, and truncated responses cannot approve. They report incomplete review, not a demonstrated implementation defect. Raw model response and usage remain recorded.
- **Hidden assertions:** Complete small file readback is retained. Missing/truncated content remains unknown. No lexical coverage classifier guesses semantics from titles or filenames. A concrete root filename bug (`spec.test.js`) is also fixed and tested through root acceptance.
- **Narrative influence:** Internal previous-result and remediation narratives are removed; original task inputs and constraints remain. Evidence text itself is untrusted and can still contain misleading narrative. Prompt isolation reduces influence; it does not prove resistance to every injection.
- **Wrong failure cause:** A synthetic duplicate-input run fails because its opening file is missing. The judge correctly refuses to credit duplicate rejection, while preserving the separately proven input-byte property.
- **Cost and authority:** Two criteria per call, at most six additional tool-free cheapest-tier calls for the twelve-item contract. Already refused, drafted, text and landed paths incur none. No supervisor command replay, tools, retries, proof credit or model upgrade is introduced. Transport errors/cancellation propagate.
- **Residual risks:** Reviews remain semantic model judgments. Splitting criteria repeats the original task/evidence and adds latency. Larger source remains bounded. Criteria can be compound. Batching does not make review infallible or establish unobserved behavior. No universal accuracy claim is supported.

## Measured replay

The preregistered `protocol.json` invokes the actual production `reviewAcceptanceCriteria` helper, including parsing and aggregation. `requests.json.gz` stores all 18 exact requests; `responses.jsonl` retains all raw responses and usage. `reviews.jsonl` stores aggregate judgments. `summary.json` records hashes and counts.

- Archived warehouse evidence, three repetitions, seven original user criteria: c4 and c6 are refused in **3/3**, with conflicting-duplicate/preservation and missing audit-repeat assertions cited. This is regression evidence on one known incident, not an independent benchmark.
- Six explicitly synthetic controls: **6/6** match expected per-criterion outcomes. Three compliant controls pass. The other three distinguish missing assertion coverage, truncated documentation and refusal for the wrong cause.
- Other warehouse judgments vary: c1 and c5 fluctuate; c2 is incorrectly accepted once. Therefore the experiment does **not** establish that all judgments are reliable. The repaired contract makes focused judgments authoritative and malformed reviews fail closed; it does not replace independent execution of the delivered artifact.

The replay uses archived production evidence plus complete test readback, not a new warehouse execution. Controls are constructed host-record strings, not freshly executed applications. `replay.mjs` can rebuild request hashes and replay recorded responses without quota; `--live` uses the local subscription. Preserve this series rather than overwrite it for a new experiment.

## Hermetic coverage

`tests/criteria-review.test.ts` exercises root acceptance on archived test bytes and the malformed, truncated, inconsistent, canceled and report-blind cases. Existing depth-routing, starting-workspace and real-backend runner tests cover integration and exclusions. The carried-checklist fixture now writes the README it claims to deliver and supplies actual criterion reasons.

The independent `verify-artifact.mjs` verifier was also executed against the original published CLI before deployment: exactly the five archived defects fail; the fixed example, both-file repeat determinism, late conflicting-duplicate/excess-return preservation and opening-only output pass. `before-artifact-checks.jsonl` preserves the results. Missing tests were not misreported as those behaviors being broken.

## Source verification before deployment

- `npm run release:check:static`: passed (including build, audit and compiled release smokes).
- `npm run check`: docs, both TypeScript configurations and lint passed. Full tests first found the carried-list fixture needed explicit focused reasons; that fixture was corrected and its 17 real-runner tests passed. The next full run had 5,379 passes and one unrelated keyboard-browser failure; that exact test passed when re-executed without code changes.
- Final full `npm test`: **5,380 passed, 9 skipped; 409 files passed, 1 skipped**, including the keyboard-browser test. Initial failures are retained here rather than hidden by the green rerun.
- `git diff --check`: passed.
