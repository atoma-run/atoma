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


## First complete production comparison

The attempt `5326d19a-f4af-4af3-913a-1653081038d1__repair-isolated-browser-contract-test__2b762bf46e0e__eeDoXX`
ran from 14:16:54 to 14:40:02 UTC. All four arms delivered, with 21, 21, 27 and
30 model calls respectively. Case 2's treatment trace records match, inject and
success for the exact namespace and recipe; neither control trace contains it.
The pre-registered judgement is neutral/keep over one matched case (one delivery
with and one without). No recipe was retired. Journal event 6923 independently
records completed/neutral/keep. All 36 legacy attempts remain archived and are
projected as failed; the history contained 37 completed-or-failed attempts at
verification. Four traces were paged to their ends through the new MCP reader;
large-event omissions remain explicit, and call counts above come from the
runner's stats rather than counting the bounded event projections.

The first case did not match the recipe. The tasks request inspection of a
prior repository that is absent from the fresh assay workspace; the delivered
reports therefore do not establish the recipe's benefit on that original
repository. This is a functioning comparison, not a demonstrated improvement
in task quality. No case or routing was fabricated to force the recipe to match.

Compact MCP evidence: [production proof](assayer-recovery-2026-10-23-proof.json).
The follow-up local release check passed 7,953 tests (58 skipped); the full
browser smoke and a real Chrome inspection of executor provenance also passed.


## Final deployment verification

22067885962f0607bc282ab818315382325d49b7 is selected by both
/home/atoma/current and the active executor socket. CI 39971769997, desktop
39971770010, security 39971769571 and deployment 39973327634 all succeeded.
The production MCP health simultaneously reports verify-clean-copy-node-tests
case 1/2 with its owning release caaa33567edb7af72119c4b0b0f736a655badfe3:
the real compatible handoff now preserves monitoring. Fourteen recipe surfaces
remain pending, including that active second assay. They continue automatically
when the ordinary global idle gate permits; this record does not claim all
fifteen comparisons have finished.
