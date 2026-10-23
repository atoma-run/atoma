# Why runs replan and revalidate: diagnosis and reviewed plan, 2026-10-23

Produced from runs 1622e44b-8d9f-41dc-8827-a1af7cb38353 and b920faf6-7bd7-4e89-87f8-7176c1c97f92 (production traces read through the MCP), the twenty commits of 2026-10-16..22, and the recorded decisions. Nine readers, three diagnoses, four designs, three judges and four adversarial refuters; every figure below survived the refutation pass or is marked as a prediction.

## Measured wall-clock attribution

| role | 1622 (66 min) | b920 (first 69 of 88 min) |
|---|---|---|
| L1 execute | 28% | 42% |
| L3 plan | 24% | 9% |
| L2 plan | 18% | 15% |
| L3 validate-plan | 9% | 10% |
| idle | 2% | 3% |

First L1 tool call: minute 37 of 66 (1622), minute 31 of 88 (b920). gpt-6-astra + gpt-5.6-terra: 80% of dollars, every call with cacheReadInputTokens 0.

Written 2026-10-23 for an engineer implementing today. Every file:line below was re-read on the current `main` (fafed13e). Numbers come from `timeline.py` on the local summaries and from the verdict bodies the refuters fetched; where a figure rests on the b920 tail (events 1400–1628, not in the local file) it is marked **(tail)** and must be re-derived with `timeline.py` on the full trace before the pre-registration is signed.

## 1. Theory of the waste

