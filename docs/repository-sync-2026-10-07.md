# Repository sync — design, 2026-10-07

Status: IMPLEMENTED LOCALLY, not committed or deployed. The design rests on the owner decisions of
2026-10-07 below and was designed against the incident records
([confrontation](#confronted-with-the-incidents)). One adversarial
pre-construction review found five blocking defects in the first draft. Each one
was corrected here ([review](#the-review-and-what-it-changed)). The implementation ships start synchronisation and debt-only publication together.

## The gap, read from the code

When someone commits to a project's repository outside Atoma, Atoma never reads
that commit back. On a repository Atoma created, the next publication reverts
those edits, and nothing says so.

- **Nothing listens.**
  - The webhook applies only `installation` and `installation_repositories`
    ([webhook.ts:95](../src/github/webhook.ts)).
  - The App is told to subscribe to no events ([setup](github-app-setup.md#webhook)).
  - No poll exists.
- **Repository created by Atoma (no `source`).**
  - The next run seeds from the previous `delivered`/`partial` workspace on the
    host (`previousSeedRun`, [coordinator.ts:1598](../src/projects/coordinator.ts)).
    GitHub is not read.
  - Publication commits every file of the workspace inventory
    ([publisher.ts:593](../src/projects/publisher.ts)) onto the live head's tree
    ([client.ts:1466-1472](../src/github/client.ts)). As a result:
    - a file the person *added* survives on the branch, but no later run sees it;
    - a file the person *edited* that the workspace also holds is overwritten by
      the workspace's stale copy, and the edit survives only in history;
    - a file the person *deleted* comes back.
  - The receipt records the moved head as `baseSha`, an observation nobody reads.
    The 2026-08-24 record called this "that one-directional steamroll"
    ([decided, not built](archive/designs/decided-not-built-2026-08-23.md#publication-by-local-clone-and-the-pull-that-would-sync-client-edits-2026-08-24)).
- **Imported repository (`source`).**
  - Each run snapshots the default branch before model work
    ([publisher.ts:318-395](../src/projects/publisher.ts)), so commits made
    before launch are seen.
  - Commits made during the run are handled by mode:
    - PR mode bases `atoma/run-<id>` on the captured base and is unaffected.
    - Fork mode refuses (`GitHubDivergenceError`,
      [client.ts:954-958](../src/github/client.ts)), and every retry refuses
      again because it reuses the captured base.
  - A fork never reads its upstream.

## Owner decisions, 2026-10-07

1. **Synchronisation is automatic.** Nobody is asked to pull, merge or confirm.
2. **The person wins** when they and Atoma changed the same file. Atoma's
   version is set aside, journaled and notified. It stays recoverable in the run
   workspace that held it.
3. **The workspace is reconciled when a run starts.** A `push` also
   **notifies** the organisation that the repository moved outside Atoma. The
   notification is a convenience, and correctness never depends on it.
4. **A fork project may follow its upstream** (`merge-upstream` before each
   run). It is opt-in at creation, off by default, changeable afterwards, and
   never a reason to refuse a run.

**What this settles.** The 2026-08-24 record named two coherent policies and
chose neither: (1) "the repository becomes the source of truth", and (2)
"workspace lineage stays; the overwrite becomes legible". These decisions take a
third path:
- The workspace lineage stays, so what a run kept without publishing is not
  lost. That covers the `ef70c2b8` data file that (1) would have dropped.
- The person's edits are merged into the lineage at seed time.
- The overwrite is not made legible: it stops.
- The transport remains the REST API. No local clone is introduced.

**What it admits, stated rather than slipped.** That record asked for one input
class to be stated, and the bounds are narrower than a first draft claimed. On a
repository Atoma created, file content authored by *anyone with push access to
that repository* now enters what the next run reads and executes. That includes
collaborators, bots and accounts outside the Atoma organisation.
- **Container.** The content runs in the run's container, and project runs have
  **proxied egress on by default** ([src/projects](../src/projects/AGENTS.md#run-network)).
- **Platform-wide reach.** The content can shape what a run learns into the
  platform-wide skill catalogue, which other organisations' runs dispatch from
  ([platform trust](platform-trust-2026-09-15.md)).
- **What still holds.** Imports already admit this class. The bounds that remain
  are container isolation, the publication path policy on the way in (below),
  and every rule that tool content is untrusted model input.

The owner accepted this input class; see [confirmation](#owner-confirmation-2026-10-07).

## The rule: what Atoma owes

**Why the first draft failed.** Every base taken from a commit misfires:
- *The run's starting commit.* Atoma publishes `y` over `x`, then the person
  reverts the file to `x`. "Base `x`, workspace `y`, branch `x`" reads as
  "Atoma changed it and has not published", so the next run republishes `y`
  over the revert.
- *The last published commit.* It fails the same way on any path a publication
  set aside.
- *A chain of runs.* The review's counterexample:
  1. a partial run leaves `app.js` untouched;
  2. the person edits it;
  3. the next run builds on that edit, but its BASE is still the chain's oldest
     start;
  4. so the next run's own work is called a conflict, blamed on the person, and
     dropped.

The base that matters is **each run's own start**, and the debt is per run.

**BASE_n, recorded when run n starts**, maps every universe path to
`(mode, git blob sha)`. It is persisted (see [storage](#storage)) and never read
back from GitHub.
- **When the start sync succeeded** (including the fast path), BASE_n is the head
  tree restricted to the universe. Paths still owed from earlier runs differ from
  that tree, so their debt carries forward without help.
- **When it did not** (sync unavailable, or no anchor yet), BASE_n is the seed's
  own inventory, except on the paths the seed run still owed: there it keeps the
  seed run's BASE value. For a first run, BASE_n is empty.

**D_n, what run n owes**, is evaluated on its finished workspace (OURS, whose
blob shas are computed locally: `sha1("blob <size>\0" + bytes)`).
- If n's publication reached `published`, D_n holds only its **tombstones**:
  paths it deleted that BASE_n holds. Everything else was written, or set aside
  in the person's favour.
- Otherwise (`partial`, text delivery, publication pending or failed),
  D_n = { p : OURS[p] ≠ BASE_n[p] }.

**Legacy seed runs** (started before this exists, so no record) are covered by a
one-time rule. BASE is the last published run's own manifest, valued at that
commit's tree. Paths outside that manifest are *unknown*:
- held only by OURS: kept, and owed (today's inventory publication would have
  written them);
- held only by THEIRS: taken;
- held by both but different: GitHub's version is taken.

This repairs two cases. The undeclared `expenses.json` of a plan-only manifest is
kept rather than deleted. A person's edit that legacy publication preserved
through `base_tree` is taken rather than overwritten by the stale workspace. From
the first synced start on, every run has a record.

**ONE DECISION PER PATH.** There is one function, `planRepositorySync`, called at
both ends of a run. THEIRS is the branch's live head.

| Path | Start of a run (sync) | Publication |
|---|---|---|
| not in `D` | take THEIRS: write, delete, or nothing if equal | write nothing |
| in `D`, THEIRS = BASE (the person did not touch it) | keep OURS (a tombstone stays absent) | write OURS (a tombstone cannot be published, as today) |
| in `D`, THEIRS = OURS | nothing | nothing |
| in `D`, otherwise | **conflict: take THEIRS** | **conflict: do not write** |

Checking the rule against each case:
- **The revert.** The run published, so D is empty and the person's `x` is
  taken.
- **A set-aside version.** It is never published later, for the same reason.
- **The review's counterexample.** The run after the edit has BASE = the person's
  `v1`. Its `v2` is owed, and publication writes it.
- **Partial work.** Work the person did not touch is kept, then published by the
  next delivered run. Work they changed too is a conflict, and the person wins.
- **A rename or deletion by Atoma.** It stays deleted in the line, as it does
  today. It does not come back from GitHub each run. The branch keeps the file,
  because publication still cannot delete.
- **A cleanup by the person.** A file they deleted on GitHub (an internal scratch
  file, say) leaves the next workspace. Today nothing can remove it.
- **A publication retried after a crash.** It finds its own commit as head, where
  THEIRS = OURS everywhere, so it converges to `unchanged`.

**UNIVERSE.** A path takes part only if three things hold:
- it is a regular file (`100644`/`100755`);
- its path passes `normalizeArtifactPath` (at most 512 characters, no
  leading/trailing whitespace, no traversal) and `assertPublishableArtifactPath`
  ([artifacts.ts:84-175](../src/projects/artifacts.ts));
- the materialised seed still passes the **file-delivery inventory**. That is the
  function delivery itself calls, with the shared `WORKSPACE_LIMITS` (100,000
  files, 10 MiB per file and 512 MiB total after the large-repository correction). The materialised seed is test-inventoried before it is
  accepted; a seed that fails is discarded, and the sync fails open.

Without that last check, a push above the workspace budget, or of a file named `notes `,
would make every later run fail at delivery after paying for it. Each time, the
next run would re-sync from the same seed. That is the
[2857a579](../src/projects/AGENTS.md) pattern of a run recorded `failed` that
then stops seeding.

The excluded namespace belongs to OURS alone:
- `node_modules`, the probe manifest and every `.atoma*` record are never
  "deleted because THEIRS lacks them", and never taken from THEIRS (where they
  can only be person-authored). The inherited checks of a project Atoma created
  therefore stay Atoma-authored.
- A committed `.env` never enters a model's workspace through the sync.

Three cases fall outside the universe or refuse the sync:
- A THEIRS entry outside the universe (a link, a submodule, an unportable name) is
  never taken. If OURS holds a regular file at that path, the file is removed from
  the seed and reported.
- Two paths that differ only by case, whether within THEIRS or across OURS and
  THEIRS, refuse the sync. The run host may be a case-insensitive volume.
- `.atoma-import.json` is NOT honoured for a repository Atoma created in this
  version. A configuration that changes over a project's life would need its own
  rule, so it is registered, not built.

**Path types.** A path is a conflict, and the person wins, when:
- it is a file on one side and a directory on the other; or
- any of its ancestors is a file on the other side.

So OURS never writes `lib/x.js` where THEIRS holds `lib` as a file.
Path-versus-directory replacement under `base_tree` is unmeasured on GitHub
([decided, not built](archive/designs/decided-not-built-2026-08-23.md), item 10).

## Storage

The record lives in **its own table**, `project_run_repository_sync`, one row per
run, written once:
- status (`synced`, `unchanged`, `unavailable`, `no_anchor`);
- the head commit;
- BASE_n;
- whether the seed was materialised, and from which run's directory;
- counts;
- at most 20 named paths.

`kept_remote` is a nullable column on the publication row.

**Why not `seed_json`, `git_json` or another strict column.**
- `runFromRow` parses `seed_json` for every row against `.strict()` variants
  ([store.ts:581](../src/projects/store.ts)), and `listProjectRuns` maps every
  row. An unknown member would break every listing on a binary that predates it.
- Production redeploys on every push to `main`, so a revert is a deploy. One
  unparsable row once made every later run of a project fail
  ([review 2026-09-25](archive/reviews/code-review-2026-09-25.md), 1.1).
- Old binaries never read the new table or the new column.

Only the run's resolver reads the table, and a bad row fails that run's sync open,
never the project's line.

**Size.** BASE_n is bounded by the universe: a few hundred entries, tens of
kilobytes. Persisting it means BASE is never fetched from GitHub. A base commit
that a force push and garbage collection made unreachable no longer matters, and
neither does retention of an older workspace.

**`repositoryBase`.** It is recorded too (`saveRepositoryRunBase`, write-once on
a running row, unchanged shape). It remains the observation of where the run
started.

## At run start (repository Atoma created)

The sync runs in the coordinator's preparation, beside the import branch
([coordinator.ts:1629](../src/projects/coordinator.ts)). It runs after the
reservation, under the run lease, before the child exists, and off the run's
budget.

**Its own deadline.** The sync gets its own sub-deadline and abort signal inside
`PROJECT_RUN_PREPARATION_TIMEOUT_MS`. It shares nothing with the retrieval
preparation, so a slow sync fails open instead of aborting retrieval and failing
the run.

The steps:

1. **Skip.**
   - A comparison rerun is skipped; it starts where its origin started (see below).
   - A lineage with no anchor is skipped: repository not `ready`, nothing ever
     published, or no publisher. That is today's behaviour, and the row records
     `no_anchor` with BASE as defined above.
   - A populated branch Atoma never wrote to (adopted on a 422 name collision) is
     never synced from, for the reason a null `expectedHead` against a populated
     branch is a refusal.
   - A missing or renamed branch is never re-seeded.
2. **Token.**
   - Reads use a **contents-read** installation token. It is a new, narrower mint
     than the publication token, which carries Administration write.
   - Tokens resolve through `projectInstallationToken`, which can rebind a
     project whose installation GitHub no longer knows, and journals it. A run
     start can now cause that rebinding.
   - The pre-flight `assertInstallationCoversRepository` turns a narrowed
     installation into an actionable message instead of a bare 403.
3. **Read and plan.**
   - Read the head and its recursive tree (entries only; a truncated tree fails
     open).
   - Inventory OURS, resolve the seed run's D, and plan.
4. **Fast path.** If the plan takes nothing, the previous workspace is the seed,
   untouched. That covers every run of a project nobody edits on GitHub, at the
   cost of a few requests and no blob download.
5. **Materialise.**
   - Build `<run>/repository-seed`, the path imports already use
     ([publisher.ts:377](../src/projects/publisher.ts)), as a **hard-linked**
     tree of the previous workspace (a copy across filesystems).
   - Download only the blobs to take; there are at most as many as the delivery
     limits allow, which bounds both time and the installation's shared hourly
     quota.
   - Replace taken files by unlink-then-create, never by writing through a link,
     and apply deletions by unlink.
   - Nothing else ever writes there. The previous workspace is therefore never
     modified, so it stays that run's evidence
     ([seed inheritance](seed-inheritance-2026-09-25.md#the-contract-as-built))
     and keeps every set-aside version recoverable.
   - Disk cost is the taken files alone.
   - Test-inventory the result (see Universe).
   - The child copies its seed once, through `seedWorkspace`
     ([runner.ts:918](../src/run/runner.ts)), which filters the probe manifest.
     A deepening restart re-seeds from the same directory, which stays for the
     whole run.
   - `--seed` is passed exactly as today: "a seed says where the workspace came
     from, never why" ([src/run](../src/run/AGENTS.md)).
6. **Record.** Write the sync row and `repositoryBase`.
7. **Journal.**
   - `project.repository_synced`, with counts.
   - When there were conflicts or entries removed, also
     `project.repository_attention`, naming at most 20 paths.

**What the child is handed from the lineage.** All three hand-overs are gated
today on `seedFrom === seedRun.workspacePath`
([coordinator.ts:1649-1662](../src/projects/coordinator.ts)), and a materialised
seed would fail that gate silently. Each is decided here:
- **Landing reasons and previous text results** keep flowing. The gate becomes
  `seed.kind === 'run'`, because the materialised seed is that lineage plus a
  person's edits. Both remain labelled untrusted history.
- **Standing HTTP evidence** flows only when this start took nothing from GitHub,
  and its lineage walk stops at any run whose start took something
  ([standingEvidence.ts:30-45](../src/projects/standingEvidence.ts) walks three
  hops). The digest covers the server entry and its relative imports, but "a
  package, a data file or the environment is not in the digest"
  ([src/contracts](../src/contracts/AGENTS.md)). After a person's edit, HTTP
  criteria are therefore proven live again.

**Downstream readers see the merged start.**
- The runner snapshots its `--seed` before any model work
  ([runner.ts:1126-1128](../src/run/runner.ts)). The acceptor therefore reads
  the person's edits as part of the start, not as the run's own work or as damage
  (the J9 fix of [2026-09-27](incidents/production-runs-2026-09-27.md)).
- Inherited checks replay against the same start. This is not only information:
  a check whose element the person removed is marked dead, and after a second
  dead run it is removed ([src/run](../src/run/AGENTS.md)). A person's edit can
  retire Atoma's regression checks.

**Failure: fail open (accepted).** The sync can fail for several reasons:
GitHub unreachable, installation gone, branch missing, truncated tree, a limit,
a case collision, an unreadable row, or the sub-deadline.
- The run starts from the previous workspace. Its row records `unavailable`, with
  BASE defined from the seed.
- `project.repository_attention` (reason `sync_unavailable`) says so before any
  spend. Its message is redacted like import errors: no host paths.
- This loses no edit. D then counts only what Atoma changed, and a path the
  person changed meanwhile is either outside D and not written, or a conflict.
- Fail-open was confirmed by the owner.

## At publication

Publication becomes "write the D rows the table says to write".

**What does not change:**
- `revalidateArtifactManifest` still checks the complete delivered inventory
  first.
- `publishManifestCommit`'s authority checks stand: a null `expectedHead` against
  a populated branch, a gone branch, a ruleset refusal.
- The first publication (the manifest IS the tree) is untouched.
- A publication failure never changes a delivered run's status.
- `partial` never publishes.

**What changes:**
- **THEIRS is read per D path.** It comes from the trees of D's parent
  directories, not from one recursive read, so a large repository cannot make
  publication fail. D is bounded by the delivery limits.
- **Only D paths the person has not changed are uploaded.** That means fewer blob
  calls than today's whole-inventory upload.
- **Conflicts are not written.** They are counted in `kept_remote` and named in
  `project.repository_attention`. The next start finds the run published, so D
  holds only its tombstones and the person's version is taken. No conflict is
  reported twice.
- **An empty write set is an explicit no-op.** That happens after a crash, when
  every path is a conflict, or when D holds only tombstones. It returns
  `unchanged` with the head commit. Today `normalizeManifestFiles` and
  `createTree` both throw on zero entries
  ([client.ts:1081, 1249](../src/github/client.ts)).
- **If D cannot be resolved, the publication fails** (`publication.failed`) and
  stays retryable. It never falls back to the whole inventory.
- **The commit message is rendered after planning.** It lists the paths this
  commit writes. Today it lists "the run's publication file set", which would now
  name files the commit did not touch. Parent and created-versus-extended stay
  omitted, and the anti-forgery rules for the goal stand.

**Retries race no run.**
- `retryPublication` ([coordinator.ts:1933](../src/projects/coordinator.ts))
  takes no lease today. The order gate refuses an older run only once a newer one
  is *published* ([publisher.ts:566-575](../src/projects/publisher.ts)).
- Under this design, a retry that lands while a later run is in flight can
  overwrite a revert, republish a set-aside version, or fake a conflict (review
  finding 2).
- A retry therefore takes the run lease, and it is refused unless the run is the
  project's current seed run with no run of the project queued or running. A
  later lineage run already carries its work: "a later run's workspace is seeded
  from the earlier one". This applies to the HTTP, MCP and CLI entry points.

**The window between reading the head and moving the branch** no longer loses
work.
- The commit's parent is the head just read, and the reference moves with
  `force: false`.
- A person's commit pushed inside the window makes that move a non-fast-forward.
  GitHub refuses it, `GitHubRefRefusedError('moved')` fails the attempt, and the
  retry re-plans.
- Only a reset *to an ancestor* inside the window is rolled forward, as today.

**Fork mode takes the same rule** ([client.ts:940](../src/github/client.ts)).
- BASE is the captured base, which is exact: an import starts from a fresh
  snapshot.
- A head that moved since then is merged path by path, the person winning,
  instead of refused. The parent becomes the live head, so the receipt's
  `baseSha` is the head read before publication, as it already is for repositories
  Atoma created.
- Three stated contracts change with this:
  - "Changes to a fork's head during a run are refused instead of overwriting
    those changes" ([setup](github-app-setup.md)).
  - "Changed fork heads … are refused; … matching tree+parent receipts converge"
    ([src/github](../src/github/AGENTS.md#existing-repositories)). The no-op above
    replaces that convergence.
  - "The captured run base for imported projects" as the publication parent
    ([src/contracts](../src/contracts/AGENTS.md)).
- PR mode is unchanged. Its branch rests on the captured base, and GitHub shows
  the person any overlap.

## Fork projects following their upstream

**Setting.** `followUpstream` is valid only with `source.mode = 'fork'`, and
defaults to false.
- It lives in its own project column, not inside `repositoryTarget.source`. The
  source is identity and immutable; this is a policy a person may revoke.
- The precedent is `showcase`: chosen at creation, changed later by an admin
  (`setProjectShowcase`, `atoma_project_showcase`).

**Surfaces.**
- `createProjectInputSchema` gains one optional field, which reaches the HTTP
  route, the creation form (copy in `en.json` only) and `atoma_project_create`.
  MCP output schemas are loose objects, so this is additive for every registered
  client.
- The project page gains an admin toggle, journaled as
  `project.upstream_follow_changed`.
- No new MCP tool: the catalogue stays at 42. An MCP toggle is registered, not
  built.

**At run start**, in `prepareRepositoryRun` before the head read, Atoma calls
`POST /repos/{fork}/merge-upstream {branch: defaultBranch}`.
- It uses the publication token, which already carries `contents: write`. No
  permission is added, so no installation has to re-accept.
- The call is skipped on the run that creates the fork. It runs inside the
  reserved run, so it never races another run of the project.
- `200` with `merge_type` `fast-forward`, `merge` or `none`: the snapshot and
  base include upstream, and `project.repository_synced` records which.
- `409` (conflict), `422` (other refusal) or a transport error: the run continues
  from the fork as it is, with `project.repository_attention` (reason
  `upstream_not_merged`). The person resolves it on GitHub with *Sync fork*.

**Live measurement checklist.** Results and remaining limits are recorded in
"Live GitHub measurements" below; these are not assumptions made from the API documentation:
- whether the installation token suffices when the upstream is private or outside
  the installation;
- which upstream branch is merged when names differ;
- whether an upstream change under `.github/workflows/` is refused, because the
  App deliberately holds no Workflows permission;
- the merge commit's author;
- the push event's `sender`, expected to be the App's bot.

## Push notification

**Subscription.**
- The App subscribes to `push`. The Contents permission it already holds is
  enough.
- The setup document, the handler and the indexed projects-by-repository query
  change together.
- An instance that does not subscribe, or that misses a delivery during a deploy,
  loses only the notification.

**Parsing.**
- `processGitHubWebhook` verifies the signature first.
- It then turns a `push` into a typed observation: repository id, ref, before,
  after, created, deleted, forced, sender login and type, installation id.
- It hands that observation to an injected `onPush`, the same seam as `events`,
  so `src/github` still knows nothing of projects.

**Filtering.**
- Branch refs only.
- A `sender.login` of `<ATOMA_GITHUB_APP_SLUG>[bot]` is Atoma's own write
  (publications, merge-upstream) and is ignored.

**Resolution.**
- Only projects Atoma created, and fork projects, are resolved: projects of the
  installation's organisation whose repository id and tracked branch match.
- PR-mode projects are left out: a person merging Atoma's own PR is a push by a
  person, and would notify on every cycle.

**Coalescing.**
- Only the **first** such push since the project's last run started emits
  `project.repository_moved`. It journals the fact and notifies the
  organisation's owners.
- The limit is a read-back, a cross-tick guarantee, and the only one
  `platform_events` offers.
- It bounds noise and journal growth: the 50,000-row cap is not spent on history
  GitHub already keeps.
- "Moved" is a journaled fact, never a project column.

**No action.**
- A push never triggers a sync and never writes anything.
- A replayed delivery is deduplicated, and a forged one fails the signature.

**Volume.**
- An installation on *all* repositories delivers every push in the account. That
  costs one delivery row (pruned by the existing retention) and one indexed
  lookup per push.
- The setup document recommends selected repositories.

**Size.**
- Bodies stay bounded at 1 MiB ([webhook.ts:11](../src/github/webhook.ts)).
- A larger push is refused (413) and journaled `webhook.rejected` at its existing
  `security` severity. Bytes refused before the signature cannot be told apart
  from an attack.
- This needs a push of hundreds of commits at once, and is documented as
  expected. The next run syncs regardless.

**Wording.** The copy says the repository moved. It shares no word with a ruleset
refusal ([src/github](../src/github/AGENTS.md)).

## Event vocabulary

| Kind | Severity | Push audience | Emitted when |
|---|---|---|---|
| `project.repository_moved` | info | org owners | the first push to a tracked branch by anyone but the App since the project's last run started |
| `project.repository_synced` | info | — | a run's start sync finished (counts, fast path, upstream result) |
| `project.repository_attention` | warning | requester, org owners | a conflict at start or at publication, entries removed, sync unavailable, or upstream not merged |
| `project.upstream_follow_changed` | security | — | the fork setting changed. What enters a project is an exposure decision, like `showcase` |

How the events are written:
- `reason` is rendered through a word map, as `github.installation_status`
  already is.
- Paths, logins and repository names go through `eventLabel`, and `detail` names
  at most 20 paths. Commit messages from push payloads are never stored.
- The copy lives in `src/viz/push/routes.ts`, as for every route.
- The audiences are `PUSH_ROUTES` decisions; this review covers them.

## Reruns, retention, retrieval, preview

- **Reruns.** A comparison rerun starts where its origin started. If the origin's
  row says `materialised`, the rerun seeds from that directory, and records the
  same directory in its own row, so a rerun of the rerun does too. If the
  directory is gone, the rerun is refused, like any expired seed. Imported
  projects stay refused.
- **Retention is unchanged.** `repository-seed` lives in the run's own parent
  directory, in both layouts, and is deleted or held with it. An expired seed run
  still throws in `previousSeedRun`; the start never falls back to seeding from
  the remote.
- **Retrieval lags one run.** The corpus is still built from the seed run's stored
  manifest, through the hash-checked copy of
  [2026-09-09](incidents/project-retrieval-record-2026-09-09.md). A document the
  person edited is in the workspace at once, and in the corpus from the next run.
- **Preview.** A delivered run's preview is built from that run, never from later
  commits. That is unchanged.

## Confronted with the incidents

Every record in `docs/incidents/` was read, plus the decision documents on seeds,
imports, publication, reruns, inherited checks and events; the engineering record
was searched by topic. The records with a bearing on this design:

| Record | Fact | How this design meets it |
|---|---|---|
| [Decided, not built](archive/designs/decided-not-built-2026-08-23.md), 2026-08-24 | Two policies, neither chosen; a new input class "must be stated, not slipped" | A third, owner-chosen policy; the input class stated with its real bounds, and asked |
| [Progressive runs](incidents/progressive-runs-2026-09-21.md) | "The accumulation IS the product"; the seed is scoped to (org, project) | THEIRS modifies the lineage and never replaces it; Atoma's deletions stay in the line |
| [Seed inheritance](seed-inheritance-2026-09-25.md) | One seed copy; the source never modified; deepening re-seeds | A separate hard-linked tree, never written through; copied by `seedWorkspace`; kept for the run |
| [In-flight preview](in-flight-preview-2026-09-02.md) | A run workspace is never touched | Nothing is merged in place |
| [Review 2026-09-25](archive/reviews/code-review-2026-09-25.md) 1.1, 2.2 | One bad row failed every later run; errors leaked host paths | A separate table, failing open per run; redacted messages |
| `2857a579`, [src/projects](../src/projects/AGENTS.md) | A run recorded `failed` stops seeding the next | The sync never produces a seed the delivery inventory would refuse |
| Run setup, [src/run](../src/run/AGENTS.md) | Reading `--seed` as "a measurement" removed root acceptance | `--seed` unchanged; no protocol change |
| [Production 2026-09-27](incidents/production-runs-2026-09-27.md) J9 | The starting snapshot frames what a seeded run changed | The materialised seed is that snapshot's subject |
| Standing evidence, [src/contracts](../src/contracts/AGENTS.md) | The digest omits packages and data files | Withheld after a take; the walk stops at a take |
| [Inherited checks](inherited-checks-replay-2026-10-01.md), [src/run](../src/run/AGENTS.md) | Replayed on the untouched seed; dead checks removed after two runs | Replayed on the merged start; retirement by a person's edit stated |
| [Text history](text-review-and-history-2026-10-03.md) | History follows the actual seed lineage | A materialised seed is still that lineage |
| Preparation budget, [src/projects](../src/projects/AGENTS.md) | Import work billed to the tenant (1787s on 1800s) | Bounded preparation with the sync's own sub-deadline |
| [Run-fix loop](incidents/run-fix-loop-2026-09-24.md) | Seven projects on a dead installation; a bare 403 | Rebinding and the pre-flight; fail-open keeps them running |
| [src/github](../src/github/AGENTS.md): branch gone, `expectedHead`, crash repair, ruleset wording | Never re-seed; never adopt unpublished history; retries converge; distinct words | All kept; convergence through the explicit no-op |
| `base_sha` and staleness, [src/projects](../src/projects/AGENTS.md) | A stored head is a cache of GitHub's state | BASE_n is the run's own observed start, an input to what Atoma owes, never the authority to write (read live) |
| Publication cannot delete, [src/github](../src/github/AGENTS.md) | Deletion unexpressible on purpose | Unchanged; Atoma's deletions held as tombstones in the line |
| Older-run publication gate, [src/projects](../src/projects/AGENTS.md) | "A later run's workspace … already contain[s] that work" | Widened: no retry once a later lineage run exists; retries under the lease |
| [Production 2026-09-26](incidents/production-runs-2026-09-26.md) O4, [parallel mission](incidents/parallel-mission-repair-2026-10-03.md) | Internal sidecars published, then excluded | The excluded namespace belongs to OURS alone, both ways |
| [Review 2026-09-24](archive/reviews/code-review-2026-09-24.md) §C | "Do not silently overwrite external changes" to resume imports | Imported seeding untouched; fork publication now overwrites nothing |
| [Comparison reruns](comparison-reruns-2026-09-25.md) | A rerun starts from its origin's exact start | Re-runs from the recorded materialised seed |
| [Production 2026-09-30](incidents/production-runs-2026-09-30.md) ff102525 | One stray `server.js` reclassified a project | Accepted: the workspace is what the repository holds; the attention event names what was taken |
| [Platform events](platform-events-design.md), [src/platform](../src/platform/AGENTS.md) | A closed vocabulary; a short push list; a bounded journal | Four kinds; one notifying push per project between runs |
| [Transient 502s](incidents/deployment-transient-502-2026-09-21.md) | Deliveries can be lost during a deploy | The notification is never the mechanism |

## The review, and what it changed

One adversarial pre-construction review attacked the first draft against the code.
It found five blocking defects, and each changed the design:

1. **The chain's oldest start as BASE lost Atoma work built on a person's edit,
   and blamed the person.** BASE is now per run, recorded at that run's start.
2. **A publication retry racing a later run** could overwrite a revert,
   republish a set-aside version, or fake a conflict. Retries now take the lease,
   and are refused once a later lineage run exists.
3. **"A published run owes nothing" brought every file Atoma deleted back from
   GitHub each run.** Published runs now keep their tombstones. Publishing
   deletions was the alternative, and it was not taken: it would reverse
   "deletion is not expressible", which exists so that a wiped or shrunken
   workspace cannot empty a repository.
4. **The universe was wider than the delivery inventory**, so one push could make
   every later run fail after paying. The materialised seed now has to pass that
   inventory.
5. **A new member in the strict `seed_json`** would have broken every listing on a
   reverted binary. The record now has its own table.

Should-fix findings, all adopted:
- the legacy rule from the last published run's own manifest (it covered
  plan-only manifests and stale workspaces);
- BASE persisted instead of fetched;
- the standing-evidence walk;
- the true security bounds (egress on, anyone with push access, the platform skill
  catalogue);
- the sync's own sub-deadline and capped downloads;
- a hard-linked materialisation;
- the path-type rule restated;
- `.atoma-import.json` withdrawn for this version;
- the explicit no-op;
- PR projects excluded from push resolution, with the volume stated;
- the commit message listing the written paths;
- the complete list of contract changes.

Minor findings, also adopted:
- reruns of reruns;
- inherited-check retirement stated;
- three factual corrections (imports refuse workflow paths; the preview is not the
  workspace; the launcher layout);
- the missing projects-by-repository index;
- a contents-read token;
- cross-side case collisions;
- shipping publication and start sync together.

What the review checked and found sound:
- every cited line;
- preparation under the lease;
- `saveRepositoryRunBase` callable for projects Atoma created;
- `moveBranch` refusing a non-fast-forward with `moved`;
- local blob shas;
- retention of the run-owned directory;
- the webhook seam and the bot-login filter;
- MCP additivity;
- materialisation path checks;
- the fork base;
- PR mode untouched.

## Rejected alternatives

- **Seed a project Atoma created from the branch head, like an import.** It drops
  what Atoma owes (a `partial` run's work, a failed publication) and what is never
  published (dependencies, and the data files a run kept, the `ef70c2b8` case).
- **Sync the previous workspace in place on a push.** It mutates another run's
  evidence, and a workspace matters only when a run starts.
- **An overlay passed to the child.** It would be a second seed path beside
  `seedWorkspace` and the deepening restart.
- **A local `git` clone.** The 2026-08-24 cost analysis stands.
- **A base taken from commits or from a chain.** See the counterexamples above.
- **Publishing Atoma's deletions.** See review finding 3.
- **Journaling every push.** It means unbounded growth to record history GitHub
  keeps anyway.

## Not closed here

- Atoma's own deletions still never reach the branch.
- Imported snapshots still admit secret-like paths such as `.env`. Workflow paths
  are already refused unless excluded.
- A PR left unmerged is still invisible to the next run of a PR-mode project.
- If a default branch is renamed on GitHub, the stored `defaultBranch` goes stale.
  The sync reports `sync_unavailable`, and publication refuses with
  `GitHubBranchGoneError`, as today.
- `.atoma-import.json` for repositories Atoma created.
- A project whose repository outgrows the delivery limits cannot be synced, and
  the attention event says so. Atoma could not deliver it anyway.

## Tests (planned)

**`planRepositorySync`, as a table:**
- every row;
- a synced, an unavailable and a no-anchor BASE;
- tombstones;
- the legacy rule, including a plan-only manifest and a stale workspace;
- the revert, the review's partial-then-edit counterexample, and a set-aside path
  at the next start;
- a cleanup flowing back;
- mode-only changes and path-type conflicts;
- excluded paths on each side, a link in THEIRS, an unportable name;
- case collisions within and across sides.

**Start sync through the coordinator, with a fake GitHub client:**
- the fast path seeds from the previous workspace with no download;
- a moved head materialises a hard-linked `repository-seed` and leaves the
  previous workspace byte-identical, with matching inode content;
- the sync row and the base are recorded;
- landing and history reach the child, and standing evidence is withheld and the
  walk stopped;
- a seed failing the delivery inventory is discarded;
- a failure (including the sub-deadline) fails open with the redacted event
  journaled before the child spawns, while retrieval still prepares;
- a rerun, and a rerun of a rerun, take the origin's seed;
- an unreadable sync row fails one run open;
- an old-schema reader ignores the new table.

**Publication:**
- an edit the person made during the run survives;
- a conflict is not written and is counted;
- a push inside the window is refused and converges on retry;
- a crash after the reference move returns `unchanged` (the zero-entry path);
- partial work reaches GitHub through the next delivered run;
- a retry is refused while a later run exists;
- a moved fork head is merged;
- PR mode is byte-identical to today;
- the commit message lists the written paths.

**The defect, end to end.** Run 1 publishes. A person edits `app.js` and adds
`notes.md` on the branch. Run 2's workspace holds both, and run 2's publication
leaves the person's `app.js` intact. The test must fail on today's code.

**Webhook:**
- the signature is checked first;
- bot pushes, tag refs and PR projects are ignored;
- one notification per project between runs;
- an oversized body is refused.

**merge-upstream:**
- each answer;
- skipped on fork creation;
- the setting refused on a non-fork.

## Implementation order

1. **Contracts and storage:** the four event kinds with severities and routes; the
   sync table; `kept_remote`; `followUpstream` with its column; the
   projects-by-repository index.
2. **GitHub client:** a tree listing without blobs, per-path tree reads, selected
   blob reads, a contents-read mint, `merge-upstream`, the zero-entry no-op.
3. **`planRepositorySync`** and the BASE/D resolver, with their table tests.
4. **The start sync and the D-only publication, together,** with the retry gate,
   the hand-over gates, standing evidence and reruns.
   - Neither ships alone. Production deploys every push, and a D-only publication
     without a start sync turns every later Atoma change to a file a person ever
     touched into a permanent conflict.
5. **The fork setting and merge-upstream,** after measuring on a throwaway fork.
6. **The push webhook,** its notification, and the App setup document.
7. **AGENTS.md:** [src/projects](../src/projects/AGENTS.md) (seeding, hand-overs,
   publication write set, retry gate, reruns, commit body),
   [src/github](../src/github/AGENTS.md) (D-only writes, the no-op, fork heads and
   convergence, push, merge-upstream, the read token),
   [src/contracts](../src/contracts/AGENTS.md) (the fork publication parent,
   standing evidence) and [src/platform](../src/platform/AGENTS.md) (the
   vocabulary).

## Owner confirmation, 2026-10-07

The owner accepted all three recommendations before implementation:

1. Start sync fails open, with an attention event before model work. Publication
   still protects the live branch; the run may work on stale content.
2. A client deletion wins over unpublished Atoma work. The previous workspace
   retains that work within its ordinary retention window.
3. Admit content from anyone with repository write access, as imports already
   do. No organisation-author filter is introduced. Container egress and shared
   skill learning retain their existing contracts.

## Live GitHub measurements, 2026-10-07

The owner authorised throwaway repositories in `happs-team` (upstream) and
`mgtf` (fork). No product repository or production run was changed.

- A private upstream could not be forked: the organisation refuses private
  forks (403; enabling it for this one repository was also refused, 422).
  **Private-upstream installation access remains unmeasured.**
- On the public throwaway pair, a contents-write installation token scoped only
  to the fork, with the upstream outside the installation, returned 200 and
  `merge_type: fast-forward`.
- After renaming the upstream default branch to `probe-upstream` while keeping
  the fork branch `main`, sync took the new upstream content. The response
  initially still named `happs-team:main`; the fork's `renamed.txt` proved the
  content, and the later divergent merge named `happs-team:probe-upstream`.
- An upstream workflow addition returned 422: the App lacks `workflows`
  permission. No permission was widened. The implementation reports
  `upstream_not_merged` and continues from the fork.
- With distinct commits on both sides, merge returned 200, `merge_type: merge`.
  Its commit had two parents, author `atoma-dev[bot]`, committer `web-flow`.
- Push sender could not be measured: this App's webhook-delivery endpoint
  returned 404. The configured App-bot login filter is a notification filter,
  never a correctness or publication authority.

The first private repository was confirmed deleted by the owner. The owner
subsequently chose to retain the public pair, `atoma-sync-probe-1791349631967`
in `happs-team` and `mgtf`. They contain test fixtures only.

## Implementation details discovered during construction

- An unavailable or corrupt legacy base cannot safely invent publication debt.
  `debtResolved: false` records that uncertainty; publication refuses instead
  of uploading the entire workspace. A later successful sync can recover using
  the conservative legacy rule and the last published manifest.
- Imported PR preparation retains its existing path. Fork snapshots record a
  base where bounded; legacy fork publication resolves its captured run commit
  by manifest paths. The live parent is still read immediately before planning.

## Local verification

- Pinned Node 24.20.0, `npm ci`, then `npm run release:check`: passed;
  419 test files passed, one skipped, 5,572 tests passed, 19 skipped. Dependency
  audit found no vulnerabilities. Both TypeScript configurations, lint, build,
  compiled release and authentication smokes passed.
- Additional targeted verification passed for optional upstream refusals
  (409/422/503) and the standing-evidence lineage boundary (33 tests).
- Coordinator regressions exercise real store, coordinator and publisher paths
  against the GitHub API fixture: remote changes before launch, concurrent
  edits, failed publications, no first published anchor, client deletion and
  materialised reruns. Prior workspace bytes remain unchanged.
- Browser verification: OAuth consent/token exchange and the real GPU smoke
  passed, including fork-setting persistence after reload, mobile navigation,
  automatic update and WebGL fallback. The new scenario explicitly selects
  the project before editing and after a manual reload.
