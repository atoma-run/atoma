# Registry — AGENTS.md

`src/registry/` owns the tier-keyed atom-type table: identity, names,
ordinals, versions, provenance and trust counters. There is ONE table for the
whole platform; atom IDs are globally unique.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Identity changes are whole-system operations; the root states which halves
must move together.

Neighbours:

- [`src/skills`](../skills/AGENTS.md) — namespaces keyed by atom id
- [`src/atoms`](../atoms/AGENTS.md) — branching and escalation
- [`src/cli`](../cli/AGENTS.md) — the operator commands

## One registry, one trust

- A RUN IS A RUN (owner decision 2026-09-15,
  [platform trust record](../../docs/decisions/platform-trust-2026-09-15.md)). The
  operator's runs, every organisation's project runs and the benchmarks read
  the same rows and bump the same counters. `AtomRegistry` takes a database
  and nothing else; there is no owner, no per-caller predicate, no fallback.
- What a tenant run still proves before any writable handle is that it IS the
  run the host registered, on the host's recorded paths
  (`assertProjectRunAuthority` in [src/projects](../projects/AGENTS.md)). That
  check gates the launch, never the rows.
- Names are unique across tiers in the one table; UUID atom IDs stay globally
  unique and skill namespaces stay keyed by that ID. Ledger entities are type
  names; the atom-id-keyed project events of the partitioned period stay in
  the ledger as history and are not compared by `ledger check`.
- `openDb` is the ONLY thing that folds, and a read-only handle never does.
  Anything that SERVES the store must fold it first — the viz server does it at
  startup — and every read-only reader keeps `unfoldedRegistryPredicate`, which
  is `'1'` on a folded store and the old owner filter otherwise. Without both,
  a reader that stopped filtering by owner publishes one row PER OWNER; that is
  how the production Registry came to list every type twice on 2026-09-15.
  `AtomRegistry` refuses an unfolded store rather than merge two catalogues.
- `openDb` folds a store still partitioned by owner (2026-09-09 layout) back
  into the platform: whole-file backup first, operator rows kept as they are,
  same-name project rows ABSORBED with their counters added and the identity
  mapping written to `atom_id_merges` (the skills catalog follows it), other
  project rows kept whole with a fresh ordinal or `-<n>` suffix only on
  collision. One immediate transaction; a failed fold leaves the store as it
  was beside its backup. Superseded record, kept as evidence:
  [ownership record](../../docs/decisions/project-registry-ownership-2026-09-09.md).

## Descriptions and bootstrap

- Registry descriptions are reusable capability labels, never task narratives.
  Route creation descriptions through `resolveCreationDescription`.
- OPEN, measured not designed: the prefilter routes on the DESCRIPTION while
  `atomBehaviorKey` deduplicates on the PROMPT, and they disagree. Same tool
  signature means the same description by construction, so identities with
  distinct prompts show the catalogue identical lines it cannot choose between,
  and a validator patch splits an equivalent group permanently. `createOrReuse`
  bounds the creation rate, not the catalogue. Evidence and the refuted
  credit-loss hypothesis:
  [the production catalogue, measured](../../records/incidents/registry-catalogue-2026-09-16.md).
  The reconciliation is designed from that record and
  [the clone engine, measured 2026-10-10](../../docs/decisions/registry-reconciliation-2026-10-10.md)
  (18 molecules, a prompt revision mints a generation of clones), under
  adversarial review — the deferral the record asked for was the
  cooling-off rule, removed 2026-09-27.
- Canonical bootstrap is idempotent and bucket-specific. Prompt/tool changes
  patch and reset trust only when content genuinely differs. It REPLACES the
  declarations a canonical holds with the live ones (`refreshCanonical`,
  2026-10-26): adding by name alone kept a cell's `write_file` text of before
  2026-10-11, which every molecule it created inherited. A refresh that
  changes only declarations keeps the streak, as a template revision does.
- Every run's bootstrap also refreshes each tier-1/2 TEMPLATE-BORN type, per
  type (`refreshTemplateBornTypes`, after the task-baked repair): a stored
  prompt that is its host baseline, optionally plus a learned suffix, gets the
  current render and the live declarations by name, streak kept; a
  validator-written or custom prompt keeps prompt and declarations. Until then
  `createOrRefresh` refreshed one only when its signature was created again,
  and a reused molecule (Sucrose, run f91cdb19) kept teaching a tool it lacks.
  `isTemplateBorn` is the ONE definition, `createOrRefresh`'s family uses it
  too: a row older than the baselines (2026-10-12) whose prompt the template
  recognises keeps that prompt, takes the live declarations and is baselined.
  The check, the derivation and the write share one `withWriteLock`
  transaction on a row read under it, so a validator patch committed after
  the listing is never half reverted. A run's root tissue holds the live
  declaration of every tool it holds (`tissueForRun`, src/run), and Meristem's
  stored row is refreshed like a canonical: seeded from stale tissue
  declarations, every in-run creation reverted the family the bootstrap had
  just refreshed, one version per run, and concurrent credits stopped growing
  the streak (review 2026-10-26).

