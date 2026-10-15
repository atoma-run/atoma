# Text delivery through the full project runner

Production revision: `958d4219c4f474e2c94175cefffa43bb610dcc2c`.
These are diagnostic runs, not a comparative benchmark. Both completed without
operator cancellation; earlier cancelled attempts are not terminal-outcome evidence.

| Run | Elapsed | Observed outcome |
| --- | --- | --- |
| `c8c67a68-91ca-4205-ab71-6c9c90460333` | 1658.852 s | Root refusal after one remediation; final audit invented resources. Coordinator then failed on empty inventory. |
| `36606853-fde0-444e-b4a1-6122857d1c4c` | 588.476 s | Correct final arithmetic accepted after remediation; coordinator failed because no publishable file existed. |

The MCP summary was paged through all 363 and 222 events respectively, and
both final metadata documents were read to the end. Jev selected Xylem in both.

## Mechanisms

The first plan omitted task durations and assignments from the child description.
Neither tier passed the original request; sequential phases passed only a summary.
The molecule searched for a source file instead of using the supplied facts. Root
remediation recovered the complete model, but a later audit invented R1/R2/R3 in
place of M1/M2. The root correctly refused it.

In the smaller problem, a correct text response received this mechanical coaching:
“No successful tool action was observed.” Event
`05099414-94ea-40b4-91be-2c5350201be2` records it. An earlier phase wrote
`timetable.md`, was restored, and the root refused that pass. The final corrected
answer was accepted (`a0dcf3ef-f2da-4395-b193-4d742f46c255`), but project
finalization required a nonempty file inventory and recorded failure.

## Correction and adversarial review

- Preserve one original task across L3/L2 delegation, including structured input
  and constraints. Child inputs cannot impersonate it. Keep phase scope separate.
  Validators receive facts separately from phase requirements; the root checklist
  stays scoped. Jev calibration replays the same separation from recorded prompts.
- Pass the preceding structured answer, bounded with an explicit truncation
  marker, alongside the summary; never silently treat a truncated answer as whole.
- Declare reasoning execution structurally in the existing planner call. Disable
  tools and executable skills on that task and all descendants, including fallback.
  A descendant asking for tools cannot widen the parent. Only this declared mode
  bypasses the observed-action gate. File builders still need witnessed actions.
- Declare text delivery independently: research can need tools and still deliver
  text. Preserve the result in its trace and atomically record its inventory, even
  when empty. Do not invent an answer file or publish an unchanged input repository.
- Keep semantic root acceptance. Text declaration grants no automatic approval;
  failed/cancelled trace checks, inventory path/size checks and refusal outcomes
  stay intact. Empty ordinary file delivery still fails. A partial answer remains
  partial instead of being rewritten as a host failure.
- Refuse manual publication of text deliveries too. Existing manifest hashes
  are stable because new fields are optional and never backfilled.

Regression coverage exercises actual L3→L2→L1 dispatch, direct and fallback LLM
requests, the runner declaration file, coordinator completion and publication
reservation, plus existing file-action and inventory regression suites. No paid
model call is needed for these tests. Live validation of the fix requires deployment.

## Production follow-up on revision 0b02fa7c

Deploy workflow `37011512311` installed `0b02fa7ccb836fbceedc7b39113cbe1a2098e8ec`
at 13:13:48 UTC. Its workflow head was the later translation commit `3466f1ac`;
the downloaded release receipt and all three run traces identify `0b02fa7c`.

| Run | Elapsed | LLM calls | Subscription-equivalent USD | Outcome |
| --- | --- | --- | --- | --- |
| `30f5e5df-f6ac-4e16-98cf-4a16f8fa5628` | 166.462 s | 15 | 0.0689 | Tiny scheduling regression delivered; bound 6. |
| `6e88f329-08c6-4de9-891d-3f0375a59140` | 179.299 s | 11 | 0.0692 | Full scheduling regression delivered; bound 8. |
| `763ca259-dffd-4946-89ab-18c9c75be7e2` | 269.832 s | 12 | 0.1435 | Phloem created; malformed replan terminated execution. |

