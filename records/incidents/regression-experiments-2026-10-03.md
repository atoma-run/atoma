# Production regression and cross-domain experiments — 2026-10-03

This follows [the diverse-delivery campaign](diverse-deliveries-2026-10-03.md). Runs were serial and used the platform-admin MCP. Numeric costs are recorded subscription accounting, not additional API invoices. Published files are archived byte-for-byte in `evidence-regressions-2026-10-03/`.

## Platform releases

- `fc65f6175a35bcc5829a98c33d17a647864bdbec`: dedicated skill-author role, bounded tool-free result serialization repair, scoped reasoning context, Python cache publication exclusion, removal of the encoded-alphabet injection false positive. Linux CI 37073609710 and deployment 37073969907 passed.
- `1c8c303641594eb4f0ed3940f1e32d879ca7115b`: Codex edit spans travel as once-encoded top-level fields, with strict conflict and declared-schema checks. Two live ledger runs exposed double-encoded spans and invalid arguments JSON. Linux CI 37076629412 and deployment 37076963932 passed. The music repair records this exact revision.

Focused tests, both TypeScript configurations, changed-file lint and documentation checks passed. Local release verification was blocked by ignored screenshot fixtures entering lint; the full Windows test suite also had platform/path failures. The clean Linux release jobs passed; local full-suite success is not claimed.

## Ledger repair and adversarial follow-up

Project `72fdfe6e-0481-4599-a73e-38307685322a`.

The first repair (`3b3efaf3-15c9-4977-9a64-796e4a4a37d4`, 731.9 seconds, 11 calls, $0.2613) corrected the four initial challenges. A new mutation confined to the actual ambiguous-movements section still passed incorrectly: a correct documentation example elsewhere masked the altered assertion. This justified a second repair rather than accepting the delivery banner.

The scoped repair (`947a21a2-e0b0-4b6d-b219-a83ef2c1747b`, 1241.009 seconds, 16 calls, $0.4854) passes nine published isolated cases, including section-local wrong, missing and duplicated t1 claims. Independent original enumeration and CSV checks also pass. Published revision: `5e15baf7465bbe7e45aa6ae49d273aeec1402a84`. The four downloaded files match their manifest hashes.

A root remediation needs precise interpretation: the real latest probe already passed, but the molecule's reported `output.probes` retained an older exit code 1. Acceptance rejected that inconsistent evidence. The follow-up also repaired a test mutation that could target an example instead of the actual section. The archived prior passing probe distinguishes stale reported evidence from a still-failing verifier.

This remains a bounded report checker, not general prose verification. The nine cases do not establish rejection of every possible contradictory duplicate in other fields. The two correct surviving reconstructions and the CSV are unchanged.

## Music documentation repair

Run `b2f5a494-f16a-485b-a003-b973512a8caf`, 324.168 seconds, nine calls, $0.1864. Published revision `fac0f44530055739bcfb1105922c93a1cae9436f`.

The final note is now C5 (MIDI 72); middle C is correctly C4 (MIDI 60), and the bass C is C3 (MIDI 48). MIDI SHA-256 remains `b725ccea04eb9df40daf44a09db56a8769427518ecce499341be79a870d279cd`. CSV, generator and verifier hashes are unchanged. The independent binary parser confirms format 1, three tracks ending at tick 15360, 32 melody notes, eight bass notes and exact CSV agreement. All five downloaded files match the new manifest. No interpreter cache is in that manifest; this does not claim deletion of a historical cache blob from the repository.

Three edit_file calls succeeded without the earlier encoding failures. This is positive live evidence, not a statistical claim that every future edit will succeed.

## Constrained poetry and a new tissue

Run `a0962013-9f21-4059-8b4f-2ce79ec3edc6`, 326.365 seconds, 23 calls, $0.2402. The platform author created Mesophyll with `sub:openai:gpt-5.6-sol`; its reusable method contains no lighthouse-specific task values. The delivery is text, with zero files and zero tool invocations.

Independent tokenization confirms four stanzas of four lines, sixteen six-word lines, the acrostic LIGHTHOUSEKEEPER, terminal words thaw/sun/leaves/snow, and no prohibited token forms. The poem moves from renewal through forgiveness and remembrance to winter acceptance. The final audit does not duplicate the poem.

Efficiency remains imperfect: five phases and 23 calls for sixteen lines. The initial constraint-modeling phase delegated a complete-poem task to its L1, despite the L3 requesting only a checklist. The scoped reasoning prompt was present and correctly scoped at L1; the L2 had already broadened the delegated task. A later independent audit caught the seven-word second line and correction removed one word. This narrows the remaining scope-leak location to planning/delegation, rather than proving the earlier execution-context change ineffective everywhere.

## Offline protocol model checking

Run `a17fbf5d-8137-444c-9b3c-cf33d34b69a9`, 658.746 seconds, 15 calls, $0.2705. Cambium was reused. Published revision `2d5bc31b895a45195adb72a1ff96045a726ad11e` in `mgtf/atoma-protocol-state-audit-20261003`.

The oracle was computed and archived before launch. The independent comparison verifies every state and labeled transition, not just totals: correct 20 states/34 edges/no deadlocks; buggy 20 states/32 edges/two deadlocks. Both satisfy mutual exclusion. The published four-step buggy counterexample replays against the independent relation, and no shallower layer contains a deadlock. All three downloaded hashes match the manifest. The published self-check also passes locally. The report explicitly declines to infer fairness or starvation-freedom from these checks.

The script's own recomputation shares its transition implementation with generation; it is not an independently implemented oracle. The preregistered external graph comparison supplies that separate check. Live multiline edit spans succeeded without the former encoding errors.

## Scope of the findings

Five serial runs completed: two ledger repairs, one MIDI documentation repair, one new text-only poetry project and one new offline protocol project. Their total recorded duration is 3282.188 seconds (54.7 minutes), 74 LLM calls and $1.4438 subscription accounting. Wall time also includes analysis, fixes, CI and deployment. These are exploratory cases, not a controlled benchmark.

The initial platform defects have two deployed corrective commits. The observed poetry planning/delegation overreach remains an efficiency issue to address; a correct final result is not evidence that orchestration is optimal. No claim is made that the bounded ledger checker recognizes arbitrary prose contradictions. Unrelated concurrent source and staged changes were preserved.
