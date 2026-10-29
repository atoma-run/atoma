# Attica hosted control restored — 2026-10-29

Owner explicitly requested direct inspection without an Atoma run, then repair
of the unusable hosted application. No Atoma run, real collection, CAPTCHA
verification, acceptance or publication receipt was fabricated or invoked.
Production MCP identified project07864f7c-d8f2-4023-9fca-afd8a7a51e52; no hosting
diagnostic MCP capability exists, so read-only SSH and the actual Chrome tab were
used. Hosting was already deployed from accepted run5ff2e4df, not the two newer
autonomy deliveries. This is an owner-authorized emergency runtime repair.

## Confirmed cause and retained state

Deploymentda008eae-e5b0-4562-9071-5f84de8c83c6, appcontainere04d66589a93,
basepublishedcommit3a003a7d7728678ae83cb1e0d357479b9208fb7e. Docker events showed
repeated oom/die137/start; kernel confirmed a 1.5GiB memory-cgroup OOM killing
gvisor_sentry. Nineteen restarts were observed before repair. UI consequently
showed lost connection, zero rows and disabled actions. Actual durable store has
1,010 listings; checkpoint has680rows and page20. CSV/JSONL exports exist.
Schedule history13,555,449B embeds complete collection results; the one-second
poll returned that history twice and full raw listing payloads. The source also
allowed polling/retry overlap and rebuilt all listing cards each second.

## Fixes and evidence

Private application repo https://github.com/mgtf/atoma-attica-property-flipping
mainandcodex/usable-control-20261029 nowexactly5c7a94882e3a1085723ff39b83ce5fe440912112.
Isolated clone/tmp/attica-usable-20261029, pinnedNode24.20.0; no existing checkout
or active agent was modified. Two own commits:

- 4e66dfb144a75461fcdd55642b9458e4e0f8acb3: presentation-only status/schedule
  projection; complete raw rows remain in store, listing API and exports;
  background poll coalescing retains fresh manual refresh and ordering fences;
  periodic retry deduplication; unchanged listing DOM retained; lost-state search
  guard. All old hashed assets retained and new compiled imports/assets tracked.
- 5c7a94882e3a1085723ff39b83ce5fe440912112: hydrate configuration from saved
  schedule while preserving unsaved input across polls; reflect saved result.
  This fixes the misleading unchecked checkbox despite enabled=true on server.

Baseline regression on the actual old COMPILED server via CommonJS wrapper:
1,010rows with retained full history produced65,700,201B and failed<500,000B.
Fixed real HTTP regression passes, verifies all1,010 projected rows, full raw
listing API, exact export bytes, concurrent reads and durable-file hashes.
New polling regressions verify single flight and no doubled queued retry.
Complete npm run check passed finally:124Vitest+3boundary+89Node, typecheck,
lintandbuild. Real Chrome suite32/32passed, including schedule hydration,
draft preservation and fixture-only save. First Chrome attempt exposed doubled
retry diagnostics; fixed and retained its failed log. No assertion weakened.
Root checks ran without browser/node_modules. npmci retained its existing
4dependency-advisory notice; lockfile unchanged, unrelated upgrades not attempted.
Application repo has no CI run for these commits (gh run list returned[]).

## Actual production intervention

Hosted application metadata STILL identifies accepted base3a003a7d/run5ff2e4df.
Historical accepted workspace/manifests/receipts and project accepted reference
were NOT modified. Emergency runtime override is explicit and independently
recorded in the deployed copy's OPERATOR-HOTFIX.json and server operator-repairs;
never report this as a new Atoma-delivered/accepted/published run. A later normal
hosting update from an old delivery would replace this repair; preserve the
operator receipt and include these application commits in the next source base.

Hostroot/home/atoma/hosting/d28f40d2-14d7-45c7-bce3-928dcb0041a6/07864f7c-d8f2-4023-9fca-afd8a7a51e52.
operator-repairs/control-4e66dfb-20261029 retains original-release,
stopped-release, data-before.tar.gz, beforehashes, preparedandactivated receipts.
Only Attica app was stopped/started once; Docker daemon, platform services,
relay, proxy, other runs/agents, images and browser profile were not changed.
All15candidate file hashes checked against deployed base and published fix;
automatic source rollback was prepared but not needed. Activated07:58:39Z.
Second frontend-only repair08:05:35Z used atomic files/assets-before-HTML,
no restart; operator-repairs/control-5c7a948-20261029 keeps beforefiles and receipt.

All listings, checkpoint, schedule, CSVandJSONL hashes identical before/after.
attica-state.json differs only startupupdatedAt after first restart, verified
semantically; all six files byte-identical across secondfrontendpatch. Initial
optional local data export was refused during the read-only inspection; none
was exported. The repair instead made its backup on the production host.

Native Chrome actual hosted UI:1,010announcements, real search0e364b84=>1/1010,
history restored, startandSaveScheduleenabled. Verified saved enabledcheckbox1,
09:00,Europe/Athens without any production mutation POST. APIstatus200,
379393B~0.1s; schedule200,1441B~0.005s. Memory stable518–528MiB/1.5GiB over
multiple minutes, zero additional restarts after07:58:24.943Z. No new OOM.

Local scripts/packages/logs in/tmp/attica-*usable* and/tmp/attica-*fix*;
copy code-only repair evidence into this chat's durable visualization directory.
Autonomy heartbeat remains paused; this repair did not resume it.