The first two reused Xylem, invoked no elements, delivered text with an empty
inventory, and passed root acceptance without remediation. The second was seeded
from the first text delivery. These are individual regression observations, not
a controlled performance comparison: registry trust and other code changed.
The summary readers reached their ends (64, 56 and 47 events), and metadata was
read completely for each run.

The third project asked for exact Bayesian inference over three urns and an audit
of a with-replacement shortcut. Jev deferred the root choice; the router requested
a new tissue. Event `3350ee5c-c64b-4f6e-9683-a8196b13982f` records the platform
author using `sub:openai:gpt-5.6-sol`. Event
`4ebfaf5d-a81f-4c0b-891c-081879231305` records Phloem's creation. Its reusable
capability prompt decomposes probabilistic analyses and independent verification
across cells. Its first plan declared text delivery and four reasoning phases.

### Result coaching contaminated the next plan

In event `c39405c3-0422-43dd-a65d-fa9f2526911e`, Insulin returned correct
arithmetic as plain Markdown instead of the required result envelope. The
without-replacement evidence is 1/2, posterior (8/15, 16/45, 1/9), and predictive
probability 22/45. Replacement changes evidence to 5/12 and prediction to 133/270
while preserving the posterior. The mathematical answer was not the failure.

The non-JSON result gate injected coaching
(`97946741-cb78-4b9f-a7fd-a24f396d8e55`) demanding output/summary. Supervision
correctly restarted at planning, but that coaching and the reasoning system
prompt both demanded a result. Event `9c006c44-8a5c-4f05-9af0-80970b52f1b4`
therefore returned an output/summary envelope with a plan nested inside output.
The strict plan parser rejected it and the run failed.

The correction separates reasoning-plan guidance from execution guidance and
makes envelope coaching explicit about both phases. It changes no parser, gate
disposition, retry budget, or supervision sequence and adds no model call.
The regression drives real L2 delegation and L1 execution: a prose first answer
is rejected, the actual coaching reaches the next planning request, and a second
execution returns the accepted envelope with no tool access. Existing fallback
coverage still exercises tiers 1, 2 and 3. The successful scheduling runs above
do not validate this separate correction; its deployed rerun follows below.

## Deployed correction and audio experiment

Commit `bf349326822a2b9d7e41e40cd1b813cced70bc69` passed CI `37015770454`
(5,166 tests passed, 20 skipped) and deploy `37016314014`. Both following runs
record that exact release receipt. The CI suite also resolved four local
failures caused by copying Windows working-tree line endings into Linux; the
same four passed locally after exporting canonical Git bytes plus the patch.

| Run | Elapsed | LLM calls | Subscription-equivalent USD | Outcome |
| --- | --- | --- | --- | --- |
| `1f54627c-5901-4f46-b8ab-761748a9565e` | 221.099 s | 13 | 0.0754 | Bayesian analysis delivered as text; Phloem reused. |
| `102556e8-0e7e-40c5-9009-4841206e48a0` | 499.333 s | 9 | 0.1944 | Offline SOS WAV, generator, verifier and README delivered and published; Meristem reused. |

Jev selected Phloem directly on the rerun. Its three sequential reasoning phases
gave the correct exact tables and both predictions, used no elements, and passed
root acceptance `eb2a0bf4-c589-4fc6-861f-0f2ceed8a6b3` without remediation or
escalation. This rerun did not reproduce a malformed answer; the mocked regression
is the direct proof that malformed-result coaching reaches a valid replan.

The audio run tested artifact production outside web applications. Its positive
probe `968fcc45-d707-46ce-9900-1f12e78c9f84` exited 0; negative probe
`18ca7514-8d50-4b4b-b342-1b02003a41d1` exited 1 and reported a mismatch at PCM
sample 0. A direct `rm` was refused by the shell allowlist
(`528483b6-6a59-4218-8835-164948de7b51`); the molecule recovered using the
documented bash invocation, removed only its corrupted scratch copy, and a later
listing confirmed the scratch directory was empty. This recovered refusal remains
in the trace. The initial synchronous MCP call timed out at 300 seconds; status
readers confirmed the same server-side run continued, without restarting it.