A 20-minute repair ("fix two lint errors, prove it by running the matrix") becomes a 66-minute cancelled run ($8.08) or an 88-minute interrupted run ($9.68) because every decision point in the deep topology is a **refusal by a judge paid at the top of the price ladder, after which the refused input is thrown away and regenerated from scratch**, and the run keeps going until it hits a configured cap rather than a wall-clock or a no-progress signal. On 1622e44b the root admission alone was 19.1→37.2 min (18.1 min, $4.19 = 52% of the run's dollars, zero tool calls): five astra plans of 118/167/167/173/263 s ($0.40–0.90 each, 25–47k uncached input tokens, 2.9–8.5k output at ~32 tok/s) each discarded by one terra refusal of 22–44 s that surfaced one new objection per round (coverage → second build → mock traversal → size → approve on attempt 5/5), the fourth of which (009f114d) was a size-only objection the host could have stated for zero tokens in round 1. The approved plan then met the same primitive one tier down: the SieveElement cell's plans were reviewed with no memory of the previous refusal (`L3Atom.ts:1846` passes no `previousRefusals`), reworded refusals never tripped the verbatim repeat tracker, and the 4-plan cap converted the stall into `recordFailure` and a tissue running 65 tool calls itself (b920: 8 plans 656 s + 8 reviews 442 s, no L1 execution from 15.7 to 31.1 min). When L1 finally executed, result refusals for evidence that could not change (vitest exit 126 in a restored read-only phase; a stack trace no server retains) re-entered at plan() up to 6–8 times per task. First real work started at minute 37 of 66 and 31 of 88. Across both runs astra+terra took 80% of dollars and 38–57% of wall clock while producing no tool work, and every one of those calls ran with `cacheReadInputTokens 0` on the own:openai route. The 20 patches since 2026-10-16 all added context or rounds to this machine; none reduced the count of refusals or the price of a refusal.

## 2. Root causes, ranked

| # | Cause | Where | Share |
|---|---|---|---|
| 1 | **Root admission loop**: one defect per review round, each refusal discards the plan (`pending = undefined`, `L3Atom.ts:749`) for a full astra regeneration; bounded only by `ROOT_PLAN_ATTEMPTS=5` (`:407`); the 8,000-char soft target is prose-only (`verdict.ts:38`) while the host checks only 12,000 (`json.ts:583-593`) | `L3Atom.ts:665-751`, `delegationReview.ts:20-34,58-63` | 1622: 18.1 min (27%), $4.19. b920: 7.4 min (11%) + a second 5.3-min cycle at 70–75 min **(tail)** |
| 2 | **Cell plan-only ladder**: cell plans with suites reviewed blind (`L3Atom.ts:1846`: `{ plan, allowDiscovery:false, hostFacts }`, no history); only approvals memoised (`:1864`); `MAX_SAME_REASON_REJECTS` is verbatim (`supervisor.ts:97`); 4-plan cap → `recordFailure` ×2 → tier-3 fallback with tools (`L3Atom.ts:1694,1726`) | `L3Atom.ts:1791-1865`, `supervisor.ts:314-319,529-557` | b920: 9.8 min ladder + 2.6 min fallback wall (15.7→27.9) + Trichome ladder ≈5 min **(tail)**. 1622: 11.2 min (45.1→56.3, fallback inside). 7 `recordFailure:SieveElement` across both |
| 3 | **Result retries whose judged input cannot change** (exit 126 on a restored tree, unrecoverable stack, already-approved clean-copy build); no digest-keyed verdict, Jev excluded under parent suites (0/44), AttemptDigest grants no credit; L3 re-judges L2-approved N=1 results and overturned 5/9 | `supervisor.ts:420-481`, `L2Atom.ts:2651-2654,2745-2748`, `attemptDigest.ts:135` | b920: 15–26 min (22–38%). 1622: 10–17 min. Dollars small (luna) |
| 4 | **Price/latency multiplier**: astra $10/$50, terra $2/$12, luna $0.2/$1.2 per M; every plan-review and root-plan call shows `cacheReadInputTokens 0`; a root cycle costs 2.7–5.0 min and $0.51–1.06 | `modelCatalog.json:223,275,288`, `llmCodexCli.ts:225-262` | Multiplier of causes 1–2, not additive; astra+terra = 80% of $ |
| 5 | **Review-as-refusal is the wrong primitive for a narrow repair**: 0 of 20 refusals read concerned the product change; all were suite-sufficiency/shape/size demands under the parent-owned-tests contract | `delegationReview.ts:20-37,149-179`, `parentTests.ts:221-240` | Cross-cutting; why causes 1–2 exist |
| 6 | **Duplicate judgement of unchanged inputs**: post-approval fan-out refusal (`delegationReview.ts:177`), L3 re-validation of L2-approved results, c7 audit re-dispatched ×4, prefilter LLM calls (13 × up to 83 s on 1622) | `delegationReview.ts:176-179`, `L3Atom.ts:1902-2040` | b920: 8–9 min (12–13%). 1622: 3–5 min |

Provider contention is a measured modifier on b920, not a cause: cell reviews beside parallel lanes ran at 4–7 tok/s (fc07d731: 690 tokens in 101.8 s; 65a58685: 797 tokens in 171.8 s) against 125 tok/s uncontended (0c45bc82). Every prediction below is stated at both rates.

## 3. Mechanisms

Flag: `ATOMA_REVIEW_REPAIR` (unset/0 = today's behaviour). M3, M4, M5 are behind it. M1, M2, M6s, M7, M8r, M9, M10 land unconditionally because they are zero-token, behaviour-preserving, or counters.

Layering rule for every mechanism (refuter 4): `planDeltaSchema`, `applyPlanDeltas` and an exported `withinAuthoredBounds` live in `src/atoms/json.ts` beside `planSchema`; `src/contracts/parentTests.ts` holds only the delta KIND vocabulary (`PLAN_DELTA_KINDS`). `planRepair` is parsed by a separate schema after `parseVerdict`, exactly as `parseDelegationReview` is (`verdict.ts:1157`). `TraceEntry.kind` (`core/types.ts:448-459`) gains `plan-repaired`, `repeat-rejection-candidate`, `judgement-digest`, `topology-shadow`; viz and analyst readers get one test each that an unknown kind is ignored.

### M2 — Suite size is a round-1 host fact (FIRST; see §4)

- **Change**: `src/atoms/parentSuiteCheck.ts:445-475` `planSuitePrecheck`: for each suite with `source.length > PARENT_TEST_SOURCE_TARGET_CHARS` (8,000, `contracts/parentTests.ts:65`) push `HOST FACT: acceptance suite ${label} is ${n.toLocaleString('en-US')} characters. The host ACCEPTS this suite (its refusal is at 12,000). The soft target is 8,000: if the branch's contract needs more, ask for the branch to be split, never for a shorter suite.` into `facts`. `src/atoms/verdict.ts:38`: keep the sentence, append `; the host states each suite's size as a fact and accepts any suite under 12,000 characters, so size alone is never a refusal`. Amend the G4 bullet in `src/atoms/AGENTS.md` ("Plan size (G4…)") in the same commit: the reviewer asks for a split; it does not refuse on size.
- **Invariant**: 12,000 hard bound in `parsePlanPair` untouched; `refusal` field untouched; a fact beside the judgement, no new gate.
- **Test**: `tests/parent-suite-check.test.ts`: a 9,412-char suite yields a fact containing `9,412 characters` and `ACCEPTS`, no refusal; 11,999 same; 12,001 still refused by `parsePlanPair` (existing test).
- **Gate** (answers refuter 3, obedience unmeasured): before merging, replay 009f114d's prompt with the new fact + sentence through the replay path in `memory/validator-prompt-replay.md`, 3 samples on gpt-5.6-terra: pass when ≥2/3 do not refuse on size. 3 replays, no run.
- **Effect**: 1622: 009f114d (22 s, $0.147) was size-only; without it round 4's plan f3dd1b84 stands → round 5 (ff14e184 263 s + 23537d0a 35 s, $0.90) does not occur: **−5.0 min, −$0.9**. b920: 0.

### M1 — Cell review hears its own refusals; byte-identical resubmission returns the memoised refusal

- **Change** (`src/atoms/L3Atom.ts`): add `private readonly cellReviewRefusals = new Map<string, string[]>()` keyed on `planner` (`:1826`). At `:1846` pass `previousRefusals: this.cellReviewRefusals.get(planner) ?? []`. Push condition corrected (refuter 4: `llmVerdict` at `verdict.ts:1174` stamps NO `delegationRefusal` on a model refusal): `if (!verdict.approved && verdict.delegationRefusal !== 'reviewer' && verdict.delegationRefusal !== 'fan-out') list.push(refusalWithRequests(verdict))` (`delegationReview.ts:69`). Memo at `:1864`: `if (reviewKey && (verdict.approved || (!verdict.approved && verdict.delegationRefusal !== 'reviewer')))` → store; on a memo HIT of a refusal, return a FRESH `delegationRefusal(stored.reasoning, 'plan')` (ephemeral scope), never the stored object (refuter 1: a `patch`/`branch`-scoped refusal would re-run `applyByScope` at `supervisor.ts:400`).
- **Cell-specific note** (refuter 1: root-only rule): the cell path gets `cellPreviousRefusalsNote(refusals)` in `delegationReview.ts` — same list, but its last sentence reads `Judge first whether this plan answers each. Every rule of this review still applies in full; this history narrows nothing.` The root's `previousRefusalsNote` and the AGENTS.md "root only" rule are unchanged.
- **Invariant**: same review model and caps; reviewer faults never memoised; a changed byte is a new key.
- **Test**: `tests/tissue-delegation.test.ts`: mocked reviewer refuses (model refusal, no stamp) → second `validatePlan` prompt contains the first refusal's text under the cell note; identical resubmission → mock NOT called, returned verdict is ephemeral `'plan'` refusal with the same reasoning; drive `superviseLoop` and assert `repeat-rejection {phase:'plan'}` after the third identical submission.
- **Effect**: booked at **0–1 min** (refuter 3: fc07d731→65a58685 narrowed, did not restate). Memo: 0–1 calls on these runs. Kept because it is correct and cheap.

### M3 — Planner replans by typed deltas on its retained refused plan (behind the flag)

- **Change**: `src/atoms/json.ts`: `planDeltaSchema` = discriminated union `suite.replace {target, requirement?, source}`, `suite.split {target, into:[{description, acceptanceTests, criteria?, dependsOn?}]}`, `dependsOn.set`, `aggregation.set`, `criteria.assign`, `obligation.add`; bounds ≤6 deltas, ≤2 suite-bearing, each `source ≤ PARENT_TEST_SOURCE_TARGET_CHARS`. `applyPlanDeltas(base, deltas): Plan` is pure, re-parses through `planSchema` + `withinAuthoredBounds`, throws `PlanParseError('schema')`. **It never alters or synthesises a suite `source` string**: `suite.replace` copies the model-emitted bytes verbatim; `suite.split.into` entries inherit `preferredChild`, `executionMode`, `outputs`, `criteria`, `proofObligations` from the target subtask (refuter 1, M5) and the result passes `preservePlanLiteralContracts` (`L2Atom.ts:716`). `parsePlanPair(:626)` accepts `{planDeltas:{base:<sha256>, deltas}}` only when the caller supplies `{ base: { digest, plan } }`; base mismatch is `PlanParseError('schema')`.
- **One channel** (refuters 1 and 4): the refused plan travels on a new optional 4th argument `Atom.plan(task, ctx, feedback, context?: { base?: { digest, plan } })`, defaulted on L1. Root: `reviewedRootPlan` keeps `lastRefused` at `:749` and passes it. Cell: captured in the refusal path (`supervisor.ts:368-404`, NOT at `:345`, which is the reset after a parsed plan) and passed by `superviseLoop` to `current.plan(...)`. `planFeedback` stays `string[]`.
- **Prompt**: the planner's feedback gains `PREVIOUS PLAN (digest d; suites shown as sha256 + first line + size)` rendered ≤6k chars + `reply with a whole plan OR planDeltas on base d`.
- **Invariant**: a delta reply becomes a full Plan by the same schema before precheck/facts/review; `STRATEGY_MAX_TOKENS`, `ROOT_PLAN_ATTEMPTS` untouched; feedback stays off the prefilter key. Revises the 2026-10-16 "no composed pair" rule for typed, digest-bound deltas only — stated in the commit.
- **Test**: `tests/plan-deltas.test.ts`: P1 refused → `planDeltas` → reviewed plan equals `applyPlanDeltas(P1, deltas)`; wrong base → `PlanParseError` feedback, one attempt spent; split entries carry the target's `preferredChild`; a 12,001-char suite refused; `applyPlanDeltas` output's suite sources are byte-equal to inputs. Update `tests/jev-calibration.test.ts` fixtures for the new block.
- **M0 gate**: planner replay arm (6 root refusals' feedback → astra, 2 samples): ≥75% parse as a whole plan or a valid delta; record astra outputTokens per round.
- **Effect**: booked **0–2 min on 1622** (the 263-s plan M3 would have shortened is removed by M2) and **1–2 min on b920** rounds 2–3. The 2.9–8.5k→1–3k output claim is measured in M0, not assumed.

### M4 — Repair-not-refuse at the root review, in two stages

**Stage A (behind `ATOMA_REVIEW_REPAIR`, this train): non-authoring repairs + exhaustive first-round refusal.**

- **Change**: `verdictSchema` positive branch gains `planRepair?: { deltas }` parsed separately, deltas restricted to `suite.split` (sources byte-reused), `dependsOn.set`, `aggregation.set`, `criteria.assign`, `obligation.add` — the reviewer writes NO `expect(` line. Negative branch gains `refusalKind?: 'replan-after'|'unexecutable-proof'|'missing-interface'|'coverage'|'empty'`. `DELEGATION_REVIEW_REQUEST` (`delegationReview.ts:34`): replace "For rejection use the ordinary negative Verdict" with: structural defects (fan-out, dependsOn, size→split, criteria binding, missing obligation) are REPAIRED in `planRepair`; a refusal names its `refusalKind` and **lists every blocking defect and every request in this one verdict; a later round refuses only for a listed defect that still stands or one the revision introduced**. `enforceDelegationReview (:118-128)`: `approved:false` without `refusalKind` → ordinary `delegationRefusal(reason,'plan')`, never a reviewer fault. `enforceParsedDelegationReview :176-179` fan-out: when the verdict carries a `dependsOn.set`/split repair that satisfies it, the fan-out refusal does not fire.
- **Loop** (`L3Atom.ts:681-751`): on `approved && planRepair`: `amendedTail = applyPlanDeltas(reviewed, deltas)` (indices mapped through `routingIndexNote`), **re-prefixed** `amended = { ...pending, subtasks: [...pending.subtasks.slice(0, args.from), ...amendedTail.subtasks] }` (refuters 1, 4); mechanical checks on it: `args.precheck?.(amended)` ONLY for `parallelDeclaredOutputCollision` (never `acceptL3RootPlan`'s coached replan, `l3RootPlan.ts:83-124`), `planSuitePrecheck`, `await planSuiteFactsBlock(amended)` with the rule **any suite import that does not resolve → repair refused**, `enforceParsedDelegationReview(amended, review, allowDiscovery)`. Success → trace `plan-repaired {deltas, from}` plus a second `plan` event `{repaired:true, payload: amended}`, return `{ plan: amended, review, model }` without spending an attempt. Mechanical failure → ordinary refusal path with host message + reviewer deltas. `rootApproval (:604)` digests the AMENDED plan; `recordedRootApproval (:613-622)` re-enforces it.
- **Invariant**: the executing plan is the one the reviewer approved after its own deltas and the mechanical half re-checked; `ROOT_PLAN_ATTEMPTS`, `PLAN_REVIEW_MAX_TOKENS=8000` (`cost.ts:286`), `ROOT_DELEGATION_REVIEW_PARAMS` untouched; no paid re-review, no votes; a non-authoring delta is ≤300 output tokens, so the measured 1.6–4.5k reasoning budgets stay under the cap (refuter 3).
- **Test**: `tests/delegation-contract.test.ts`: (a) approve + `dependsOn.set` repair → amended plan returned, `plan-repaired` + second `plan` event, 1 plan call + 1 review call; (b) delta whose split suite imports an unresolvable path → ordinary refusal, attempt 2 hears both; (c) `approved:false` without `refusalKind` → `'plan'` refusal, `reviewFaults` unchanged; (d) continuation `from=2`: amended plan keeps subtasks 0–1 byte-identical, `recordedRootApproval` accepts the amended digest on resume and rejects the unamended one; (e) a `suite.replace` delta in stage A is a schema error.
- **Effect**: b920 post-approval fan-out cycles (578351d9→266c2fc4→2d6cb70c→dbb0a134→58606fd8 and cdde2669→…→4092f1f9, ≈3.1 min each) → repaired in the approving review: **−3 to −6 min, 4 calls fewer**. 1622 root: the 3 residual coverage refusals (1f10bf81, bd2345bc, 15b70ed3) are NOT repaired in stage A; the exhaustive-listing rule is expected to merge rounds 1–3 into ≤2 rounds (**−2.5 to −5 min**, measured in M0 as rounds-to-approval), replans via M3.

**Stage B (reviewer-authored suites, `suite.replace` with new bytes): NOT in this train.** Requires (i) the owner decision in §7, (ii) M0's control arm passed, (iii) `planSuiteFactsBlock` on every amended suite with unresolved import = refusal, (iv) ONE suite-bearing delta per review, (v) output modelled against the 8,000 cap from M0's recorded reasoning tokens. Until then coverage refusals remain refusals that M3 makes cheaper.

### M5 — Same stage-A repair at the cell review

- **Change**: `L3Atom.ts:1832-1865`: on `planRepair`, `amended = applyPlanDeltas(plan, deltas)`, re-run `planSuitePrecheck` + `planSuiteFactsBlock` + `enforceParsedDelegationReview`, return `{ ...verdict, amendedPlan }`; memo under the ORIGINAL plan's `reviewKey` (refuter 4). `supervisor.ts:405-420`: `if (v1.amendedPlan) { plan = v1.amendedPlan; trace plan {repaired:true} + plan-repaired }` before `current.execute(task, plan, ctx)`. **No `acceptAmendedPlan`, no strategy rewrite** (refuters 1, 4: `L2Strategy` carries no subtask specs, `json.ts:1584-1592`); `L2Atom.execute` already dispatches from `plan.subtasks` (`:745-760`); add a guard that `pendingStrategy` is non-null at `:745` (throw, never silent `selfExecute`).
- **Invariant**: L2 plans under a parent suite still reviewed before any L1 executes; the plan that executes is the reviewed-and-amended one; `maxPlanIterations`, `plansWithoutExecution`, `blameless`, `MAX_PLAN_REVIEW_FAULTS` unchanged.
- **Test**: `tests/supervision.test.ts` production path `superviseLoop → L3.validatePlan → L2.execute` with mocked LLMs: `dependsOn.set` repair → the L1 task the mocked L2 dispatches carries the amended `dependsOn`; `viaFallback` false; `plan-repaired` precedes `execute`; memo hit on the original bytes returns the amended verdict without a call.
- **Effect**: stage-A deltas do not answer coverage refusals (the SieveElement ladder's class), so **0–2 min** booked here; the ladder shortening is M3's (cheaper replans) and stage B's. Predicted at 125 tok/s and at 5 tok/s: at 5 tok/s a 300-token repair adds ≤60 s per review, so M5 cannot be net negative in stage A (the refuter's 7–12 min figure applied to suite-authoring output).

### M6s — Digest-equal result repeat: SHADOW COUNTER ONLY (escalation dropped)

- **Change**: `supervisor.ts` beside `resultRepeat.push` (`:446`): compute `observationKey = sha256(subjectDigest ?? '', attestation records of this attempt (`ctx.attestations.forBranch(...).slice(since)`) mapped to `tool + normalised request identity + exitCode/status`, sorted, plus sha256(output, summary) for a record-less result)`. Never eventIds, never `workspaceDigest`, never payload witnesses (refuters 1, 2, 4). On a refused v2 whose key equals the previous refused attempt's, trace `repeat-rejection-candidate {phase:'result', observationKey}` and bump run stat `resultRepeatCandidates`. **No `EscalationSignal`**.
- **Invariant**: zero behaviour change; blameless semantics untouched; pre-registered threshold before any routing: ≥20 labelled candidates with ≥70% judged "the refusal could not have changed" (same protocol as `suite-dispute-2026-10-17`).
- **Test**: three executions with identical receipts (`vitest → 126`, same subjectDigest) refused under three wordings → 2 candidate events; a third execution with a new exit code → none; through `forkBranch` the counter is per supervise call.
- **Effect**: **0 min claimed**. On the plan's own evidence (Melatonin 10/0/4/4/6/7 run_shell, Methane 24/13/36) the key would rarely repeat; the counter tells us how often.

### M7 — `judgement-digest` shadow at the L3 N=1 passthrough

- **Change**: `L3Atom.ts validateResult (:1902-2040)`: `l2Approved := !result.phaseBudgetSpent && !isOwnFallback(result, child.name)` (refuter 4; no `result.verdict` exists); after the L3 verdict emit through `ctx.recordRunStat`-style hook `{site:'l3-passthrough', subjectKey: sha256(task.description, criteria, output, summary, sorted attestation identities), l2Approved, l3Approved, agree}`.
- **Invariant**: zero behaviour change; no fast path.
- **Test**: N=1 passthrough, mocked L2 approve + L3 refuse → one event, `agree:false`.
- **Effect**: 0 min; the 5/9 overturn dataset for a later decision.

### M8r — Tier-3 fallback: fix the self-plan contradiction, count by provenance, defer relocation

- **Change**: `L3Atom.ts selfPlan (:1638-1686)` and the fallback user text `:1699`: remove the contradiction ("You HAVE tool access" then "Do NOT call any tools" — fallback-plans 0c49855e/4eea7b1f, $0.98, produced "Blocked" plans). The plan turn says `plan only; the execute turn holds the tools`. Add run stat `toolEventsByTier`. **The relocation to the cell is deferred**: refuter 1 shows the lastResort route breaks `isOwnFallback`/`dependencyBlocker` (`dispatch.ts:55`) and the `unvalidated-fallback` gate; refuter 2 shows the tool-bearing fallback is a recorded exception (34cb57f0, `L3Atom.ts:1688-1693`); refuter 3 shows it saves 0 min. If relocated later: mandatory `lastResort` on tier-3 hooks, tissue provenance kept on the result, result routed through `parent.validateResult`, test that `dependencyBlocker` still returns `'unverified'`.
- **Test**: `tests/l3-fallback-tools.test.ts`: fallback-plan prompt contains no tool catalogue and no "HAVE tool access"; existing tool-bearing execute expectation unchanged.
- **Effect**: **0 min**; −$0.5 to −$1 per run on wasted "Blocked" fallback-plans. P8 baseline restated: 1622 = 49 tier-3 tool events, b920 = 65 (local) / ~94 **(tail)**.

### M9 — `topology-shadow` launch facts (purpose reworded)

- **Change**: `src/run/depth.ts:424-425`: emit `{kind:'topology-shadow', seeded: !!startingRepository, mode, checklistSource, checklistItems, httpItems}`; at root acceptance log the `startingComparison` changed-file count computed from `ctx.startingWorkspace` (`rootAcceptance.ts:152-156`) independently of `inheritedChecks`.
- **Purpose** (refuter 2: the family rule): data for whether the DEEP tissue's own plan should skip a decomposition step on a seeded repository — a tissue-side planning decision — not a third depth mode; `depthModeSchema` untouched.
- **Test**: seeded deep run emits the event with a changed-file count; unseeded `seeded:false`.
- **Effect**: 0 min.

### M10 — run_shell timeout: counter only

- **Change**: `attemptDigest.ts:88-140`: count kills matching `builtin.ts:1170`'s `timed out after` and whether the retry's commands passed `timeoutMs`; run stat `shellTimeouts {kills, retriedWithTimeout}`; render one line `- ${killed} command(s) were killed at their timeout.` (no second copy of the `timeoutMs` sentence; its one home stays `builtin.ts:995-997`).
- **Effect**: **0 min claimed**; the refuters are right that honouring `timeoutMs` makes those commands longer, not shorter. P10 is exploratory.

### M0 — Offline replay gate before M4/M5 default flips

- **Corpus**: the 18 refusals (1622 root 1f10bf81, bd2345bc, 15b70ed3, 009f114d; b920 root d05df0eb, 21acd663, 77dde32b **(tail)**; cells b0dc69d0, fc07d731, d82c6b4f, 65a58685, 9dc63a47, 9ceab52c, 13042946 + remaining SieveElement/Trichome reviews via `atoma_run_trace section=event`) **plus a control arm of ≥18 previously APPROVED plans and ≥6 synthetic plans with known blocking defects** (mock replacing the subject, trivial assertions, unresolvable import) (refuter 1).
- **Transport pre-registered**: Codex login path per `memory/validator-prompt-replay.md`, each sample its own thread; 3 samples per item; `outputTokens` and `stopReason` recorded per sample.
- **Pass**: ≥70% of refusal samples return approve, approve+repair, or a refusal with a `refusalKind` listing ≥2 defects when ≥2 existed; the 6 defective plans refused or repaired into a plan whose suites still import the real module in ≥5/6; approved-arm false-refusal ≤15%; reviewer faults ≤10%; no sample over 8,000 output tokens; rounds-to-approval simulated on 1622's chain ≤3.
- **Files**: `benchmark/review-repair-2026-10-23/{PREREGISTRATION.md,replay.mjs,results.csv}`. 54 + 72 replays, no run.

## 4. Implement FIRST: M2

M2 is the only mechanism whose saving rests on a verdict body rather than on predicted model behaviour: 009f114d refused solely on "exceeds the 8,000-character suite limit; split", the host accepts that suite (12,000 bound), and the round it caused cost 263 s + 35 s = 5.0 min and $0.90 on a 66-minute run. It is 15 lines in `planSuitePrecheck`, one appended clause in `verdict.ts:38`, one test, zero tokens, no new gate, no flag, reversible, and its one assumption (the reviewer reads the fact) is checked with three offline replays of 009f114d before merging. Ship it in the first commit, then M1 (corrected condition) and M8r's prompt fix, then the counters (M6s, M7, M9, M10), then M3/M4/M5 behind the flag, then M0.

Ship order: M2 → M1 → M8r → M10 → M9 → M7 → M6s → M3 → M4 (stage A) → M5 → M0 (offline) → flag default decision.

## 5. Pre-registered measurement and stop rule

Before launch, write `records/incidents/2026-10-xx-review-repair/PREREGISTRATION.md` with: run id, deployed SHA, `ATOMA_REVIEW_REPAIR=1`, `MAX_TOOL_EVIDENCE_CHARS=48000`, `JEV_EFFORT_HOLDOUT_RATE`, model pins (own:openai astra/terra/luna), 90-min profile, repoBase 8bd + owner fixes, same goal text as 1622e44b; started ONCE, never duplicated. Re-run `timeline.py` on the full b920 trace (1629 events) first and restate the baselines marked (tail).

| | 1622 baseline | b920 baseline (full) | Target |
|---|---|---|---|
| P1 minutes to first L1 tool event | 37.2 | 31.1 | ≤ 24 |
| P2 tier-3 `plan` calls | 6 | 7 (tail) | ≤ 3 before first branch, ≤ 5 total |
| P3 tier-3 `validate-plan` calls | 18 | ~27 (tail) | ≤ 12 |
| P4 `plan-repaired` events / share of reviews ending approve+repair | 0 | 0 | reported |
| P5 `recordFailure` on cells from plan-only ladders | 2 | 5 (local), 11 total (tail) | ≤ 2 |
| P6 astra+terra USD | $6.43 | $7.72 | ≤ $4.5 |
| P7 wall min L3 plan + L3 validate-plan + L2 plan | 33.4 | 23.7 (69-min window) | ≤ 20 |
| P8 tier-3 tool events | 49 | 65 / ~94 (tail) | reported by provenance |
| P9 `repeat-rejection-candidate` count; max executions per task | 0 / 6 | 0 / 8 | reported |
| P10 run_shell kills; retries carrying timeoutMs | — | 21–23 | reported |
| P11 provider tok/s per review (median, min) | 125 / 4 | 125 / 4 | reported |
| P12 rounds to root approval | 5 | 3 + 2 (tail) | ≤ 3 |

Honest expected effect (M2 + M3 + M4-A + M5 only; M6s/M7/M8r/M9/M10 at 0): **1622: −10 to −14 min (15–21%), −$1.8 to −$2.5**; **b920: −7 to −12 min uncontended (8–14%), −4 to −8 min at 5 tok/s**. Stage B would be needed to approach the 30% bar; its prediction is written only after M0.

Stop rules: **S1** root acceptance refuses a delivery for a suite-related reason attributable to a reviewer-amended plan → halt. **S2** `suiteDisputes > 0` on an amended suite → halt. **S3** P1 > 30 min or P7 > 24 min → flag default back to 0, write-up, M0 again on the new refusals. **S4** reviewer-fault rate > 10% live → `planRepair` restricted to one delta. **S5** any plan review with `planRepair` > 180 s → flag off for the next run. **S6** any `plan-repaired` plan refused by the mechanical half twice in one run → write-up before the next run. Thresholds move only with the write-up `README.md` showing the twelve numbers beside 1622 and b920.

## 6. What NOT to do

- No wall-clock cap on the root loop, no executing a refused plan, no auto-accept on exit 0, no per-phase result counters (2026-10-10).
- No `workspaceDigest` or attestation `eventId` in any repeat key (refused 2026-10-17; eventIds are fresh per observation, `attestation.ts:93`).
- No `EscalationSignal` from M6 until the labelled-unit threshold is met.
- No reviewer-authored `expect(` lines in this train (stage B needs its owner decision and M0's control arm).
- No raise of `PLAN_REVIEW_MAX_TOKENS`, `STRATEGY_MAX_TOKENS` or `ROOT_PLAN_ATTEMPTS`; no sampled votes or paid re-review.
- No relocation of the tier-3 tool fallback to the cell by rewriting `producedBy` (breaks `isOwnFallback`/`dependencyBlocker`; G3 false provenance).
- No `--depth direct` mode or launch-fact router (run-family rule, `src/run/AGENTS.md`).
- No second rendering of the `timeoutMs` sentence; no default timeout raise.
- No `acceptAmendedPlan` strategy rewrite (there is nothing to rewrite).
- No minutes booked for M6, M8, M10 in any total.
- No live run before M0's write-up; never duplicate a start.

## 7. Open owner decisions

1. **Reviewer-authored suites (stage B)**: amend `docs/decisions/parent-owned-tests-2026-10-16.md` to say who owns a reviewer-amended suite, how credit/blame attaches, and that `planSuiteFactsBlock` with an unresolved import refuses the repair. Without it stage B stays a measurement arm.
2. **Cell reviews reading their own refusals** (M1): the cell-specific note narrows nothing, so the AGENTS.md "root only" sentence is amended rather than contradicted; confirm.
3. **G4 amendment** (M2): size is a host fact; the reviewer asks for a split, never refuses on size.
4. **Typed deltas revise the 2026-10-16 "no composed pair" rule** for digest-bound, byte-preserving deltas only (M3).
5. **Prompt-cache on own:openai pins**: every astra/terra plan-review call shows `cacheReadInputTokens 0`; measuring whether the Codex transport can reuse a prefix (or whether reviews move to a cached route) is a separate train — the per-cycle multiplier of cause 4.
6. **Tier-3 fallback relocation** (M8 deferred): mandatory `lastResort` hook with tissue provenance kept, or leave the recorded exception as is.
7. **M6 routing threshold** and **judgement-digest fast path** (≥0.9 agreement): decided only after their shadow counts exist.