# Published Compute installer missing from production admission

On 2026-10-29, after the owner installed Compute 0.5.224 and asked to
continue Attica, run `aa42b051-6e7b-4f08-8a37-22fcbf9243e3` stayed queued.
Its predecessor had been cancelled without starting at the end of the earlier
five-hour window. The new request was not duplicated.

The native application showed Ready and accepting work. Production's live
device record confirmed appVersion 0.5.224, a live session, no assignment,
adequate resources, the existing project grant and an already allowed image.
The MCP run status exposed only a generic wait; readiness checked saved
configuration, not live device admission. The global lease and deployment
pending tables were empty; the assayer was idle.

Read-only inspection of both live production process environments established
the cause: `ATOMA_COMPUTE_APP_VERSIONS` still ended at 0.5.219 and did not
include 0.5.224. The immutable 3f4a9ef524d4 release had passed all three native
packaging jobs and main CI, and had been published, without completing the
operator-owned admission step documented in `docs/compute-desktop.md`.
Connection alone therefore did not establish execution eligibility.

The proposed correction appends exactly 0.5.224, preserving every previous
version, all image digests and all unrelated bytes. Its exact prior contents,
ownership and permissions must be retained in a private backup beside the
configuration. Activation uses the ordinary compatible deployment to a new
revision so both the web process and selected executor load the policy. No
manual service restart or direct run/lease database mutation is needed.

The first configuration-write attempt was rejected by automatic approval
review and made no change. The owner then explicitly approved the precise
request: “Autoriser Compute 0.5.224”. The authorized update preserves all
other configuration bytes, ownership and permissions and retains an exact
private backup. This new record-only revision activates the corrected policy
through normal deployment; no application source or installer changed.

A synthetic in-memory database exercised the real compiled admission path
with the observed device capabilities and production policy: the old policy
returns waiting/version-incompatible, while appending exactly 0.5.224 returns
ready with the same session and project grant. All previous versions and
image identities are preserved; unknown versions remain unapproved. The 24
configuration/device tests and documentation checks passed.

Completion evidence must include the loaded policy in both processes, the
existing run's transition to execution on the same Compute device, and its
retained initial state and complete raw trace. Local repair logs and MCP/SSH
receipts are kept under the session's `attica-asset-repair-20261029-1606`
proof directory. Native release tests remain reusable. No new installer build
is required to activate its exact version.

Remaining product defects are distinct from admission repair: generic queue
messages hide `version-incompatible`, and native Ready does not expose the
server's policy result. Do not weaken the allowlist or infer eligibility from
connection when addressing those surfaces.
