---
name: supervisor-replay-exception
description: "Owner decision 2026-10-01: at root acceptance the SUPERVISOR replays inherited web smokes of modified STATIC pages (same isolated browser as validate_html, no LLM); failures go to the root validator, which decides — a documented exception to 'supervisors never replay model-authored scripts'"
metadata:
  type: project
---

Decided 2026-10-01 ("Exception web statique"), after the b9dc4d0b regression: the "Long break"
label that an earlier run required became "Mode: Long Break". The inherited `.atoma-probes.json`
smoke asserting it was never replayed. Earlier (2026-09-30) the user had chosen "Rejouer à
l'acceptation" and "no automatic refusal: the root validator decides, since a change may be
wanted".

**Scope:**
- inherited web entries only;
- only for files this run modified;
- only static pages;
- replayed by the host in the validate_html sandboxed browser: no shell, network limited to the
  static server, no LLM call.

It is an EXCEPTION to the invariant "Tool content and scripts remain untrusted; supervisors never
replay them". Document it where the invariant lives: root AGENTS.md architecture invariants,
src/atoms and src/tools intentional choices.

**Why the molecule does not replay them:** one ~20 s model turn per smoke, and the pomodoro
workspace already holds 53 KB of probes.

**How to apply:** design against every incident so far, then run an adversarial review, then land
it. Failures are shown to the root acceptor and never refuse the run by themselves.

Related: [[read-only-phases]], [[reader-facing-docs]].

**Design review 2026-10-01 (verdict: keep the policy, rethink the mechanism).** v1 design (docs/decisions/inherited-checks-replay-2026-10-01.md, untracked) staged the seed into .atoma-scratch at acceptance — REJECTED:
- host writes into a container-writable tree (symlink race);
- `ok` judges the page (console errors, fonts) and not the smoke;
- cdc34023 itself would have listed dozens of checks for a rebuild the task asked for.

Adopted instead: a RUN-START BASELINE.
- After seeding and before the first molecule tool call (an executor gate awaits it), replay the inherited checks on the untouched workspace. The replay runs twice, and only checks that are stable-passing are kept.
- At acceptance, replay only those. A check is listed only if it fails twice.

Also required:
- a host-only validate_html mode, with the flag stripped from molecule calls: fresh browser context per call, no stuck tracker, same-origin request interception, and `smokeOk` plus executed interactions returned;
- paths normalized to regular files and schemes refused;
- a cap on each call (~10 s) plus the deadline reserve; skip when gates.rejection is set; one static server;
- listed checks grouped by cause (value changed / element or hook missing / page gone), at most 5 per group, collapsed when STARTING WORKSPACE says REWRITTEN; values quoted as data;
- an "inherited" judgement output: an approval that contradicts it is refused, like consistentWithCriteria does;
- listed checks carried into the remediation inputs.

