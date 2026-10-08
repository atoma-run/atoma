# Versioned project context

A project can retain a brief and client decisions between runs. The client enters
and reads this context through Atoma's MCP; it does not need to maintain a file in
the generated repository. This context belongs to the project, not the shared
platform skill catalogue or registry trust.

## Client workflow

1. Read `atoma_project_context` with `projectId`. An untouched project has version
   zero, a null brief and no decisions.
2. Use `atoma_project_context_update` with that `expectedVersion`, a new opaque
   `idempotencyKey`, and one `change` operation.
3. Use `propose_decision` for a suggestion, including model suggestions. It has
   no effect on subsequent run guidance until the client explicitly approves it
   and `confirm_decision` records that approval.
4. `set_brief` requires the client's approval of the exact text and a
   `confirmation` describing that approval. Empty text clears the brief.
5. `replace_decision` retires a decision with a confirmation. Its optional
   replacement starts **proposed** and needs its own confirmation. The retired
   decision is preserved with status `replaced` in that revision's `change`.

Every proposal/brief names a `source` (`kind: client | model`, `summary`, optional
`runId`). This is caller-declared provenance, not verified evidence. A referenced
run must belong to the same project. The authenticated principal and timestamps
are host-authored; clients cannot supply them. Confirmation records the client's
approval as reported by the authenticated caller. It cannot independently prove
what a person said outside Atoma. Tool descriptions explicitly forbid an agent
from inventing approval or turning its own suggestion into confirmed guidance.

Readers accept `version` to inspect a snapshot and `beforeVersion`/`limit` to
page revision metadata, newest first (default 20, maximum 50). Follow
`nextBeforeVersion` until null. Read the corresponding revision for full change
provenance. History is immutable and is not truncated when decisions are retired.
Viewers may read; only members of the active organisation may write. Platform
cross-organisation reads use the existing audit boundary; they grant no write
access. Archived projects refuse new changes.

## Concurrency and execution

Updates are immediate SQLite transactions in the existing product database.
They append `project_context_versions`; an UPDATE trigger protects historical
snapshots. A stale `expectedVersion` returns a conflict. Retrying the identical
request with the same key and principal returns its original result even if
newer revisions now exist. Reusing a key for different content or another
principal is a conflict. The platform journal records revision/kind/actor only,
not client or model prose; it does not send a push notification.

Admission captures `project_runs.context_version` in the same transaction as the
queued run. A trigger protects that value. New iterations use the current
context even when their workspace comes from an older `baseRunId`. A same-key
retry, queued dispatch after process restart, checkpoint resume and comparison
rerun preserve the captured revision. Legacy runs have no recorded revision;
resuming or comparing them never substitutes today's context. A missing pinned
snapshot refuses launch rather than silently dropping approved guidance.

The coordinator projects only the confirmed brief and confirmed decisions into
`ATOMA_PROJECT_CONTEXT`. The shared runner parses this bounded envelope into
`Task.inputs.projectContext`; the goal is unchanged. Delegation preserves the
host's value over model-authored child inputs. Context describes applicable
facts and preferences within the current task scope; it grants no tool access,
publication permission, delivery acceptance or proof credit. No additional
model call, retrieval store or learning path is introduced.

The active snapshot holds at most 48 decisions, of which at most 24 may be
confirmed. Briefs allow 4,000 characters and decisions 600 each. The encoded
model projection is capped at 24,000 characters, including JSON escaping. An
update that exceeds a bound is refused atomically, never silently shortened;
replace obsolete decisions before adding more. Historical revisions remain
available. Both MCP and GET/PUT `/api/projects/:id/context` use `ProjectService`;
HTTP mutations retain authentication and same-origin checks.
