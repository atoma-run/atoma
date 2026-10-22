# Root remediation command evidence — 2026-10-23

Attica run `5ad47f8c-e4d6-45b4-ac2d-ac277119e4d0` demonstrated a loss at
`runDepthTask` → `acceptRootResult`: initial root acceptance judged c1 met,
refused README timeout instructions, then refused the same c1 after the
README-only repair because prior command receipts were no longer visible.
All 91 trace summary events were read. Browser command receipt
`0fb71a9b-2301-4643-bd96-d94e0c038eef` passed ten cases, zero skipped;
typecheck `a919ade4-aa50-4999-b85e-87528d0f0d8f` and lint
`09718c7d-6cda-47db-995a-91fbdf72737d` exited zero. No Attica test replay
was needed to diagnose or repair this transport loss.

`carriedEvidence` previously retained only unchanged digest-bound browser
observations. Root remediation now also renders historical execution records
from the host log, starting with the earlier pass, within the SAME attempt.
It includes subsequent outcomes even when their branch's Result was discarded,
orders witnesses by the host log, and retains the existing 48K evidence cap.
Both holistic and report-blind criterion reviews also receive a separate
6K mutation inventory with explicit omission counts. Browser digest checks,
restored-execution exclusion, proof floors and model verdicts remain unchanged.

Adversarial review: command success does not prove current state or coverage;
later source changes/failures remain visible and can still cause refusal.
No README extension heuristic, automatic freshness grant, supervisor execution,
new model call or old child declaration is introduced. File inventory does
not claim to enumerate shell/external side effects. Bounded omitted content
remains unknown. Unknown IDs and other attempts cannot supply history.

Regression crosses the production depth runner, branch attestation, root
remediation and BOTH final review prompts. It failed before the repair and
passes after it. Countercases cover later production edits, discarded-branch
command failure, unknown IDs and another attempt. Existing browser stale-byte
and read-only restoration coverage remains required. Test LLMs are mocked.

Attica's two reviewed files were committed/pushed independently as
`72602c80870ac83abb6f05f667cdef580f8903f9` on its main branch. They preserve
the production current-document guard and expose `url()` in the fake page.
The user authorized a five-hour Attica run/fix loop after this engine repair.
