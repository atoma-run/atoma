# Assayer launch and reporting recovery — 2026-10-23

## Production evidence before correction

The complete MCP journal contained 36 supervisor.assay entries from October 15
through October 23 (nextBefore=null). All said not-reached/keep. Read-only SSH
inspection of all 36 assay.json files and their 116 arm logs found every arm
in error, with no trace or model-call accounting. Every log ended with:
`project retrieval requires an exclusive tenant run receipt`.

The executor health snapshot was armed, idle, with no error: its counters reset
on deployment, and the assayer treated invalid comparisons as successful assays.

## Mechanism and correction

spawnRun inherited the server environment. ATOMA_HAYSTACK_CONFIG enabled project
retrieval in ordinary operator arms without a tenant run receipt. The assayer
now supplies a full isolated environment and retains host model credentials.
The tenant runner authority check remains intact.

Error/cancelled arms and missing traces cannot judge or retire a recipe. Failed
attempts preserve evidence and leave the surface pending, with the existing
failure pause. Legacy invalid evidence reopens only the current recipe surface;
missing/corrupt files do not silently authorize spending. Retry directories are
unique instead of deleting the previous attempt. Read-only shared readers serve
the VIZ and MCP, projecting legacy invalid records as failures without rewriting.

## Adversarial review of the accepted mechanism

- One successful control cannot retire a recipe whose treatment failed to launch.
  The entire pair remains unjudged; ordinary failed/partial results still count.
- A valid non-match stays not-reached; missing evidence is never a non-match.
- No tenant receipt is fabricated and the runner's authority refusal is unchanged.
- Retrying cannot erase logs, restore obsolete recipes, or bypass the global lease.
- Unknown evidence does not reopen a row. The recovery reads typed archived records.
- Recipe identity uses namespace plus id, so a namesake in another namespace
  cannot count as use of the target recipe.
- Readers are platform-only, accept ids rather than filesystem paths, reject
  escaping symlinks, bound records/log/trace output and explicitly mark model text.

## Verification

Regression coverage includes the real npm process boundary, legacy reopening,
immutable retries, infrastructure errors versus retirement, pagination and path
containment. Production verification is recorded after deployment below.

Local release: `npm ci` and `npm run release:check` passed on Node 24.20.0
with Homebrew Bash 5 (7,951 tests passed, 58 skipped). The first invocation used
macOS Bash 3 and failed two shell deployment fixtures; the supported modern Bash
run passed unchanged. `npm run viz:smoke` passed; the platform-admin Sentinel
section was inspected in a real Chrome screenshot with completed and invalid
attempts and an expanded paired-arm comparison. Interruption coverage also
confirms that the interrupted arm's log remains available through the reader.


## First production activation and generation handoff

Commit 92b224b9 passed CI, desktop packaging and deployment. Production MCP
discovery exposed all three new readers. The 36 legacy attempts projected as
failed without modifying their evidence; all 15 current recipe surfaces became
pending. The resident automatically started repair-isolated-browser-contract-test
at 14:17 UTC. Its first two arms completed with 21 model calls each, proving
that the Haystack launch refusal was removed; neither selected the target recipe.

A concurrent compatible deployment to caaa3356 at approximately 14:27 UTC kept
the assay alive on 92b224b9 while selecting the new executor. Reading only the
selected snapshot falsely hid this ongoing work. The health reader now uses the
existing process-birth-checked executor receipts: report the generation with an
assay in flight, otherwise the selected generation, naming its release. It does
not sum process-local counters or keep dead generations alive. A regression uses
two real child processes, switches the admission symlink, then kills the old
writer and rejects a recycled birth receipt. This reuses the existing liveness
rule; it introduces no new execution or admission gate.
