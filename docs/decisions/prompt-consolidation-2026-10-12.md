# Preserving and consolidating agent methods

Runs already credited successful executions and learned recipes, but had no
post-delivery path to improve all three existing agent ranks. Canonical bootstrap
also replaced a changed prompt wholesale, including learned suffixes. Success
credits, skill learning, template updates and method amendments are different
outcomes; none alone establishes a measured improvement in delivery quality.

## Lifecycle

With the existing `ATOMA_SKILL_LEARN=1` policy, molecule and cell method-credit
hooks collect bounded lessons after their existing proof/restoration guards.
Decision-only approval does not teach a method. Root approval collects the executing
root's lesson; an uncovered proof floor or damaged read-only phase withholds it.
Rejected/remediated passes discard their new lessons. The approved pass retains
at most one candidate per rank, preferring candidates with corrective feedback.
The source atom id, version and prompt are captured, never inferred from a newer
registry row or an instance whose local behavior lost its version binding.

The existing approved-learning worker runs the proposals after delivery. A fixed
host prompt on the saved L2 model proposes a short reusable amendment or no change;
a separate fixed prompt on the saved L1 model reviews it. Neither receives tools
or model-authored SYSTEM instructions. Task, report, feedback, current prompt and
observations are explicitly untrusted USER data. Observations use the canonical
collective renderer, preserving obsolete-read markings and bounding requests and
results separately. Independent supervisor approval can support text-only work,
but approval alone is not evidence of a better method: explicit corrective
feedback and supporting review reasons are required for that case.

Proposals must cite supplied evidence, preserve authority and tool boundaries,
and exclude task/project literals and private content. The model reviewer is a
semantic check, not a correctness proof or measured performance comparison.
An amendment is at most 1,200 characters; accumulated learned content is capped
at 6,000, with a 48,000-character overall input ceiling. A full budget is recorded
as `full`; it never silently deletes existing learning. This design appends
bounded disciplines; it does not autonomously rewrite or compress the whole
prompt. At most three author calls and three reviewer calls are added per run,
within the source run's remaining learning allowance. Source selectors and payers
are rechecked for both L2 and L1 before a deferred project job starts.

Application uses one immediate registry transaction for version CAS, the normal
history-producing patch, and an idempotent `(run_id, lesson_index)` receipt.
Behavior changes reset the trust streak; historical success totals remain.
Applied, unchanged, rejected, stale and full outcomes enter the scoped lifecycle
ledger. Worker errors enter the existing failed learning receipt; they do not
undo delivery. Shared registry history holds a fixed provenance reason, never the
reviewer's potentially private free-form explanation. Those explanations remain
in source-scoped evidence. Inline benchmark learning remains fail-open too.

## Template ownership

`atom_prompt_templates` stores the last known host prefix in the primary DB.
Bootstrap replaces only that exact prefix, keeping an appended learned suffix.
An unknown legacy replacement is preserved byte-for-byte: there is no trustworthy
boundary to reconstruct. Tool declarations can still refresh. Such a preserved
prompt is not claimed to contain the newest template. Exact legacy seeds acquire
a baseline when encountered. A full custom replacement is excluded from generic
template-family reuse. No-op baseline refreshes issue no write, so they do not
raise the durable-mutation barrier that would invalidate crash recovery. No state migration or destructive reconciliation is run.

## Project-wide evidence

`atoma_project_learning` and `GET /api/projects/:id/learning` share ProjectService
and its organisation authorization and cross-org audit. Use `since`, `until`,
`limit` (1–5), and `cursor`; follow `nextCursor` until null. The ordering is newest
admissions, not timestamp order. A cursor binds project, organisation and date
filters, plus fixed run-row and lifecycle-sequence ceilings. New runs and later
ledger appends cannot slip into subsequent pages. Traces and learning receipts
remain live at read time and each available trace carries its content hash.

Each run includes trace registry changes/credits, skills, root acceptance and
recorded plan/result validation, plus scoped lifecycle events (including deferred
worker mutations) and the learning receipt. Counts cover each entire readable
trace and all ledger rows within the ceiling. Trace and ledger counts overlap;
never add the two sources. Details are bounded to 100 events per source/run and
1,200 characters per detail, with omission counts and truncation markers.
Missing, invalid, live and oversized traces are explicit. Five trace reads at
most use the existing 32 MiB per-file ceiling. The reader neither launches work
nor imports worker/provider machinery. It makes no completeness claim for
historical events never recorded, and does not return private host paths.

## Review and validation

Adversarial review caught L1 payer drift, custom templates re-entering generic
reuse, stale/truncated proof rendering, missing refusal/skill fields, and the
lack of reasoning-only observations. Regression coverage exercises those fixes,
source-version races, duplicate application, refused proposals, unchanged
delivery on learning errors, actual worker processes for all ranks, canonical
bootstrap preservation, both MCP eras, stable paging and tenant isolation.