## Trust counters

- `successes` / `failures` retain historical totals; `consecutiveSuccesses`
  counts approved final results since the last failure or behavior change.
  These are result credits, not distinct runs. A failure resets only the streak.
- A prompt/tool/parameter patch or rollback resets the streak, preserving totals;
  a description-only patch and a no-op preserve both. `type-trust-reset` records
  the revocation without making the ledger erase historical totals.
- A supervised credit is bound to the instance's loaded registry version.
  Results from stale or locally modified behavior still count in history, but
  cannot grow the current version's streak or borrow its validation bypass.
- Merging histories or compensating counters resets the streak: unordered
  evidence must never manufacture consecutive successes. Old stores initialize
  clean histories from their success total and mixed histories from zero.
- Automatic creation and branching use `createOrReuse` / `branchOrReuse`.
  Equivalence includes tier, complete tool declarations, parameters and prompt
  (apart from the leading persona name), never merely the tools or description.
  A TEMPLATE-born creation (the narrow L1/L2 prompts the code renders) goes
  through `createOrRefresh`: an exact match is reused, else the oldest type
  of the same tier, tool names and parameters whose prompt the template
  predicate recognises is reused and refreshed to the current template —
  streak kept, version recorded as `template refresh` — as the bootstrap
  refreshes canonicals. Before 2026-10-10 each template revision made every
  earlier type non-equivalent and the next creation a clone
  ([the clone engine](../../docs/decisions/registry-reconciliation-2026-10-10.md)).
  The clones that exist are merged by a PERSON naming the winner:
  `registry merge` / `atoma_registry_merge` (`mergeIdentities.ts`) archive
  the store and the touched namespaces, move the losers' recipes under the
  winner, then `mergeInto`. `dedupe` groups by display name and finds none
  of them.
  `listCapabilities` presents one oldest identity per equivalent behavior and
  excludes an entire equivalent group if any member is excluded. It never
  deletes history, moves skill namespaces or transfers trust between identities.
  Explicit `create` / `branch` remain allocation APIs for deliberate new identities.
  Design and adversarial cases: [recoverable trust](../../docs/decisions/recoverable-trust-2026-09-15.md).

## Names and allocation

- Atom names are NOT all curated. `branch` accepts an LLM-authored
  `overrideName` (`verdict.branchName`) and takes only the ORDINAL from
  `nextAvailable`, so task-themed names enter the catalogue by design. That
  is why `registry dedupe` exists and why its fuzzy key is the only thing
  catching word-order variants the order-sensitive branch guard lets through.
  Do not delete the dedupe surface on the grounds that names come from a pool.
- `nextAvailable` takes the set of names already held and SKIPS pool entries
  whose name is taken: ordinals and names are separate namespaces, because an
  LLM `overrideName` occupies a name without consuming its ordinal. The check
  belongs on the allocator that inserts, not on `branch` — only there does it
  also cover a name squatted ACROSS tiers (`atom_types.name` is UNIQUE across
  tiers while the pools are per-tier) and a store that already
  contains a squatter. Reserving the pool against `branch` instead was tried
  and reverted: it closed one tier of three and renamed branches to orphan
  `-2` names whose unsuffixed twin could never be issued.

Registry writes carry an async-scoped recovery barrier on the same SQLite
connection, before the mutation. Rollback also rolls back that barrier; no crash
recovery rolls back shared trust. See [checkpoints](../../docs/decisions/run-checkpoints-2026-10-08.md).

## Intentional choices and rejected shortcuts

- Host template baselines preserve learned suffixes; unknown replacements stay intact. Prompt amendments use transactional CAS/history/receipts and reset streaks. [Contract](../../docs/decisions/prompt-consolidation-2026-10-12.md).

- Registry rollback is roll-forward-to-old-content and resets the trust streak.

- The bootstrap template refresh through `createOrRefresh`: refused
  (2026-10-26). It refreshes the family ELDER, so a younger type of one
  signature is never refreshed and the elder is patched once per sibling;
  and it re-adds the caller's tools, stale declarations included.
