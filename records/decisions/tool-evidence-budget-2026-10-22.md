# Transport evidence allowance: 48,000 characters

On 2026-10-22 the owner explicitly chose to raise `MAX_TOOL_EVIDENCE_CHARS`
from 24,000 to 48,000 after reviewing the evidence-budget pilot, and requested
an ordinary Attica run after deployment. This changes only transport-observation
selection shared by result validators and Decision; it adds no calls, proof
credit, execution retries, or automatic approval. Source read-back and unrelated
24,000-character limits remain independent. Models, payer and run timeout stay
unchanged.

The pilot audited 67 historical validation contexts and ran 120 tool-free
judgments on synthetic cases with executing oracles. At 24,000, the corrected
selector retained 983 of 1,137 latest-command receipt occurrences, compared with
503 for the preceding selector. Receipt retention does not establish complete
assertion visibility or current state. In the separately registered five-case
source-complete stress series, 65 command identities exhausted the 24,000
allowance and omitted the positive case's test receipt; 48,000 retained it.
All 96 negative judgments across the two series refused the incorrect cases.
This small artificial distribution does not establish a production error rate
or a globally optimal budget. The initial series also had missing source
preconditions and identical rendered inputs at two larger budgets; those
confounds are retained, not counted as causal budget effects.

In the five-case stress mix, calculated uncached input/output cost increased
by about $0.00095 subscription-equivalent per judgment from 24,000 to 48,000.
Observed recovery after one historical refusal took 7m50s and 13 model calls,
but included unrelated work: the whole amount cannot be attributed to missing
evidence. End-to-end paired runs are still needed to measure total retry cost.
The local study is `benchmark/tool-evidence-budget-2026-10-22/`; its preserved
inputs, results, hashes and report remain a separate measurement artifact.

The production-path regression now places 66 distinct shell requests beside
file reads and browser observations, and checks the actual L1-to-L2 validator
prompt retains fresh/saved build, check/build outcomes and a short failure.
It fails with the former 24,000 allowance and passes with 48,000. Existing
controls retain latest-failure precedence, branch/request identity, explicit
partial evidence, unknown legacy exit status and multiline-output isolation.
No assertion or negative control was weakened.