Root acceptance `bbb5463a-f0fd-4b68-9c11-89e37b9c6691` approved the artifact.
The four published files are at commit
[`7334889bbe04e17f51b22afbdc2020b789c36d24`](https://github.com/mgtf/atoma-l3-morse-audio-20261002/tree/7334889bbe04e17f51b22afbdc2020b789c36d24).
An independent audit read the published WAV bytes, without executing the generated
scripts: the canonical 44-byte header and every signed PCM sample match the fixed
specification (8,000 Hz, 22,400 samples, 2.8 seconds, nine tones). Its SHA-256 is
`1bf1e3beec729807ce60b4869c5a68787e3376e957b7c5bde1d562a7c94cfad5`, identical
to the run inventory. Both complete metadata documents and all 60/73 summary
events were read through their ends.

The mender independently opened [PR #11](https://github.com/mgtf/atoma/pull/11)
for the Bayesian failure. It was not integrated: its diff applies planning-only
system guidance to execution too, and leaves execution guidance inside the
planning user prompt. The landed correction keeps both phases distinct and
tests the actual coaching/replan/execution sequence.

## Finite-state reasoning and reproducible archives on c72760f5

Deploy `37019152379` installed `c72760f51e3061d2842eb179d2001871178a7fef`.
The following diagnostic runs record that exact release receipt. They are not
a controlled benchmark. Complete metadata and all 93/90 summary events were read.

| Run | Elapsed | LLM calls | Subscription-equivalent USD | Independent assessment |
| --- | --- | --- | --- | --- |
| `d5ca365f-27d2-4a0c-8761-ac600aeadd7d` | 684.740 s | 25 | 0.2266 | Delivered text; final counts and counterexamples correct, explanation and attribution defects remain. |
| `a6989eb1-3c27-4aac-8888-1b8cfb0bb21c` | 948.775 s | 10 | 0.3082 | Published ZIP correct and reproducible; its verifier accepts two independently reproduced invalid inputs. |

### Cambium creation and an incorrect validator correction

The abstract interlock starts in `(A,B,pA,pB) = 0000`. Authorizing A requires
B=0 and sets pA=1; authorizing B symmetrically requires A=0. Opening a door
requires its permission, sets its open bit, and clears only its own permission.
Closing clears its open bit. Atomic transitions change no other bits, and
self-loops are allowed. An independent complete breadth-first traversal, computed
before launch, gives 15 reachable states: every four-bit state except 1111.
Requiring the opposite door to be closed when opening reduces this to 12 states.
The shortest original safety violation has four transitions:
`0000 -> 0010 -> 0011 -> 1001 -> 1100` (authorize A, authorize B, open A, open B).

The platform author used `sub:openai:gpt-5.6-sol`
(`6a6a181f-4aea-450a-b941-3c4c49e4e16e`) to create Cambium
(`77913d06-7453-457e-a840-e59bded0526c`), a reusable finite-state audit tissue.
It actually delegated three reasoning phases to two different cells, Protoplast
and Sclereid, with no element invocation. This demonstrates multi-cell L3 routing.

The first phases incorrectly counted 16 states. An independent audit corrected
the answer to 15, but root validator `049716ea-496a-458e-bf0c-673b855e7e80`
rejected it and demanded 13, excluding 1101 and 1110. Cell validator
`fbce7129-ce5d-4cb3-b6e3-c443f6da9d73` repeated that false correction.
The final molecule response `25ab021c-225a-40da-9af5-19a239a17ab1` resisted
the coaching with valid witnesses, for example:
`0000 -> 0010 -> 0011 -> 0110 -> 0111 -> 1101`.
Root acceptance `d4a9c1ad-eb8f-4d92-8803-097a566c386e` approved it.

The final required counts, shortest trace, corrected inductive invariant and
unfair liveness counterexample are correct. Nevertheless the final explanation
also says the already-open door's permission cannot remain set, contradicted by
its own 1101/1110 witnesses. The valid proof excludes 1111 because the last
opening clears its own permission and both authorization guards are then false;
the other permission may remain set. The answer also attributes a "requested
13-state enumeration" to the user, although that number came from validation.
The post-mortem analyst identifies wasteful false coaching, but repeats the false
attribution of the 13-state premise to the task and misses the explanatory error.
Thus the platform's delivered status is not an unqualified correctness result.

The mender opened [PR #12](https://github.com/mgtf/atoma/pull/12), adding prompt
guidance about recorded counterexamples overriding requested conclusions and two
prompt-text assertions. Its premise retains the same attribution error: 13 came
from a validator, not the request. It also excludes an unexecuted proposed trace
from recorded counterexamples, while this incident was tool-free mathematical
reasoning. That diff therefore does not establish a correction of the observed
failure. It was read as evidence and was not integrated during these experiments.

### Correct archive, incomplete verifier

Meristem reused Trichome in two sequential artifact phases. The five published
files are at
[`aa4c71e594956503c4103385595aefba7cccfbca`](https://github.com/mgtf/atoma-l3-archive-capsule-20261002/tree/aa4c71e594956503c4103385595aefba7cccfbca).
The ZIP contains exactly `README.txt` (18 bytes), `data/café.txt` (16 bytes), and
`data/empty.bin` (0 bytes), in that order. Independent byte inspection confirmed
the fixed payloads, uncompressed storage, 1980 timestamp, Unix creator and regular
0644 mode, empty extras/comments, CRCs and manifest SHA-256 digests. Two fresh
builds in isolated directories with different builder mtimes reproduce the
published bytes. Archive SHA-256:
`20a3e514ffee843ff29fbac5cca6bd2c65311ac211c3ac1232a8fd9dc730fce7`.

An initial UTF-8-flag check wrongly required that flag on ASCII names. Its actual
failure (`b28ae8b6-f4c2-4466-b9b1-1045daf17d1b`) was recovered before delivery.
Both phases then ran positive and payload-corruption negative probes. The second
negative test (`3c69cfae-fa1d-488b-a185-519f4a7f8939`) temporarily overwrote the
main archive before restoring it; it completed successfully, but did not isolate
the correct artifact throughout testing. Root acceptance
`a689b5c9-9b44-4380-a64b-f67c9834aad5` approved delivery.

An independent nine-case verifier audit found two false positives:

- Replacing the empty entry's integer size 0 with JSON `false` exits 0, because
  ordinary Python equality considers `False == 0`; the verifier lacks type checks.
- Changing only the first local-file header's DOS time at byte offset 10 from
  0 to 1 (two seconds), leaving the central directory unchanged, also exits 0.
  The verifier checks central metadata but never validates the local timestamp.

The valid archive passes; stored-payload corruption, a wrong manifest digest,
malformed ZIP, and extra/missing/duplicate entries are refused. All nine cases
were executed on isolated owned copies after reading the generated scripts.
Seven outcomes match the expected contract. The artifact itself is correct;
the verifier is insufficient. A seeded maintenance run was requested with these
two exact counterexamples and byte-preservation requirements. Its first request
received 409 because the mender held the global slot; no competing run was started.

### Seeded archive maintenance

Run `822bb4fe-6e14-4bc1-9348-4842691bc440` started after the mender released the
slot, seeded from `a6989eb1`. Jev reused Meristem and injected the archive-building
skill, although this task explicitly forbade rebuilding the archive. The protected
files remained unchanged through the correction. New verifier code initially
invented `ZipInfo.data_offset` (actual `AttributeError` in
`79d8bdd7-6330-485b-919a-c5523f2a3baf`) and used DOS date 0 instead of 0x21,
rejecting the valid archive (`717fd879-00b0-4c9f-85c3-9db448939744`). Both were
corrected before the passing probe `8c47cc72-9023-4661-b28a-99ba2f794cc9`.

The first Boolean-size negative probe ran a stale verifier copy and failed on
the unrelated date error. The worker refreshed its isolated verifier copies and
reran it: `4afd157e-9aea-412a-ab05-0a595ee303d1` now rejects the actual type error.
Local-time rejection `36f7c365-e9d3-4afa-8bcc-57d4b3f5faa3` and payload CRC
rejection `e6796da0-5a29-448b-bfef-e0396ff106c6` also return 1 for the intended
reasons. The first scratch mutation targeted byte 30 (a filename byte), then was
corrected to byte 40 (the first payload byte) before the recorded CRC test.
These recovered errors remain part of the experiment evidence.

The initial documentation phase read the recorded probes without replaying them.
Root acceptance `ed98ce48-04a6-49f0-a7ff-f78ba2b15e0a` nevertheless refused the
missing exact isolated-test commands. Remediation requested those commands in
README.md and their actual execution, preserving the already accepted verifier.

That remediation first recovered a failed exact-text edit, then a broken README
payload-mutation example: a double-escaped newline made `raw.index` raise
`ValueError` (`5682dc20-2878-4c1c-a9e6-ab07257b6558`). Corrected probe
`c8804480-3632-4f5c-8ebd-8d749689bce5` passed and superseded the broken durable
command without erasing its historical event.

The final verification phase selected the existing script skill
`recheck-recorded-command-probes`, injected through the L1-driven path. Three
invocations failed because the model did not pass the required JSON-encoded
argument (`a10084d1`, `71e5b1d0`, `fe1dda44` event prefixes). The source ABI and
injection prompt do specify JSON encoding; these failures alone do not establish
an incompatibility between the deterministic caller and script ABI.

The fourth invocation `b5527c8e-c4e3-462f-8a90-995c2a08c5d0` reached the script
and replayed every historical manifest command, not just this task's documented
isolated tests. The inherited manifest includes builders (entries 1, 3 and 6)
and two commands that temporarily corrupt and restore the main archive (4 and
7). The script executes all entries sequentially and reports only mismatches;
it reported mismatches at 10-12, the newer probes pointing at already-deleted
scratch copies. Thus replay also violated the explicit prohibition on rebuilding
or temporarily replacing the correct archive. Equal final hashes cannot prove
the requested non-mutation method. This is a scope error in skill selection and
replay, beyond the initial verifier defects and recovered argument-encoding errors.

The run ended **partial**, not published, after 1,829.631 seconds: 20 model calls,
USD 0.5480 subscription-equivalent, one root remediation, one dispatch fallback.
Its final acceptance `553e0803-c861-4d70-a653-3a86c8aca952` refused the unfinished
hash/cleanup phase and the leftover `_skill_recheck-recorded-command-probes.mjs`.
All 159 summary events and the 343,195-character final metadata were read.

The final inventory preserves all three protected hashes, but the replay above
means they were not untouched throughout the run. The corrected verifier and
README were recovered from complete `read_file` events, with byte hashes matching
the terminal inventory (`3863e125fa29bfdcad876fdaa1b0877759e0e5c85a4cd5e7423a9dd50b9b1c7e`
and `05210b211083ef382fc071576fca7889dd81f4366ebd94cfded514a26af975bf`). Combined
with the unchanged published inputs in isolated local copies, the same independent
nine-case audit now passes **9/9**. This proves the two verifier defects were fixed
in the partial artifact; it does not turn the failed maintenance into a delivery.

The post-mortem analyst also classifies this run as wasteful and identifies the
609-second uncredited script loop. It correctly distinguishes successful verifier
probes from an incomplete delivery. Its findings do not identify the inherited
builders and main-archive mutations performed inside the replay script, so its
diagnosis is narrower than the independent command-level audit above.

### Vector geometry outside web applications

Run `015988df-9c2a-4311-9229-fa219fc7969b` used a new unseeded project and the same
`c72760f5` release. It delivered in 711.855 seconds, with 16 model calls and
USD 0.2999 subscription-equivalent. Jev reused Meristem, which delegated two
sequential phases to Trichome: Ammonia built the files and Benzene documented them.
Two recipes were learned; neither was promoted to a script. All 103 summary
events and the 319,126-character final metadata were read.

Published files:
[`1c794300e68a6e432175ae2a825112cfb117dd09`](https://github.com/mgtf/atoma-l3-vector-plate-20261002/tree/1c794300e68a6e432175ae2a825112cfb117dd09).
Independent inspection confirms exactly the requested six SVG primitives, units,
positions and styles. An outer 100-by-60 rectangle loses four radius-3 holes and
a 36-by-8 capsule with straight length 28. The material area is `5776 - 52*pi`
(5612.637182013331 mm²), total cut perimeter `376 + 32*pi`
(476.5309649148734 mm), remaining centroid `(60,40)` and minimum clearance 7 mm.
The delivered numeric claims agree within 1e-6. The JSON's centroid explanation
imprecisely says every cutout is individually invariant under both reflections;
the correct statement is that the set of holes is invariant, as its separate
symmetry paragraph explains.

The first numeric area was wrong despite a correct symbolic formula. Real probe
`4efa8176-7770-46ed-a4f0-04644f50c30e` detected it, and the worker corrected it
before passing `f98ea6ca-87d2-404a-89ce-b109c1ba95e3`. The radius-4 copy was
refused by `8722896d-6959-4408-8140-2a2423da35fd` and removed. Documentation did
not replay these probes. Its first result JSON omitted `summary`
(`095bd34a-39ca-4745-bb45-db8ae68fe381`); phase-aware coaching
`ad2da2dc-00c3-44ce-887b-2c62ce6419fc` led to a valid plan
`f306611b-b6c0-470f-9762-e2cec74ffe8d` and successful subsequent execution.
This production observation directly exercises the earlier envelope-coaching
correction. Root acceptance `2b9483a0-2f8a-45e3-80b3-7319447b16b3` approved.
The post-mortem analyst also notes duplicated README discovery, reads and edits
during that recovery. Successful envelope recovery does not mean the repeated
execution is free or that a cheaper recovery policy has been established.

The independent twelve-case verifier audit nevertheless finds two false positives:

- Adding a seventh circle inside a new SVG group is accepted. The verifier
  counts only direct children of the SVG root, leaving nested geometry unchecked.
- Changing `geometry.json`'s `units` from `mm` to `cm` is accepted. That field is
  never checked, despite the required millimeter-based contract.

The valid files pass. Wrong hole/slot radii, transforms, stroke width, SVG units,
an extra path, wrong numeric area, nonfinite area and malformed JSON are refused.
Ten of twelve outcomes match the contract. The original artifact is correct;
its acceptance checker is incomplete, as with the initial archive experiment.

### Reproducing the independent audits

The scripts, byte-preserved input fixtures and observed JSON reports are retained
under [evidence-2026-10-02](evidence-2026-10-02/). The `zip` and `plate` fixtures
come from their exact published commits. `zip-repaired` comes from complete
production read-back events plus unchanged original inputs, all matched against
the terminal inventory hashes; it was never published. No production script or
store is modified by these local audits. They use Python standard library only
and execute inspected verifiers/builders on disposable copies.

From that evidence directory:

```sh
python3 audit_interlock.py
python3 audit_zip.py zip
python3 audit_zip.py zip-repaired
python3 audit_plate.py plate
```

The interlock oracle prints an exhaustive reachability report. Each file audit
writes `independent-audit.json` inside its fixture directory. The
audit process records expected and observed outcomes; it does not turn a known
verifier false positive into a passing product test. The saved reports are
`zip-original-audit.json`, `zip-repaired-audit.json`, and `plate-audit.json`.
This series contains four terminal runs: three platform deliveries and one partial
maintenance, with no operator cancellation. Platform status and independent
correctness assessments are intentionally reported separately.