The first data point in the real project: most entries target old hooks (__timer, #longBreak, 900/1500/2700).

**State 2026-10-01 (late):**
- The implementation of design v2 is in the working tree, UNCOMMITTED:
  - src/contracts/inheritedChecks.ts and src/run/inheritedChecks.ts;
  - the hostReplay mode in builtin.ts;
  - modelFacingExecutor in core/attestation.ts, plus runTools in runner.ts;
  - rootAcceptance, json/verdict, depthRouting, depth.ts remediation, descriptor.ts probeEntryKind;
  - the docs, and tests/inherited-checks{,-browser,-runner}.test.ts.
- An implementation review returned 12 findings, all fixed.
  - Abandoned calls now continue (stop at 3), with a warm-up call and a slowestCheckMs skip.
  - The page guard blocks service workers, WebSocket, WebTransport and workers.
  - The tool returns smokeThrew and httpStatus.
  - value-changed checks are never collapsed; remediation gets asked===false items only.
  - The baseline is recorded in AcceptanceInfo.
- The round-2 review is pending.
- The runner test passes in WSL: the gate holds and the root prompt gets the block.
- Gotcha: the WSL /tmp does not persist between wsl.exe calls. The scripts live in ~/.cache/wsl-{sync,tests,full}.sh. Git Bash heredocs strip backslashes; use the Write tool and python files.

**SHIPPED a697acaa (2026-10-01).** It came out of 2 design reviews and 2 implementation reviews. Changes in the round-2 fixes:
- The page-level API guard was replaced by a per-context DEAD PROXY (127.0.0.1:9), with a bypass for the page host only.
- A failure beside a blocked request is ignored only if that URL was not blocked at the start.
- The baseline respects the run deadline.
- AcceptanceInfo records the baseline even when compare is skipped (notCompared).
Known follow-ups:
- a container-boundary test (the worker uses Debian chromium);
- pruning of stale manifest entries;
- doc phases matching build recipes.
The first production run is being verified by an agent (pomodoro L shortcut).

**Verified in production: run 41711050 (2026-10-01), worker container, Debian chromium.**
- At start: 40 checks selected, 27 tried within the 60 s budget, 17 kept (45 calls, about 1.36 s each). The replay overlapped planning; the first molecule tool call came about 9 s after the baseline line.
- At acceptance: the 17 checks were replayed and all still passed; nothing was listed; no proxy or chromium errors.
- f6399103 added `selected` to the record and made the log line read "K of T tried … (S selected)".
- Watch: the baseline budget gets spent on stale entries. Pruning them is a follow-up.

**CLOSED 7259e099 (2026-10-01): the three follow-ups, after an adversarial review ("ship after named fixes").**
- Dead checks. A check is DEAD only when both start replays lost a hook (an in-page throw, never "smoke evaluation threw") or an element ("selector … not found / matched no element"), with no blocked request and no page error. Never dead: a value-changed check, a 404, a crashed renderer.
  - The first time, its entries are marked deadSince/deadReason/deadCheck. deadCheck is a digest of the check key, so a mark copied onto another check is ignored. A key counts as marked only if ALL its copies carry the mark.
  - Dead again in a later run, it is removed, but only beside a check of the SAME page that passed twice.
  - Passing, every mark on its entries is removed.
  - A seed from a landed run (PREVIOUS_LANDING_ENV) marks nothing.
  - The write is temp + rename before the gate opens. A deepening re-applies the marks through runtime.reseeded().
  - This is the manifest's one stamp; the exception is recorded in src/contracts/AGENTS.md.
- The prefilter says a recipe that BUILDS (writes or rewrites its code) does not fit a doc-only or verify-only task. Gap: Decision's own recipe picks are not covered.
- File scribe step 1: write_file for a NEW file, edit_file for an existing one, record_probe for the manifest. This resets canonical Ammonia's trust once.
- Container arm in CI's Docker job, with a positive control: a molecule-mode WebSocket reaches the port, while host mode is refused.
- Not pruned: value-changed stale checks, entries whose file is gone, and marked checks once 40 or more live ones exist.
- Next: run a production run and check "N marked dead" in the log and the manifest marks.

**Prod check 0b51e494 (2026-10-01): LANDED partial, which was correct.**
- The web molecule added `button` to the keyboard guard. The L2 trust fast path let that through. The replay listed 2 regressions twice, and the acceptor refused twice.
- No dead marks: the 20 newest checks, all live, used up the 60 s; the dead ones sit older in the manifest.
- Remediation failed because stepsOf dropped the Space key ("click #start, keypress, keypress r").
- The merge keyed web entries by file+smoke, so an S check overwrote a Space check.

**3c9486c4 (round 2, after review) fixes:**
- stepsOf: " → " joins, named keys, capped values.
- One web identity in NEW src/contracts/webCheck.ts: parseInteractions, caps and defaults moved out of builtin, which re-exports them. webEntryIdentity is used by both the merge and the replay index.
- Start replay extends while nothing waits (tool call through the gate, restart, baseline()/compare()), up to 150 s. The new stop reason is `cap`.
- acceptanceWallMs is 90 s.
- The taught web manifest line changed, so the canonical web molecule's trust resets once.

**CLI run dadeea78:** delivered for $0.03. The README was edited in place by Ammonia v6, and the build recipe was not picked. But the combined example's output was never executed: recipe `document-verified-shortcut` step 4 says "do not rerun", and the L2 validator accepted it.

**Open ideas, not built:**
- Distilled recipes with a `write_file` step for an existing file: `patch-verified-static-ui`, `build-text-frequency-cli`.
- Doc example output must come from a real run; the validator/checklist does not require it.
- A 75 KB manifest read back by molecules: write_file's manifest result shows only the merged bytes.
- Coverage of older checks.
- A landed run's listed checks are not carried forward.

**INCIDENT 5dff35b0 (2026-10-01): a regressed page was delivered and PUBLISHED.**
- Phase 2 rewrote the pomodoro page whole, following recipe serve-and-validate-static-page (model-matched), on the trust fast path.
- Acceptance 1 listed the rewrite (29 checks); the acceptor judged it asked:false and refused.
- The remediation left ~90 s. The acceptance-2 replay ran 0 checks (deadline) and the block rendered EMPTY, so the acceptor approved.

**Fixes:**
- edf54cb0: RECIPE_STEP_LIMITS in llm and event recipe blocks plus the adherence check. An existing file is changed with edit_file unless the subtask says to discard it or put an earlier version back; "do not rerun" never covers a new example.
- edf54cb0: example outputs are copied from tool results (READER_FACING_DOC_GUIDANCE).
- edf54cb0: write_file of a manifest returns `merged{sent,total,note}`.
- 5f5535d7, FAIL CLOSED: depth.ts passes `previousAcceptance`. Unless the replay re-ran every kept check, an approval after a remediation is refused (landed too) when items were listed and not judged asked. Earlier items are shown as p1…; any asked:false for an id stands.
- 5f5535d7: a short replay says so and forces review.
- Restoration run of the pomodoro page launched 2026-10-01 ~05:45 (key loop-20261001-pomodoro-restore-after-5dff35b0-deep). It is expected to mark the old page's checks dead.

**Run 495c20ef (restoration, 2026-10-01): landed, refused twice, nothing published.**
- The start replay ran 109 s, tried 40/40, kept 16 and marked 22 dead. The net held.
- The acceptor read `asked` backwards and misread failed `checks` (a test-hook API difference) as broken behaviour.

**c2ed5921 (round 4):**
- EXISTING_FILE_RULE: one runtime rule for files that exist, in L1/L2/L3 fallback and the recipe limits.
- The value-changed detail names the failed `checks` first; falseBooleanFields moved to contracts/webCheck.
- The judgement rewording was REJECTED by an offline luna replay of the recorded prompts (scratchpad inherited-exp/): on 495c20ef, 74% vs 95% of items correct; 5dff35b0 refused under both wordings.

**Open (owner-level):**
- The acceptor judges "is this behaviour required", not the change.
- Hook-bound checks (window.__test) cannot survive a rewrite.

**Next:** a fix run on the pomodoro page (scratchpad fix-goal.txt) to deliver it.

**c195ba35 (2026-10-01, on c2ed5921): DELIVERED and published (main 0103f769). The pomodoro project is repaired.**
- Three edit_file calls; no rewrite and no manifest read-back.
- One listed check judged asked:true, approved on the first try.
- Session commits: 7259e099, 562bc99a, 8823cdd8 (hono), 3c9486c4, edf54cb0, 5f5535d7, c2ed5921, 6a16786e.

**Prompt repair APPLIED by the user, 2026-10-01 08:28** (scripts/repair-atom-prompts.mjs --apply; archive in /home/atoma/state/.registry-archive/).
- All 17 tier-1/2 types were patched, canonical ones included. Their trust streaks reset to 0; historical totals are kept.
- Serotonin v2 now says "edit_file what changes" and "no whole-file rewrite".
- On the host, mgf has SSH but NO sudo, and atoma.db is 0600 atoma. Operations on the store go through the user.
